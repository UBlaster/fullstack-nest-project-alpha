import { apiWithStatus, authenticatedFetch } from '../../../shared/api';
import { PAYMENT_HISTORY_LIMIT, parsePaymentCapabilities, type Payment } from '../model/payment';

const workspacePaymentsPath = (workspaceId: string) =>
	`/workspaces/${encodeURIComponent(workspaceId)}/payments`;
const paymentPath = (id: string) => `/payments/${encodeURIComponent(id)}`;

export const getPaymentCapabilities = (workspaceId: string, signal?: AbortSignal) =>
	apiWithStatus<unknown>(`${workspacePaymentsPath(workspaceId)}/capabilities`, {
		signal,
	}).then((result) => parsePaymentCapabilities(result.data));

export const listPayments = (workspaceId: string, signal?: AbortSignal) =>
	apiWithStatus<Payment[]>(`${workspacePaymentsPath(workspaceId)}?limit=${PAYMENT_HISTORY_LIMIT}`, {
		signal,
	}).then((result) => result.data);

export const getPayment = (id: string, signal?: AbortSignal) =>
	apiWithStatus<Payment>(paymentPath(id), { signal }).then((result) => result.data);

export const getPaymentEvents = (id: string, signal: AbortSignal) =>
	authenticatedFetch(`${paymentPath(id)}/events`, {
		headers: { Accept: 'text/event-stream' },
		cache: 'no-store',
		signal,
	});

export const createPayment = (workspaceId: string, key: string, signal?: AbortSignal) =>
	apiWithStatus<Payment>(workspacePaymentsPath(workspaceId), {
		method: 'POST',
		headers: { 'Idempotency-Key': key },
		body: JSON.stringify({ purpose: 'WORKSPACE_DEMO' }),
		signal,
	});

export const reconcilePayment = (id: string, signal?: AbortSignal) =>
	apiWithStatus<Payment>(`${paymentPath(id)}/reconcile`, {
		method: 'POST',
		signal,
	}).then((result) => result.data);
