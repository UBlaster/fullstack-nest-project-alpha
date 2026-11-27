import { meter, secondsHistogram } from '../observability/telemetry';

const duration = meter.createHistogram('export.duration', secondsHistogram);

// Record once, after a successful terminal CAS, including time in the outbox and queue.
export function recordFinishedExport(
	createdAt: Date,
	result: 'completed' | 'cancelled' | 'failed',
) {
	duration.record(Math.max(0, Date.now() - createdAt.getTime()) / 1000, { result });
}
