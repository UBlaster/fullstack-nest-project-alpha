// Дедлайн охватывает все ресурсы, включая хуки уничтожения Nest. При жёстком
// истечении времени брокер завершает "застрявшую" доставку, а база восстанавливает lease для задачи.
export async function shutdownWorker(
	runtime: { close(): Promise<void> },
	app: { close(): Promise<void> },
	onTimeout: () => void = () => {
		console.error('Worker shutdown timed out');
		process.exit(1);
	},
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = setTimeout(onTimeout, timeoutMs);
	deadline.unref();
	try {
		try {
			await runtime.close();
		} finally {
			await app.close();
		}
	} finally {
		clearTimeout(deadline);
	}
}
