# Памятка к задаче 7: zero-downtime migrations

> [!tip] В двух словах
> **Совместимость версий.** Во время rollout старый и новый код работают одновременно, поэтому схема должна временно поддерживать оба.

## Почему простое переименование опасно

Deployment не переключает все экземпляры атомарно. Пока новый container запускается, старый обслуживает requests. Если migration уже переименовала колонку, старый SQL падает.

Безопасный шаблон:

```text
expand -> dual-write -> backfill -> switch reads -> stop old writes -> contract
```

Каждый шаг должен быть совместим хотя бы с соседней версией приложения.

## Expand

Добавляют новое nullable поле/таблицу/индекс, не удаляя старое. Additive изменения обычно безопаснее destructive. Default на большой таблице всё равно проверяют на целевой версии PostgreSQL: некоторые DDL могут переписать таблицу или взять сильный lock.

## Dual-write и проблема расхождений

Новый код временно пишет оба представления. Лучше одна DB transaction, иначе первая запись может пройти, а вторая — нет. Нужны метрики mismatch и понятный source of truth на каждой фазе.

## Backfill должен быть скучным

Один `UPDATE millions` создаёт WAL, locks и replication lag. Batch backfill:

- выбирает ограниченную порцию;
- обновляет только ещё пустые rows;
- сохраняет progress;
- ограничивает нагрузку;
- безопасно запускается повторно.

Dry-run и verification важнее красивого progress bar.

## Switch и contract

Чтение переключают только после coverage/mismatch checks. Старую колонку оставляют на release cycle для rollback. Contract — отдельная последняя migration, после которой старый binary уже несовместим.

Rollback destructive migration часто невозможен без потери данных. Поэтому после contract обычно делают forward fix, а до contract откатывают code/config.

## Что проверяют на rehearsal

- чистую БД и копию с данными;
- старый binary на expanded schema;
- create/update во время backfill;
- lock wait и migration duration;
- остановку/restart backfill;
- rollback каждого доконтрактного release.

## Переиспользуемый rollout

Expand migration добавляет nullable колонку:

```sql
ALTER TABLE "Article" ADD COLUMN "body" TEXT;
```

Новый code в первой версии делает dual-write, но читает legacy:

```ts
await prisma.article.update({
	where: { id },
	data: { content: dto.content, body: dto.content },
});

return { ...article, content: article.content };
```

Идемпотентный batch обновляет только незаполненные строки:

```sql
WITH batch AS (
  SELECT "id" FROM "Article"
  WHERE "body" IS NULL
  ORDER BY "id"
  LIMIT 500
)
UPDATE "Article" a
SET "body" = a."content"
FROM batch
WHERE a."id" = batch."id" AND a."body" IS NULL;
```

Verification перед switch:

```sql
SELECT
  COUNT(*) FILTER (WHERE "body" IS NULL) AS missing,
  COUNT(*) FILTER (WHERE "body" IS DISTINCT FROM "content") AS mismatch
FROM "Article";
```

Switch читает `body ?? content`; только после нулевого fallback один release cycle можно прекратить legacy write. `DROP COLUMN` — последняя отдельная contract migration.

## Частые ошибки

- править уже применённую migration;
- использовать `db push`;
- добавлять NOT NULL без безопасного заполнения;
- удалять legacy поле в том же PR;
- не учитывать replicas/long transactions;
- считать rollback одной обратной SQL-командой.
