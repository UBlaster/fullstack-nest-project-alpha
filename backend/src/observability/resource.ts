// Share the same identity in JSON logs and OTLP, including direct node/ts-node starts.
const startsWorker = /[/\\]worker[/\\]worker(?:\.[jt]s)?$/.test(process.argv[1] ?? '');
export const serviceName =
	process.env.OTEL_SERVICE_NAME ?? (startsWorker ? 'workspace-worker' : 'workspace-api');
export const environmentName = process.env.NODE_ENV ?? 'development';
