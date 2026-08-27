# Памятка к задаче 6: background jobs, retries и DLQ

> [!tip] В двух словах
> **Долгая работа вне HTTP.** Пользователь быстро получает job ID, а worker выполняет операцию с повторами и восстановлением.

## Контекст учебного примера

Аналитический сервис строит большой `Report`. HTTP API сохраняет `ReportJob`, outbox гарантирует отправку, а отдельный worker формирует файл и кладёт его в object storage.

```mermaid
flowchart LR
	Client --> API
	API --> PostgreSQL
	PostgreSQL --> Outbox
	Outbox --> BullMQ
	BullMQ --> Worker
	Worker --> ObjectStorage
```

## Ключевые термины

- **Producer** создаёт job, **consumer/worker** получает её и выполняет.
- **Broker/queue** хранит и доставляет jobs между API и workers; в BullMQ этим хранилищем служит Redis.
- **Acknowledgement** подтверждает очереди успешное завершение job.
- **Retry** — повтор job после временной ошибки, а **backoff** — задержка перед следующим повтором.
- **At-least-once delivery** означает, что broker может доставить одну job больше одного раза.
- **DLQ** — отдельная очередь для jobs, которые исчерпали разрешённые retries.
- **Transactional outbox** — запись события в PostgreSQL одной транзакцией с business row для последующей отправки в очередь.
- **Claim** — атомарная попытка назначить job одному worker.
- **Heartbeat** — периодическое подтверждение, что worker всё ещё обрабатывает job.
- **Concurrency** — число jobs, которые worker разрешает обрабатывать одновременно.

## Зачем нужна очередь

HTTP connection имеет timeout и может оборваться, хотя работа ещё полезна. Очередь отделяет приём команды от выполнения:

```text
POST export -> persist job -> enqueue -> 202
worker -> claim -> build -> store -> complete
GET status -> current state
```

Очередь распределяет нагрузку между workers и позволяет ограничить concurrency.

> [!note] Аналогия для frontend
>
> - **React:** UI отправляет команду, сохраняет `jobId` и отдельно обновляет статус; React-компонент не выполняет export сам.
> - **Vue:** composable или Pinia store хранит `jobId` и обновляет статус; Vue-компонент также не выполняет export.
> - **Backend:** BullMQ worker — отдельный Node.js process, а не Web Worker внутри browser и не callback текущего HTTP request.

## At-least-once означает дубли

Worker мог закончить работу, но упасть до acknowledgement. Broker отправит сообщение повторно. Поэтому consumer должен быть идемпотентным: stable job ID, unique constraints и проверка terminal status важнее надежды на «ровно один раз».

## Зачем transactional outbox

Между двумя системами нет общей транзакции:

1. DB commit прошёл, enqueue не прошёл — job потеряна.
2. Enqueue прошёл, DB rollback — worker не найдёт job.

Outbox записывает business row и событие одной DB-транзакцией. Dispatcher доставляет ещё не опубликованные события и может безопасно повторяться.

## Retry и DLQ

Retry полезен для временных ошибок: timeout, 503, network reset. Validation error повтором не исправится. Backoff разгружает зависимость:

```text
5s -> 10s -> 20s -> 40s -> failed/DLQ
```

DLQ не мусорка, а очередь для расследования и контролируемого replay. Сообщение должно иметь error code, attempts и correlation ID без secrets.

## Heartbeat, recovery и cancellation

Статус `PROCESSING` сам по себе не доказывает, что worker жив. Heartbeat позволяет requeue зависшую job. Claim выполняют атомарно, иначе два workers начнут одну работу.

Отмена кооперативная: API ставит flag, worker проверяет его между batches и корректно закрывает незавершённый multipart upload.

## Переиспользуемый каркас

API и worker могут использовать один image, но запускаются как разные процессы:

```yaml
services:
  api:
    build: .
    command: npm run start:dev

  report-worker:
    build: .
    command: npm run start:worker:dev
    depends_on:
      redis:
        condition: service_healthy
```

Соединение и очереди создаёт Nest provider, а feature-код получает их через DI:

```ts
function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export const BULL_CONNECTION = Symbol('BULL_CONNECTION');
export const REPORT_QUEUE = Symbol('REPORT_QUEUE');

@Module({
	providers: [
		{
			provide: BULL_CONNECTION,
			useFactory: () =>
				new Redis(requiredEnv('REDIS_URL'), {
					maxRetriesPerRequest: null,
				}),
		},
		{
			provide: REPORT_QUEUE,
			inject: [BULL_CONNECTION],
			useFactory: (connection: Redis) => new Queue('reports', { connection }),
		},
	],
	exports: [BULL_CONNECTION, REPORT_QUEUE],
})
export class QueueModule {}
```

