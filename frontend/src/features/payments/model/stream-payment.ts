import { ApiError } from '../../../shared/api';
import type { Payment } from './payment';
import { paymentPollingStop, type PaymentPollingStop } from './poll-payment';

interface PaymentEventsOptions {
	open: (signal: AbortSignal) => Promise<Response>;
	onPayment: (payment: Payment) => void;
	onStop: (reason: PaymentPollingStop, error?: unknown) => void;
	retryDelayMs?: number;
	maxReconnects?: number;
	maxDurationMs?: number;
}

async function readPaymentEvents(
	response: Response,
	signal: AbortSignal,
	onPayment: (payment: Payment) => void,
) {
	if (
		!response.body ||
		response.headers.get('Content-Type')?.split(';')[0] !== 'text/event-stream'
	) {
		throw new Error('Не удалось открыть поток состояния платежа');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let event = '';
	let data: string[] = [];
	let reason: 'terminal' | 'review' | null = null;
	const cancelReader = () => void reader.cancel().catch(() => {});
	signal.addEventListener('abort', cancelReader, { once: true });
	try {
		while (!signal.aborted) {
			const chunk = await reader.read();
			if (signal.aborted) return null;
			buffer += decoder.decode(chunk.value, { stream: !chunk.done });
			let lineEnd: number;
			while ((lineEnd = buffer.search(/[\r\n]/)) !== -1) {
				if (buffer[lineEnd] === '\r' && lineEnd === buffer.length - 1 && !chunk.done) break;
				const line = buffer.slice(0, lineEnd);
				buffer = buffer.slice(lineEnd + (buffer.slice(lineEnd, lineEnd + 2) === '\r\n' ? 2 : 1));
				if (line === '') {
					if (data.length && event === 'payment') {
						const payment = JSON.parse(data.join('\n')) as Payment;
						onPayment(payment);
						reason = paymentPollingStop(payment);
					} else if (event === 'payment-error') {
						const failure = JSON.parse(data.join('\n')) as { statusCode: number };
						throw new ApiError('Не удалось получить состояние платежа', failure.statusCode);
					} else if (event === 'error') {
						throw new Error('Поток состояния платежа прерван');
					}
					event = '';
					data = [];
					if (reason || signal.aborted) return reason;
				} else if (!line.startsWith(':')) {
					const colon = line.indexOf(':');
					const field = colon === -1 ? line : line.slice(0, colon);
					const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
					if (field === 'event') event = value;
					if (field === 'data') data.push(value);
				}
			}
			if (buffer.length + data.join('\n').length > 65_536) {
				throw new Error('Некорректное событие состояния платежа');
			}
			if (chunk.done) throw new Error('Поток состояния платежа прерван');
		}
		return null;
	} finally {
		signal.removeEventListener('abort', cancelReader);
		cancelReader();
		reader.releaseLock();
	}
}

export function startPaymentEvents({
	open,
	onPayment,
	onStop,
	retryDelayMs = 1_000,
	maxReconnects = 2,
	maxDurationMs = 300_000,
}: PaymentEventsOptions): () => void {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reconnects = 0;
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
	const connect = async () => {
		try {
			const response = await open(controller.signal);
			if (controller.signal.aborted) {
				void response.body?.cancel().catch(() => {});
				return;
			}
			const reason = await readPaymentEvents(response, controller.signal, onPayment);
			if (reason) stop(reason);
		} catch (error) {
			if (controller.signal.aborted) return;
			if (
				(error instanceof ApiError && error.status >= 400 && error.status < 500) ||
				reconnects >= maxReconnects
			) {
				stop('error', error);
			} else {
				reconnects += 1;
				timer = setTimeout(() => void connect(), retryDelayMs * reconnects);
			}
		}
	};
	void connect();
	return cancel;
}
