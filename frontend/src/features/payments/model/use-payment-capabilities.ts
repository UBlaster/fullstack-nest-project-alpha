import { useEffect, useState } from 'react';
import { getPaymentCapabilities } from '../api/payments';
import type { PaymentCapabilities } from './payment';

interface CapabilityResult {
	workspaceId: string;
	revision: number;
	value: PaymentCapabilities | null;
	failed: boolean;
}

export function usePaymentCapabilities(workspaceId: string | undefined, revision: number) {
	const [result, setResult] = useState<CapabilityResult | null>(null);

	useEffect(() => {
		if (!workspaceId) return;
		const controller = new AbortController();
		void getPaymentCapabilities(workspaceId, controller.signal).then(
			(value) => {
				if (!controller.signal.aborted) setResult({ workspaceId, revision, value, failed: false });
			},
			() => {
				if (!controller.signal.aborted) {
					setResult({ workspaceId, revision, value: null, failed: true });
				}
			},
		);
		return () => controller.abort();
	}, [workspaceId, revision]);

	return result?.workspaceId === workspaceId && result?.revision === revision
		? result
		: { value: null, failed: false };
}
