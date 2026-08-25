# Задача 10. Versioned document pipeline и hybrid AI search

> [!summary] Результат
> Загруженный документ обрабатывается повторяемым versioned pipeline, chunks индексируются в PostgreSQL/pgvector, а permission-aware поиск объединяет trigram и Voyage AI semantic ranking.

## Предусловия и фиксированный стек

Задачи №2–7 и №9 завершены. Использовать BullMQ, MinIO/S3, PostgreSQL 16, расширение `vector`, Prisma migrations, Voyage AI HTTP API. Название embedding model задаётся `VOYAGE_EMBEDDING_MODEL`; dimension задаётся `EMBEDDING_DIMENSION` и проверяется при старте.

Векторное хранилище — PostgreSQL pgvector. Отдельную vector database не добавлять. Provider закрыт интерфейсом `EmbeddingProvider`, production adapter — `VoyageEmbeddingProvider`, tests — deterministic fake.

## Модель

- `DocumentVersion`: documentId, version integer, sourceFileId, contentHash, status, pipelineVersion, timestamps; unique `(documentId, version)` и `(documentId, contentHash)`.
- `DocumentChunk`: versionId, chunkIndex, text, tokenCount, textHash; unique `(versionId, chunkIndex)`.
- `DocumentEmbedding`: chunkId, model, embeddingVersion, vector, status; unique `(chunkId, embeddingVersion)`.
- `PipelineStageRun`: versionId, stage, status, attempts, inputHash, errorCode, heartbeatAt, timestamps; unique `(versionId, stage, inputHash)`.

Статусы version: `UPLOADED`, `EXTRACTING`, `NORMALIZING`, `CHUNKING`, `EMBEDDING`, `INDEXED`, `FAILED`. Новая version становится current только после `INDEXED`.

## Pipeline

```text
ingest -> extract -> normalize -> chunk -> embed -> index -> activate
```

Каждая стадия — отдельная BullMQ job и worker processor. Payload содержит только IDs, version и trace context. Stage claim выполняется условным transition/unique key. Повторное событие с тем же input hash возвращает сохранённый результат.

- исходный файл сначала надёжно сохранён в object storage;
- extract и normalize работают stream/chunks, max file 25 MiB;
- chunk target 800 tokens, overlap 100, настройки входят в `pipelineVersion`;
- embedding batches до provider limit, concurrency и rate limit конфигурируются;
- retry: 5 раз с exponential backoff; permanent validation error сразу `FAILED`;
- heartbeat/recovery возвращает зависшую стадию в queue;
- новая загрузка не удаляет предыдущую active version;
- out-of-order stage не запускается, пока prerequisite не `COMPLETED`.

## API обработки

- `POST /documents/:id/versions` создаёт version из READY file и возвращает `202`;
- `GET /documents/:id/versions` и `GET /document-versions/:id` показывают status/progress;
- `POST /document-versions/:id/retry` повторяет failed stage без создания дублей.

Create/retry требуют document update permission, read — view; worker перед каждой новой version/stage подтверждает существование workspace membership автора job. Outsider получает `404`.

## Hybrid search

`GET /workspaces/:workspaceId/search?q=...&limit=20`:

1. проверить workspace view permission;
2. получить trigram candidates по title;
3. создать query embedding через Voyage AI;
4. получить pgvector candidates только из current indexed versions и projects данного workspace;
5. объединить два списка Reciprocal Rank Fusion с `k=60`;
6. вернуть documentId, title, snippet, projectId, updatedAt и объяснимые `matchedBy`/scores; полный chunk/content не возвращать.

Permission filter должен находиться в обоих SQL retrieval queries до `LIMIT`, а не применяться после получения чужих candidates.

## Смена embedding model без downtime

1. Добавить новую `embeddingVersion` и dual-write для новых chunks.
2. Backfill старых chunks batch jobs с rate limit/checkpoint.
3. Сравнить coverage, latency и quality fixture set.
4. Переключить read version config flag.
5. Сохранить предыдущую version для rollback один release cycle.
6. Очистить старые embeddings отдельной повторяемой job.

## Тесты

- duplicate upload/content создаёт одну logical version;
- два worker не выполняют одну stage одновременно;
- retry, crash recovery, duplicate/out-of-order messages;
- большой файл не загружается целиком в память;
- provider 429 соблюдает retry/backoff, partial batch безопасно продолжается;
- current version меняется только после полного index;
- hybrid ranking детерминирован с fake embeddings;
- outsider/chужой workspace отсутствует до LIMIT;
- migration embedding version: dual-write, backfill, switch, rollback;
- trace проходит через все stages.

## Документация и критерии приёмки

Создать `docs/ai/10-document-pipeline-and-hybrid-search.md`: state diagram, schemas, idempotency keys, chunking, rate limits, recovery, model migration и cost controls. Реальный Voyage key не коммитить. Pipeline воспроизводим в Docker с fake provider; отдельный opt-in integration test проверяет Voyage adapter.

