import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../shared/api';
import { createPayment, getPaymentCapabilities, listPayments } from '../api/payments';
import {
	confirmationLink,
	isTerminalPayment,
	mergePaymentSnapshot,
	paymentAmount,
	paymentStatusLabel,
	type Payment,
} from '../model/payment';
import {
	readPaymentAttempt,
	savePaymentAttempt,
	type PaymentAttempt,
} from '../model/payment-attempt';
import { PaymentDetails } from './PaymentDetails';
import { PaymentAvailability } from './PaymentAvailability';

interface Props {
	workspaceId: string;
	userId: string;
}

export function PaymentsSection({ workspaceId, userId }: Props) {
	const [initialAttempt] = useState(() => {
		try {
			return { attempt: readPaymentAttempt(localStorage, userId, workspaceId), error: '' };
		} catch {
			return {
				attempt: null,
				error: 'Не удалось восстановить попытку оплаты из браузера. Проверьте историю платежей.',
			};
		}
	});
	const [attempt, setAttempt] = useState<PaymentAttempt | null>(initialAttempt.attempt);
	const [current, setCurrent] = useState<Payment | null>(null);
	const [history, setHistory] = useState<Payment[]>([]);
	const [historyError, setHistoryError] = useState('');
	const [error, setError] = useState('');
	const [allowed, setAllowed] = useState(false);
	const [loading, setLoading] = useState(true);
	const [providerEnabled, setProviderEnabled] = useState<boolean | null>(null);
	const [capabilityFailed, setCapabilityFailed] = useState(false);
	const [sending, setSending] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const createController = useRef<AbortController | null>(null);
	const sendingRef = useRef(false);

	useEffect(() => {
		const controller = new AbortController();
		void listPayments(workspaceId, controller.signal)
			.then((payments) => {
				if (controller.signal.aborted) return;
				setHistory(payments);
				setAllowed(true);
			})
			.catch((failure: unknown) => {
				if (controller.signal.aborted) return;
				setAllowed(false);
				setHistoryError(
					failure instanceof ApiError && failure.status === 403
						? 'Платежи доступны только владельцу workspace.'
						: failure instanceof Error
							? failure.message
							: 'Не удалось загрузить историю платежей',
				);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		void getPaymentCapabilities(workspaceId, controller.signal)
			.then((capabilities) => {
				if (!controller.signal.aborted) {
					setProviderEnabled(capabilities.enabled);
					setCapabilityFailed(false);
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) {
					setProviderEnabled(null);
					setCapabilityFailed(true);
				}
			});
		return () => controller.abort();
	}, [workspaceId, refresh]);

	useEffect(
		() => () => {
			createController.current?.abort();
		},
		[],
	);

	const acceptPayment = useCallback((payment: Payment) => {
		setCurrent((previous) => mergePaymentSnapshot(previous, payment));
		setHistory((previous) => {
			const next = mergePaymentSnapshot(
				previous.find((row) => row.id === payment.id) ?? null,
				payment,
			);
			return [next, ...previous.filter((row) => row.id !== payment.id)]
				.sort(
					(left, right) =>
						right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
				)
				.slice(0, 20);
		});
	}, []);

	const canStartNew =
		!attempt ||
		(current?.id === attempt.paymentId && isTerminalPayment(current) && !current.needsReview);
	const canSubmit =
		allowed &&
		providerEnabled === true &&
		!loading &&
		!sending &&
		!initialAttempt.error &&
		(canStartNew || !attempt?.paymentId);

	const submit = async () => {
		if (!canSubmit || sendingRef.current) return;
		sendingRef.current = true;
		setSending(true);
		setError('');
		const controller = new AbortController();
		createController.current = controller;
		try {
			const selectedAttempt = canStartNew ? { key: crypto.randomUUID(), paymentId: null } : attempt;
			if (!selectedAttempt) return;
			// Записываем ключ до HTTP: потерянный ответ и reload сохраняют ту же покупку.
			savePaymentAttempt(localStorage, userId, workspaceId, selectedAttempt);
			setAttempt(selectedAttempt);
			const response = await createPayment(workspaceId, selectedAttempt.key, controller.signal);
			if (controller.signal.aborted) return;
			const savedAttempt = { key: selectedAttempt.key, paymentId: response.data.id };
			savePaymentAttempt(localStorage, userId, workspaceId, savedAttempt);
			setAttempt(savedAttempt);
			acceptPayment(response.data);
			const checkoutUrl = confirmationLink(response.data);
			if (response.status !== 202 && checkoutUrl) window.location.assign(checkoutUrl);
		} catch (failure) {
			if (!controller.signal.aborted) {
				setError(failure instanceof Error ? failure.message : 'Не удалось создать платёж');
			}
		} finally {
			sendingRef.current = false;
			if (!controller.signal.aborted) setSending(false);
		}
	};

	return (
		<section className="card payments-section">
			<div className="section-heading">
				<h2>Тестовые платежи</h2>
				<button
					className="button-secondary"
					type="button"
					disabled={loading}
					onClick={() => {
						setLoading(true);
						setHistoryError('');
						setProviderEnabled(null);
						setCapabilityFailed(false);
						setRefresh((value) => value + 1);
					}}
				>
					Обновить историю
				</button>
			</div>
			<div className="payment-purchase">
				<strong className="payment-price">100 ₽</strong>
				<div>
					<p>Демонстрационная покупка workspace</p>
					<p className="muted">
						Оплата откроется на странице ЮKassa. Используйте только тестовую карту.
					</p>
				</div>
			</div>
			{loading && <p>Загрузка истории…</p>}
			{historyError && (
				<p className="error" role="alert">
					{historyError}
				</p>
			)}
			{allowed && (
				<>
					<PaymentAvailability enabled={providerEnabled} failed={capabilityFailed} />
					{initialAttempt.error && (
						<p className="error" role="alert">
							{initialAttempt.error}
						</p>
					)}
					{(canStartNew || !attempt?.paymentId) && (
						<button type="button" disabled={!canSubmit} onClick={() => void submit()}>
							{sending
								? 'Отправляем запрос…'
								: !attempt
									? 'Тестовая оплата — 100 ₽'
									: canStartNew
										? 'Новая тестовая оплата — 100 ₽'
										: 'Повторить запрос этой попытки'}
						</button>
					)}
					{attempt && !attempt.paymentId && !sending && (
						<p className="muted">
							Если ответ потерялся, повторите запрос этой попытки. Её ключ сохранён в браузере.
						</p>
					)}
					{error && (
						<p className="error" role="alert">
							{error}
						</p>
					)}
					{attempt?.paymentId && (
						<PaymentDetails
							key={attempt.paymentId}
							id={attempt.paymentId}
							onPayment={acceptPayment}
							providerEnabled={providerEnabled}
						/>
					)}
					<h3>История платежей workspace</h3>
					{history.length === 0 && <p className="muted">Платежей пока нет.</p>}
					<ul className="payment-history">
						{history.map((payment) => (
							<li key={payment.id}>
								<div className="payment-history-summary">
									<strong>{paymentAmount(payment)}</strong>
									<span>{paymentStatusLabel(payment)}</span>
									<time dateTime={payment.createdAt}>
										{new Date(payment.createdAt).toLocaleString('ru-RU')}
									</time>
								</div>
								<Link
									className="button-link button-secondary"
									to={`/payments/${payment.id}/result`}
								>
									Подробнее
								</Link>
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}
