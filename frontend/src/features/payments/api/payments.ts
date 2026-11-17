import { apiWithStatus } from '../../../shared/api';
import type { Payment } from '../model/payment';

export interface PaymentCapabilities {
	enabled: boolean;
}

export const getPaymentCapabilities = (workspaceId: string, signal?: AbortSignal) =>
	apiWithStatus<PaymentCapabilities>(
		`/workspaces/${encodeURIComponent(workspaceId)}/payments/capabilities`,
		{ signal },
	).then((result) => ({ enabled: result.data.enabled === true }));

export const listPayments = (workspaceId: string, signal?: AbortSignal) =>
	apiWithStatus<Payment[]>(`/workspaces/${encodeURIComponent(workspaceId)}/payments?limit=20`, {
		signal,
	}).then((result) => result.data);

export const getPayment = (id: string, signal?: AbortSignal) =>
	apiWithStatus<Payment>(`/payments/${encodeURIComponent(id)}`, { signal }).then(
		(result) => result.data,
	);

export const createPayment = (workspaceId: string, key: string, signal?: AbortSignal) =>
	apiWithStatus<Payment>(`/workspaces/${encodeURIComponent(workspaceId)}/payments`, {
		method: 'POST',
		headers: { 'Idempotency-Key': key },
		body: JSON.stringify({ purpose: 'WORKSPACE_DEMO' }),
		signal,
	});

export const reconcilePayment = (id: string, signal?: AbortSignal) =>
	apiWithStatus<Payment>(`/payments/${encodeURIComponent(id)}/reconcile`, {
		method: 'POST',
		signal,
	}).then((result) => result.data);
