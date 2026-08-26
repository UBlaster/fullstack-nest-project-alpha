# Памятка к задаче 9: logs, traces и metrics

> [!tip] В двух словах
> **Понять сбой.** Наблюдаемость отвечает: что сломалось, у кого, где потрачено время и насколько проблема массовая.

## Три сигнала

- **Logs** объясняют конкретное событие с полями контекста.
- **Metrics** показывают тенденции и позволяют alert: error rate, p95 latency, queue age.
- **Traces** связывают путь одного запроса через зависимости и workers.

Один сигнал не заменяет остальные. Миллион логов неудобен для вычисления p95, а metric не содержит stack trace конкретного падения.

## Correlation ID и trace ID

Request ID удобен пользователю/support и проходит через application logs. Trace ID принадлежит distributed trace. Их полезно хранить рядом, но это разные идентификаторы.

При отправке job producer сохраняет trace context, worker извлекает его и создаёт consumer span. Иначе trace обрывается на HTTP response, хотя основная работа только началась.

## Structured JSON

Строку `failed export for user ...` трудно агрегировать. JSON с `operation`, `result`, `durationMs`, `error.type` индексируется и фильтруется.

```json
{"level":"error","operation":"export.upload","result":"timeout","traceId":"..."}
```

Не каждое поле годится в metric label. IDs создают миллионы time series и ломают monitoring backend. Высокую cardinality оставляют в logs/traces.

## Span boundaries

Span создают вокруг meaningful operation: DB query, cache lookup, queue wait/process, external API. Не нужно создавать span на каждую строку цикла. Span получает status/error и безопасные attributes, но не document content или signed URL.

## Error monitoring

Неожиданное исключение записывают один раз на boundary, группируют по типу/stack и связывают с release/environment. Клиенту возвращают стабильный error/request ID, но не внутренний stack.

## Надёжность telemetry

Telemetry экспортируется асинхронно и с лимитами. Падение collector не должно остановить оплату или login. Нужны sampling, batch export и защита от бесконечного buffer.

## Переиспользуемый NestJS-каркас

Middleware принимает или создаёт request ID и возвращает его клиенту:

```ts
use(request: Request, response: Response, next: NextFunction) {
	const incoming = request.header('x-request-id');
	const requestId = isSafeRequestId(incoming) ? incoming! : randomUUID();
	response.setHeader('x-request-id', requestId);
	this.context.run({ requestId }, next);
}
```

Logger добавляет trace IDs, но redacts secrets:

```ts
const logger = pino({
	redact: [
		'req.headers.authorization',
		'password',
		'passwordConfirmation',
		'presignedUrl',
		'webhookSignature',
	],
});
```

Trace context передаётся через очередь стандартными W3C headers:

```ts
const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
await queue.add('job', { entityId, traceContext: carrier });

const parent = propagation.extract(context.active(), job.data.traceContext);
await context.with(parent, () => tracer.startActiveSpan('job.process', processJob));
```

Metric labels должны быть ограничены: `{ method: 'GET', route: '/notes/:id', status: '2xx' }`. ID пользователя или raw URL оставляйте в trace/log.

## Частые ошибки

- логировать Authorization header;
- raw URL/documentId как metric label;
- новый request ID на каждом service call;
- trace теряется в queue;
- `console.log` рядом со structured logger;
- считать каждый ожидаемый `404` server error;
- telemetry backend становится обязательной зависимостью API.
