import { isTerminalPayment, type Payment } from './payment';

export type PaymentPollingStop = 'terminal' | 'review' | 'limit' | 'error';

export function paymentPollingStop(payment: Payment): 'terminal' | 'review' | null {
	if (isTerminalPayment(payment)) return 'terminal';
	return payment.needsReview ? 'review' : null;
}

interface PaymentPollingOptions {
	load: (signal: AbortSignal) => Promise<Payment>;
	onPayment: (payment: Payment) => void;
	onStop: (reason: PaymentPollingStop, error?: unknown) => void;
	intervalMs?: number;
	maxAttempts?: number;
	maxDurationMs?: number;
}

export function startPaymentPolling({
	load,
	onPayment,
	onStop,
	intervalMs = 2_000,
	maxAttempts = 60,
	maxDurationMs = 120_000,
}: PaymentPollingOptions): () => void {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempts = 0;
	const cancel = () => {
		clearTimeout(timer);
		clearTimeout(deadline);
		controller.abort();
	};
	const stop = (reason: PaymentPollingStop, error?: unknown) => {
		if (controller.signal.aborted) return;
		cancel();
		onStop(reason, error);
	};
	const deadline = setTimeout(() => stop('limit'), maxDurationMs);
	const poll = async () => {
		try {
			attempts += 1;
			const payment = await load(controller.signal);
			if (controller.signal.aborted) return;
			onPayment(payment);
			const reason = paymentPollingStop(payment);
			if (reason) return stop(reason);
			if (attempts >= maxAttempts) return stop('limit');
			timer = setTimeout(() => void poll(), intervalMs);
		} catch (error) {
			stop('error', error);
		}
	};
	void poll();
	return cancel;
}
