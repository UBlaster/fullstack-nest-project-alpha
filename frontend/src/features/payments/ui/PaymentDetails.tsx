import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../../shared/api';
import { getPayment, getPaymentEvents, reconcilePayment } from '../api/payments';
import {
	canReconcilePayment,
	canUsePaymentProvider,
	confirmationLink,
	mergePaymentSnapshot,
	paymentAmount,
	paymentProviderLabel,
	paymentStatusLabel,
	type Payment,
	type PaymentCapabilities,
} from '../model/payment';
import { paymentPollingStop } from '../model/poll-payment';
import { startPaymentEvents } from '../model/stream-payment';
import { usePaymentCapabilities } from '../model/use-payment-capabilities';
import { PaymentAvailability } from './PaymentAvailability';

interface Props {
	id: string;
	initialPayment?: Payment | null;
	onPayment?: (payment: Payment) => void;
	capabilities?: PaymentCapabilities | null;
}

export function PaymentDetails(props: Props) {
	return <PaymentDetailsContent key={props.id} {...props} />;
}

function PaymentDetailsContent({ id, initialPayment = null, onPayment, capabilities }: Props) {
	const location = useLocation();
	const [payment, setPayment] = useState(initialPayment);
	const [error, setError] = useState<unknown>(null);
	const [updatesPaused, setUpdatesPaused] = useState(false);
	const [streamRequest, setStreamRequest] = useState<{ id: string } | null>({ id });
	const [capabilityRevision, setCapabilityRevision] = useState(0);
	const [requesting, setRequesting] = useState<'refresh' | 'reconcile' | null>(null);
	const cancelStream = useRef<(() => void) | null>(null);
	const requestController = useRef<AbortController | null>(null);
	const ownCapabilities = usePaymentCapabilities(
		capabilities === undefined ? payment?.workspaceId : undefined,
		capabilityRevision,
	);
	const activeCapabilities = capabilities === undefined ? ownCapabilities.value : capabilities;
	const readOnly =
		payment && activeCapabilities && payment.provider !== activeCapabilities.provider;
	const canUseProvider = payment ? canUsePaymentProvider(payment, activeCapabilities) : false;
	const checkoutUrl = payment ? confirmationLink(payment, activeCapabilities) : null;

	const acceptPayment = useCallback((next: Payment) => {
		setPayment((previous) => mergePaymentSnapshot(previous, next));
	}, []);

	useEffect(() => {
		if (!streamRequest) return;
		const cancel = startPaymentEvents({
			open: (signal) => getPaymentEvents(streamRequest.id, signal),
			onPayment: acceptPayment,
			onStop: (reason, failure) => {
				if (reason === 'limit' || reason === 'error') setUpdatesPaused(true);
				if (reason === 'error') setError(failure);
			},
		});
		cancelStream.current = cancel;
		return cancel;
	}, [streamRequest, acceptPayment]);

	useEffect(() => {
		if (payment) onPayment?.(payment);
	}, [payment, onPayment]);

	useEffect(
		() => () => {
			requestController.current?.abort();
		},
		[],
	);

	const requestStatus = async (kind: 'refresh' | 'reconcile') => {
		if (requestController.current || (kind === 'reconcile' && !canUseProvider)) return;
		const controller = new AbortController();
		requestController.current = controller;
		cancelStream.current?.();
		setStreamRequest(null);
		setError(null);
		setUpdatesPaused(false);
		setRequesting(kind);
		setCapabilityRevision((value) => value + 1);
		try {
			const next = await (kind === 'refresh' ? getPayment : reconcilePayment)(
				id,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			acceptPayment(next);
			if (!paymentPollingStop(next)) setStreamRequest({ id });
		} catch (failure) {
			if (!controller.signal.aborted) {
				setError(failure);
				setUpdatesPaused(true);
			}
		} finally {
			if (!controller.signal.aborted) setRequesting(null);
			if (requestController.current === controller) requestController.current = null;
		}
	};

	return (
		<div className="payment-details" aria-live="polite">
			{!payment && !error && <p>Получаем состояние платежа…</p>}
			{payment && (
				<>
					<h3>{paymentStatusLabel(payment)}</h3>
					<p>{paymentAmount(payment)} · Тестовая покупка workspace</p>
					<small className="muted">Платёж: {payment.id}</small>
					<p className="muted">Платёжный сервис: {paymentProviderLabel(payment.provider)}</p>
					{readOnly && <p className="muted">Этот платёж доступен только для просмотра.</p>}
					{payment.needsReview && (
						<p>Результат требует ручной проверки в тестовом магазине. Не повторяйте покупку.</p>
					)}
					{checkoutUrl && (
						<p>
							<a className="button-link" href={checkoutUrl} rel="noopener noreferrer">
								Продолжить тестовую оплату в {paymentProviderLabel(payment.provider)}
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
			{updatesPaused && (
				<p className="muted">Автообновление приостановлено. Результат можно обновить вручную.</p>
			)}
			{payment && capabilities === undefined && !readOnly && (
				<PaymentAvailability
					enabled={activeCapabilities?.enabled ?? null}
					failed={ownCapabilities.failed}
				/>
			)}
			<div className="payment-actions">
				<button
					className="button-secondary"
					type="button"
					disabled={requesting !== null}
					onClick={() => void requestStatus('refresh')}
				>
					{requesting === 'refresh' ? 'Обновляем…' : 'Обновить статус'}
				</button>
				{payment && !readOnly && canReconcilePayment(payment) && (
					<button
						className="button-secondary"
						type="button"
						disabled={requesting !== null || !canUseProvider}
						onClick={() => void requestStatus('reconcile')}
					>
						{requesting === 'reconcile'
							? 'Сверяем…'
							: `Сверить ${payment.provider === 'stripe' ? 'со' : 'с'} ${paymentProviderLabel(payment.provider)}`}
					</button>
				)}
			</div>
		</div>
	);
}
