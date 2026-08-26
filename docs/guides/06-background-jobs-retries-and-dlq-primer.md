# Памятка к задаче 6: background jobs, retries и DLQ

> [!tip] В двух словах
> **Долгая работа вне HTTP.** Пользователь быстро получает job ID, а worker выполняет операцию с повторами и восстановлением.

## Зачем нужна очередь

HTTP connection имеет timeout и может оборваться, хотя работа ещё полезна. Очередь отделяет приём команды от выполнения:

```text
POST export -> persist job -> enqueue -> 202
worker -> claim -> build -> store -> complete
GET status -> current state
```

Очередь распределяет нагрузку между workers и позволяет ограничить concurrency.

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

## Частые ошибки

- помещать большой файл или JWT в message;
- ack до сохранения результата;
- retry без лимита/backoff;
- два источника статуса: очередь и БД расходятся;
- считать duplicate delivery исключением;
- завершать process без graceful shutdown;
- повторно выдавать download URL, истёкший ещё в очереди.
