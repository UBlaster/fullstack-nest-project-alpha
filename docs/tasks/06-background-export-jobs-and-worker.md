# Задача 6. Очередь фоновых задач для больших экспортов

> [!summary] Результат
> Большой CSV export запускается через API, выполняется отдельным BullMQ worker, сохраняется в object storage и имеет наблюдаемый, идемпотентный статус.

## Предусловия и стек

Задачи №4 и №5 завершены. Использовать BullMQ поверх Redis, отдельный Nest application `worker`, существующий `ObjectStorageService` и PostgreSQL как источник статуса job.

## Модель `ExportJob`

Поля: `id`, `workspaceId`, `requestedById`, `status`, `filters` JSON, `queueJobId` unique, `objectKey?`, `errorCode?`, `attempts`, `expiresAt?`, `createdAt`, `startedAt?`, `finishedAt?`, `cancelRequestedAt?`.

Статусы: `QUEUED -> PROCESSING -> COMPLETED`; из `QUEUED/PROCESSING` возможны `FAILED` и `CANCELLED`. Терминальные статусы назад не переходят. Добавить новую backward-compatible migration.

## API

- `POST /workspaces/:workspaceId/exports` создаёт job и возвращает `202` с ID/status.
- `GET /exports/:exportId` возвращает status, progress, timestamps, errorCode и download URL только для `COMPLETED`.
- `DELETE /exports/:exportId` запрашивает отмену и возвращает `202`; повторный вызов идемпотентен.

Create требует permission view/export workspace. Get/cancel доступны автору job и ролям `OWNER/ADMIN`; outsider получает `404`.

## Создание и доставка job

1. В транзакции создать `ExportJob(QUEUED)` и outbox-запись `EXPORT_REQUESTED` с unique event ID.
2. Небольшой dispatcher публикует outbox в BullMQ с `jobId = ExportJob.id`, после успеха отмечает event published.
3. Повторная публикация безопасна благодаря одинаковому BullMQ `jobId`.
4. Worker получает только IDs и snapshot валидированных filters, заново загружает job/membership и проверяет доступ.

Это закрывает окно «БД сохранила job, процесс упал до отправки в очередь».

## Worker

- concurrency 2, attempts 5, exponential backoff 5 секунд;
- heartbeat/progress обновляется не чаще одного раза в 2 секунды;
- claim job через условный update `QUEUED -> PROCESSING`;
- CSV строится потоково и загружается multipart stream в S3;
- перед каждой страницей проверяется cancel flag;
- upload завершается до перехода в `COMPLETED`;
- duplicate delivery для terminal job ничего не пересоздаёт;
- после исчерпания retries job становится `FAILED`, сообщение/metadata попадает в `exports:dead` queue;
- graceful shutdown перестаёт брать новые jobs и ждёт активную работу до 30 секунд.

## Recovery и retention

Периодический recovery возвращает в `QUEUED` jobs `PROCESSING` без heartbeat дольше 5 минут. Completed object живёт 24 часа, затем cleanup удаляет файл и помечает expiry. Ошибки содержат стабильный `errorCode`, но не stack trace в API.

## Тесты

- успешные create -> processing -> completed -> download;
- outbox повторно доставляет потерянную публикацию;
- transient error вызывает retry/backoff, пятая ошибка — failed + dead queue;
- duplicate delivery создаёт один object;
- worker повторно проверяет permissions;
- отмена queued и processing job;
- recovery stale processing после падения;
- очередь недоступна: API сохраняет queued job, dispatcher повторяет позже;
- два worker не обрабатывают одну job одновременно;
- graceful shutdown и expiry cleanup.

## Документация и критерии приёмки

Создать `docs/infrastructure/06-background-exports.md`: state machine, job payload, retries, DLQ, recovery, runbook. API не ждёт формирования CSV. После рестарта backend/worker queued jobs не теряются, повторная доставка не создаёт второй export.

