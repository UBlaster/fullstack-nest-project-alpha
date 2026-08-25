# Памятка к задаче 10: pipelines, embeddings и hybrid search

> [!tip] В двух словах
> **Повторяемая обработка.** Versioning и идемпотентные stages позволяют пережить сбой, а hybrid search сочетает точные слова и смысл.

## Почему pipeline разбивают на стадии

Извлечение текста, нормализация, chunking и embeddings имеют разную стоимость и причины ошибок. Один огромный worker приходится начинать сначала. Отдельные stages сохраняют checkpoint и повторяют только незавершённую часть.

```text
file -> extract -> normalize -> chunks -> embeddings -> index -> active
```

Каждая стадия имеет immutable input/version и идемпотентный key. Duplicate message тогда возвращает уже созданный result.

## Versioning защищает текущий документ

Новая загрузка может не распарситься или AI provider может быть недоступен. Если сразу заменить current content, поиск потеряет рабочую версию. Поэтому новая version строится рядом и становится active атомарно только после полного index.

`pipelineVersion` фиксирует алгоритм normalization/chunking. Одинаковый файл, обработанный другим алгоритмом, не считается тем же результатом.

## Что такое embedding

Embedding — числовой вектор, в котором семантически похожие тексты располагаются ближе. Query и chunks должны быть созданы совместимой моделью и dimension. Смешивать vectors разных моделей в одном сравнении нельзя.

Документ делят на chunks, потому что модель имеет input limit, а маленький relevant fragment ранжируется лучше целой книги. Overlap сохраняет мысль на границе chunks, но увеличивает стоимость и дубли.

## Почему hybrid лучше одного поиска

Trigram хорошо находит точное имя, код и опечатку. Semantic search — перефразированную мысль. Reciprocal Rank Fusion объединяет позиции без попытки сравнить несопоставимые raw scores.

```text
RRF score = sum(1 / (k + rank_in_list))
```

## Permissions применяются до top-K

Фильтрация после vector `LIMIT 20` может удалить почти все результаты и уже допустит retrieval чужих chunks. Workspace/project predicate должен быть внутри vector и lexical queries до ranking limit.

## Миграция модели

Новая embedding model меняет vectors и часто dimension. Production rollout повторяет database migration pattern: versioned storage, dual-write, rate-limited backfill, quality/coverage check, config switch, rollback window, cleanup.

## Отказоустойчивость AI вызовов

429 требует уважать Retry-After/backoff. Batch получает stable IDs; частичный успех сохраняется, чтобы не оплачивать всё повторно. Cost metrics считают tokens/chunks без логирования текста.

## Частые ошибки

- current version переключается до окончания index;
- stage не проверяет prerequisite;
- vectors без model/version metadata;
- retry всего batch после одного failed item;
- semantic candidates фильтруются в JavaScript;
- chunks/document content попадают в logs;
- качество оценивается только субъективным одним запросом.

