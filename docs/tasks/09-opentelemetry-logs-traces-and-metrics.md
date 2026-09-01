# Задача 9. Structured logs, tracing и error monitoring

> [!summary] Результат
> Один correlation ID связывает HTTP, Prisma, Redis, BullMQ worker, S3 и payment provider; traces видны в Jaeger, метрики — в Prometheus, логи структурированы и не содержат секретов.

> [!note] Связанный материал
> См. [памятку к задаче 9](../guides/09-observability-logs-traces-and-metrics-primer.md).

## Проблема

Сейчас один пользовательский сценарий нельзя проследить через HTTP, Prisma, Redis, BullMQ, S3 и payment provider. Разрозненные строки логов не показывают, где потрачено время, насколько массовая ошибка и продолжилась ли операция после перехода в worker.

## Зафиксированный локальный стек

- OpenTelemetry Node SDK и OTLP exporter;
- OpenTelemetry Collector;
- Jaeger для traces;
- Prometheus для metrics;
- structured JSON logger `pino`/`nestjs-pino`;
- console error exporter в dev и OTLP exception events вместо обязательного внешнего SaaS.

Добавить сервисы в Compose с healthchecks. Если collector недоступен, приложение продолжает обслуживать запросы и не падает из-за telemetry export.

## Точки подключения

Добавьте `backend/src/observability/`, инициализируйте SDK в новом bootstrap-файле **до** import `AppModule`, иначе автоматические instrumentations загрузятся слишком поздно. HTTP middleware/interceptor создаёт request context; global exception filter записывает ошибку один раз.

```ts
// backend/src/instrumentation.ts
// Настроить NodeSDK, OTLP exporters и auto-instrumentations.
// Импортировать этот файл до AppModule в main.ts и worker.ts.
```

Request ID кладётся в `AsyncLocalStorage`, чтобы service не принимал его отдельным аргументом:

```ts
export type RequestContext = { requestId: string; userId?: string; workspaceId?: string };

export class RequestContextService {
	// run(context, callback)
	// get(): вернуть context текущей async-цепочки
}
```

Текущий `main.ts` получает telemetry bootstrap и logger. `worker.ts` из задачи №6 извлекает `traceparent` из job и создаёт consumer span. `PrismaService`, `CacheService`, `ObjectStorageService` и payment adapter получают child spans, но не должны логировать DTO/content.

Пример безопасной метрики: route template `/documents/:id`, method и status class. Небезопасная: label `documentId`, потому что число time series будет расти с каждым документом.

## Correlation ID

- принимать валидный `x-request-id` до 128 безопасных ASCII-символов или генерировать UUID;
- возвращать его в response header;
- хранить request context через `AsyncLocalStorage`;
- добавлять `requestId`, `traceId`, `spanId` во все application logs;
- передавать W3C `traceparent`/`tracestate` во внешние HTTP и BullMQ job data/options;
- worker создаёт consumer span, связанный с producer context.

## Structured logs

Обязательные поля: `timestamp`, `level`, `service`, `environment`, `operation`, `requestId`, `traceId`, `durationMs`, `statusCode`; `userId`/`workspaceId` добавлять только как IDs после authentication.

Запрещено логировать JWT/cookie, passwords, authorization headers, payment secrets/signatures, presigned URLs, raw webhook payload, document content и file body. Создать централизованный redact list.

## Traces

Добавить spans:

- inbound HTTP и outbound HTTP;
- Prisma/PostgreSQL без SQL parameter values;
- Redis operation с key namespace, но без полного user query;
- BullMQ publish/wait/process;
- S3 upload/download operation без signed URL;
- fake payment provider;
- export stages и AI stages в следующих задачах.

Ошибки записывать через `recordException`, status ERROR и стабильный `error.type`; ожидаемые `4xx` не считать server error.

## Метрики

- HTTP request count/duration/error rate по route template, не raw URL;
- DB/Redis/external duration и errors;
- cache hit/miss ratio;
- queue depth, oldest job age, processing duration, retries, DLQ;
- export duration/result;
- webhook result и reconciliation count.

Не использовать userId, workspaceId, documentId, requestId как metric labels из-за высокой cardinality.

## Error monitoring

Глобальный exception filter формирует безопасный API response, логирует exception один раз и помечает текущий span. Неожиданные ошибки получают stable error ID (requestId) и `500`; stack trace доступен только в telemetry/log backend, не клиенту.

## Runbook и критерии приёмки

Создать `docs/operations/09-observability-runbook.md`: локальные URLs, пример поиска requestId, путь по trace, запросы Prometheus и алгоритм поиска bottleneck. Один requestId связывает HTTP, зависимости и worker; redaction не пропускает secrets/content; недоступная telemetry-инфраструктура не останавливает API и worker. Docker-запуск остаётся рабочим.
