import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../shared/api';
import { createPayment, listPayments } from '../api/payments';
import {
	PAYMENT_HISTORY_LIMIT,
	canStartAnotherPayment,
	confirmationLink,
	mergePaymentSnapshot,
	paymentAmount,
	paymentProviderLabel,
	paymentStatusLabel,
	type Payment,
} from '../model/payment';
import {
	readPaymentAttempt,
	savePaymentAttempt,
	type PaymentAttempt,
} from '../model/payment-attempt';
import { usePaymentCapabilities } from '../model/use-payment-capabilities';
import { PaymentDetails } from './PaymentDetails';
import { PaymentAvailability } from './PaymentAvailability';

interface Props {
	workspaceId: string;
	userId: string;
}

interface PaymentHistory {
	rows: Payment[] | null;
	loading: boolean;
	error: string;
}

function historyErrorMessage(failure: unknown): string {
	if (failure instanceof ApiError && failure.status === 403) {
		return 'Платежи доступны только владельцу workspace.';
	}
	return failure instanceof Error ? failure.message : 'Не удалось загрузить историю платежей';
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
	const [history, setHistory] = useState<PaymentHistory>({ rows: null, loading: true, error: '' });
	const [error, setError] = useState('');
	const [sending, setSending] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const createController = useRef<AbortController | null>(null);
	const { value: capabilities, failed: capabilityFailed } = usePaymentCapabilities(
		workspaceId,
		refresh,
	);

	useEffect(() => {
		const controller = new AbortController();
		void listPayments(workspaceId, controller.signal).then(
			(rows) => {
				if (!controller.signal.aborted) {
					setHistory({ rows, loading: false, error: '' });
				}
			},
			(failure: unknown) => {
				if (!controller.signal.aborted) {
					setHistory({ rows: null, loading: false, error: historyErrorMessage(failure) });
				}
			},
		);
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
			if (previous.rows === null) return previous;
			const existing = previous.rows.find((row) => row.id === payment.id) ?? null;
			const next = mergePaymentSnapshot(existing, payment);
			if (next === existing) return previous;
			const rows = [next, ...previous.rows.filter((row) => row.id !== payment.id)]
				.sort(
					(left, right) =>
						right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
				)
				.slice(0, PAYMENT_HISTORY_LIMIT);
			return { ...previous, rows };
		});
	}, []);

	const canStartNew =
		!attempt ||
		(current?.id === attempt.paymentId && canStartAnotherPayment(current, capabilities));
	const canSubmitAttempt = canStartNew || !attempt?.paymentId;
	const canSubmit =
		history.rows !== null &&
		capabilities?.enabled === true &&
		!history.loading &&
		!sending &&
		!initialAttempt.error &&
		canSubmitAttempt;
	const price = capabilities ? paymentAmount(capabilities) : null;
	const providerName = capabilities ? paymentProviderLabel(capabilities.provider) : null;
	let submitLabel = 'Повторить запрос этой попытки';
	if (sending) submitLabel = 'Отправляем запрос…';
	else if (!attempt) submitLabel = price ? `Тестовая оплата — ${price}` : 'Тестовая оплата';
	else if (canStartNew) {
		submitLabel = providerName
			? `Новая тестовая оплата в ${providerName} — ${price}`
			: 'Новая тестовая оплата';
	}

	const refreshHistory = () => {
		setHistory((previous) => ({ ...previous, loading: true, error: '' }));
		setRefresh((value) => value + 1);
	};

	const submit = async () => {
		if (!canSubmit || createController.current) return;
		const controller = new AbortController();
		createController.current = controller;
		setSending(true);
		setError('');
		try {
			const selectedAttempt = canStartNew ? { key: crypto.randomUUID(), paymentId: null } : attempt;
			if (!selectedAttempt) return;
			savePaymentAttempt(localStorage, userId, workspaceId, selectedAttempt);
			setCurrent(null);
			setAttempt(selectedAttempt);
			const response = await createPayment(workspaceId, selectedAttempt.key, controller.signal);
			if (controller.signal.aborted) return;
			const savedAttempt = { key: selectedAttempt.key, paymentId: response.data.id };
			savePaymentAttempt(localStorage, userId, workspaceId, savedAttempt);
			setAttempt(savedAttempt);
			acceptPayment(response.data);
			const checkoutUrl = confirmationLink(response.data, capabilities);
			if (response.status !== 202 && checkoutUrl) window.location.assign(checkoutUrl);
		} catch (failure) {
			if (!controller.signal.aborted) {
				setError(failure instanceof Error ? failure.message : 'Не удалось создать платёж');
			}
		} finally {
			if (createController.current === controller) createController.current = null;
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
					disabled={history.loading || sending}
					onClick={refreshHistory}
				>
					Обновить историю
				</button>
			</div>
			<div className="payment-purchase">
				<strong className="payment-price">{price ?? '—'}</strong>
				<div>
					<p>Демонстрационная покупка workspace</p>
					<p className="muted">
						{providerName
							? `Оплата откроется на странице ${providerName}. Используйте только тестовую карту.`
							: 'Проверяем условия тестовой оплаты.'}
					</p>
				</div>
			</div>
			{history.loading && <p>Загрузка истории…</p>}
			{history.error && (
				<p className="error" role="alert">
					{history.error}
				</p>
			)}
			{history.rows !== null && (
				<>
					<PaymentAvailability enabled={capabilities?.enabled ?? null} failed={capabilityFailed} />
					{initialAttempt.error && (
						<p className="error" role="alert">
							{initialAttempt.error}
						</p>
					)}
					{canSubmitAttempt && (
						<button type="button" disabled={!canSubmit} onClick={() => void submit()}>
							{submitLabel}
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
							initialPayment={current?.id === attempt.paymentId ? current : null}
							onPayment={acceptPayment}
							capabilities={capabilities}
						/>
					)}
					<h3>История платежей workspace</h3>
					{history.rows.length === 0 && <p className="muted">Платежей пока нет.</p>}
					<ul className="payment-history">
						{history.rows.map((payment) => (
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
