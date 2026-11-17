import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../../shared/api';
import { getPayment, getPaymentCapabilities, reconcilePayment } from '../api/payments';
import {
	canReconcilePayment,
	confirmationLink,
	mergePaymentSnapshot,
	paymentAmount,
	paymentStatusLabel,
	type Payment,
} from '../model/payment';
import { startPaymentPolling, type PaymentPollingStop } from '../model/poll-payment';
import { PaymentAvailability } from './PaymentAvailability';

interface Props {
	id: string;
	onPayment?: (payment: Payment) => void;
	providerEnabled?: boolean | null;
}

export function PaymentDetails({ id, onPayment, providerEnabled }: Props) {
	const location = useLocation();
	const [state, setState] = useState<{ id: string; payment: Payment | null }>({
		id,
		payment: null,
	});
	const [error, setError] = useState<unknown>(null);
	const [stopReason, setStopReason] = useState<PaymentPollingStop | null>(null);
	const [refresh, setRefresh] = useState(0);
	const [reconciling, setReconciling] = useState(false);
	const reconcileController = useRef<AbortController | null>(null);
	const [capability, setCapability] = useState<{
		workspaceId: string;
		enabled: boolean | null;
		failed: boolean;
	} | null>(null);
	const payment = state.id === id ? state.payment : null;
	const workspaceId = payment?.workspaceId;
	const ownCapability = capability?.workspaceId === workspaceId ? capability : null;
	const enabled =
		providerEnabled !== undefined ? providerEnabled : (ownCapability?.enabled ?? null);
	const checkoutUrl = payment && enabled === true ? confirmationLink(payment) : null;

	useEffect(() => {
		if (providerEnabled !== undefined || !workspaceId) return;
		const controller = new AbortController();
		void getPaymentCapabilities(workspaceId, controller.signal)
			.then((result) => {
				if (!controller.signal.aborted) {
					setCapability({ workspaceId, enabled: result.enabled, failed: false });
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) {
					setCapability({ workspaceId, enabled: null, failed: true });
				}
			});
		return () => controller.abort();
	}, [providerEnabled, workspaceId, refresh]);

	useEffect(() => {
		return startPaymentPolling({
			load: (signal) => getPayment(id, signal),
			onPayment: (next) =>
				setState((previous) => ({
					id,
					payment: mergePaymentSnapshot(previous.id === id ? previous.payment : null, next),
				})),
			onStop: (reason, failure) => {
				setStopReason(reason);
				if (reason === 'error') setError(failure);
			},
		});
	}, [id, refresh]);

	useEffect(() => {
		if (payment) onPayment?.(payment);
	}, [payment, onPayment]);

	useEffect(
		() => () => {
			reconcileController.current?.abort();
		},
		[id],
	);

	return (
		<div className="payment-details" aria-live="polite">
			{!payment && !error && <p>Получаем состояние платежа…</p>}
			{payment && (
				<>
					<h3>{paymentStatusLabel(payment)}</h3>
					<p>{paymentAmount(payment)} · Тестовая покупка workspace</p>
					<small className="muted">Платёж: {payment.id}</small>
					{payment.needsReview && (
						<p>Результат требует ручной проверки в тестовом магазине. Не повторяйте покупку.</p>
					)}
					{checkoutUrl && (
						<p>
							<a className="button-link" href={checkoutUrl} rel="noopener noreferrer">
								Продолжить тестовую оплату в ЮKassa
							</a>
						</p>
					)}
					{payment.lastErrorCode && <p className="muted">Код: {payment.lastErrorCode}</p>}
				</>
			)}
			{error !== null && (
				<p className="error" role="alert">
					{error instanceof Error ? error.message : 'Не удалось получить состояние платежа'}
				</p>
			)}
			{error instanceof ApiError && error.status === 401 && (
				<Link
					className="button-link"
					to={`/login?returnTo=${encodeURIComponent(location.pathname)}`}
				>
					Войти, чтобы узнать результат
				</Link>
			)}
			{stopReason === 'limit' && (
				<p className="muted">Автообновление приостановлено. Результат можно обновить вручную.</p>
			)}
			{payment && providerEnabled === undefined && (
				<PaymentAvailability enabled={enabled} failed={ownCapability?.failed} />
			)}
			<div className="payment-actions">
				<button
					className="button-secondary"
					type="button"
					disabled={reconciling}
					onClick={() => {
						setError(null);
						setStopReason(null);
						if (providerEnabled === undefined) setCapability(null);
						setRefresh((value) => value + 1);
					}}
				>
					Обновить статус
				</button>
				{payment && canReconcilePayment(payment) && (
					<button
						className="button-secondary"
						type="button"
						disabled={reconciling || enabled !== true}
						onClick={async () => {
							if (enabled !== true) return;
							if (reconcileController.current && !reconcileController.current.signal.aborted)
								return;
							const controller = new AbortController();
							reconcileController.current = controller;
							setReconciling(true);
							setError(null);
							try {
								const next = await reconcilePayment(id, controller.signal);
								if (controller.signal.aborted) return;
								setState((previous) => ({
									id,
									payment: mergePaymentSnapshot(previous.id === id ? previous.payment : null, next),
								}));
								setRefresh((value) => value + 1);
							} catch (failure) {
								if (!controller.signal.aborted) setError(failure);
							} finally {
								if (!controller.signal.aborted) setReconciling(false);
								if (reconcileController.current === controller) reconcileController.current = null;
							}
						}}
					>
						{reconciling ? 'Сверяем…' : 'Сверить с ЮKassa'}
					</button>
				)}
			</div>
		</div>
	);
}