Producer сохраняет domain row и outbox event одной транзакцией:

```ts
await prisma.$transaction(async (tx) => {
	const report = await tx.reportJob.create({ data: { status: 'QUEUED', requestedById } });
	await tx.outboxEvent.create({
		data: { type: 'REPORT_REQUESTED', aggregateId: report.id, payload: { reportId: report.id } },
	});
});
```

Dispatcher публикует с stable broker job ID и только потом помечает outbox:

```ts
await queue.add('build-report', event.payload, {
	jobId: event.aggregateId,
	attempts: 5,
	backoff: { type: 'exponential', delay: 5000 },
});
await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
```

Consumer обязан распознавать duplicate:

```ts
const current = await prisma.reportJob.findUniqueOrThrow({ where: { id: reportId } });
if (current.status === 'COMPLETED') return;

const claim = await prisma.reportJob.updateMany({
	where: { id: reportId, status: 'QUEUED' },
	data: { status: 'PROCESSING', heartbeatAt: new Date() },
});
if (claim.count === 0) return;
```

Если обработка завершилась временной ошибкой, статус нужно вернуть в `QUEUED` **до** повторного выбрасывания ошибки. Иначе BullMQ доставит retry, но новый claim не сможет забрать оставшуюся в `PROCESSING` job:

```ts
try {
	await buildAndStoreReport(reportId);
} catch (error) {
	if (!isRetryable(error)) {
		await markFailed(reportId, error);
		return;
	}

	// BullMQ повторит job только после того, как DB снова разрешит claim.
	await prisma.reportJob.updateMany({
		where: { id: reportId, status: 'PROCESSING' },
		data: { status: 'QUEUED', heartbeatAt: null },
	});
	throw error;
}
```

Отдельный recovery-процесс возвращает в `QUEUED` только давно не обновлявшиеся `PROCESSING` jobs после аварийного завершения worker.

### Отдельный entry point worker

Standalone Nest context создаёт providers без HTTP listener. Сам BullMQ `Worker` подписывается на очередь:

```ts
import { setTimeout } from 'node:timers/promises';

function classifyError(error: Error): string {
	return error.name || 'UnknownError';
}

async function bootstrapWorker() {
	const app = await NestFactory.createApplicationContext(ReportWorkerModule);
	const connection = app.get<Redis>(BULL_CONNECTION);
	const processor = app.get(ReportProcessor);
	const deadQueue = new Queue('reports:dead', { connection });
	const worker = new Worker('reports', (job) => processor.process(job.data.reportId), {
		connection,
		concurrency: 2,
	});

	worker.on('failed', async (job, error) => {
		if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
		const sourceJobId = job.id ?? job.data.reportId;
		await deadQueue.add(
			'build-report-dead',
			{
				reportId: job.data.reportId,
				sourceJobId,
				attempts: job.attemptsMade,
				errorCode: classifyError(error),
			},
			{ jobId: `dead-${sourceJobId}`, removeOnComplete: 1000 },
		);
	});

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await Promise.race([
			worker.close(),
			setTimeout(30_000, undefined, { ref: false }).then(() => {
				throw new Error('Worker shutdown timed out');
			}),
		]);
		await deadQueue.close();
		await app.close();
	};

	const stop = () =>
		void shutdown().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}

void bootstrapWorker();
```

Не кладите исходный файл в `job.data`: payload содержит stable IDs и небольшой контекст. Данные worker дочитывает из PostgreSQL после claim.

### Поток сразу в multipart upload

AWS SDK `Upload` разбивает большой stream на parts и не требует единого `Buffer`:

```ts
async function uploadReport(
	s3: S3Client,
	bucket: string,
	key: string,
	csvStream: Readable,
): Promise<void> {
	const upload = new Upload({
		client: s3,
		params: {
			Bucket: bucket,
			Key: key,
			Body: csvStream,
			ContentType: 'text/csv; charset=utf-8',
		},
		queueSize: 4,
		partSize: 5 * 1024 * 1024,
		leavePartsOnError: false,
	});

	await upload.done();
}
```

При cooperative cancellation stream закрывают, а multipart abort выполняется до перевода domain job в `CANCELLED`. Для аварий процесса полезно lifecycle-правило bucket, удаляющее незавершённые multipart uploads.

## Частые ошибки

- помещать большой файл или JWT в message;
- ack до сохранения результата;
- retry без лимита/backoff;
- два источника статуса: очередь и БД расходятся;
- считать duplicate delivery исключением;
- завершать process без graceful shutdown;
- повторно выдавать download URL, истёкший ещё в очереди.
