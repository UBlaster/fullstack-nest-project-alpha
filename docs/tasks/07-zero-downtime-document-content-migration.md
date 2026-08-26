# Задача 7. Zero-downtime миграция `Document.content` в `Document.body`

> [!summary] Результат
> Колонка документа переименована через expand -> dual-write -> backfill -> switch -> contract без окна, в котором старая или новая версия API несовместима со схемой.

## Сценарий

Нужно заменить legacy-поле `Document.content` новым полем `Document.body`. Прямой `RENAME COLUMN` запрещён: старая версия приложения после deploy schema перестанет работать.

Работа состоит из четырёх отдельных migrations/releases. Их нельзя объединять или переписывать после применения.

## Как это связано с текущим репозиторием

Сейчас `content` обязательно в `backend/prisma/schema.prisma`, создаётся в `DocumentsService.create`, обновляется в `DocumentsService.update`, выводится в `frontend/src/pages/document/ui/DocumentPage.tsx` и заполняется seed. Значит, dual-read/write нужно провести через все эти места, а не только через Prisma schema.

- **Expand** — добавить новое, не удаляя старое.
- **Backfill** — заполнить новое поле для уже существующих строк.
- **Switch** — перевести чтение на новое поле.
- **Contract** — удалить legacy только после rollback window.

На фазе A Prisma schema временно содержит оба поля:

```prisma
model Document {
  // остальные поля
  content String
  body    String?
}
```

Service пишет оба значения:

```ts
data: {
	title: dto.title,
	content: dto.content,
	body: dto.content,
	projectId,
	authorId: userId,
}
```

Backfill удобно реализовать raw SQL batches с условием `body IS NULL`; это делает повторный запуск безопасным. После switch API всё ещё может отдавать поле `content`, вычисляя его из `body`, чтобы не ломать текущий React frontend. Переименование внешнего JSON-контракта не является целью этой DB migration.

## Release A — expand и dual-write

1. Добавить nullable `Document.body String?` новой migration, не трогая `content`.
2. Новая версия при create/update пишет одинаковое значение в `content` и `body` одной DB-операцией/транзакцией.
3. Чтение продолжает использовать `content`.
4. Добавить метрики ошибок dual-write и количества `body IS NULL`.

Старая версия работает, потому что `content` сохранён; новая — потому что `body` уже существует.

## Backfill

Создать повторяемую CLI-команду `npm run backfill:document-body`:

- обрабатывать по 500 строк с `body IS NULL`;
- двигаться keyset-pagination по `id`;
- обновлять только `WHERE body IS NULL`;
- commit на batch, пауза 100 мс, лог progress без content;
- поддержать `--dry-run`, `--batch-size`, `--max-batches`;
- повторный запуск не портит уже заполненные строки.

После backfill выполнить verification query: count null, count mismatch и выборочную checksum-проверку. При mismatch switch запрещён.

## Release B — switch reads

- продолжать dual-write;
- читать `body ?? content`;
- добавить alert/метрику fallback на `content`;
- раскатить версию и дождаться `body IS NULL = 0`, mismatch = 0, fallback = 0.

## Release C — stop legacy writes

- писать и читать только `body`;
- `content` оставить в схеме на один полный release cycle;
- rollback на Release B возможен без восстановления данных.

## Release D — contract

Отдельной migration сделать `body NOT NULL`, затем удалить `content`. Перед SQL повторить verification. После contract rollback к старому бинарнику запрещён; rollback выполняется только новой forward-fix migration.

> [!danger] Запрещено
> `prisma db push`, редактирование старых migrations, один deploy с удалением `content`, один огромный UPDATE без batch и destructive SQL без backup/verification.

## Проверка блокировок

Для каждой DDL-команды записать ожидаемый lock, длительность на копии заполненной БД и `lock_timeout`. Если операция превышает 5 секунд или ждёт lock, migration должна прерваться, а не блокировать API.

## Тестовая матрица совместимости

- старая версия + schema до expand;
- старая версия + expanded schema;
- Release A/B + expanded/backfilled schema;
- Release C + schema с legacy column;
- Release D + contracted schema;
- повторный backfill и остановка между batches;
- create/update во время backfill не создаёт mismatch;
- migrations применяются на чистой БД и копии с данными.

## Порядок выполнения

Выполняйте по одному release и фиксируйте результат: A expand/dual-write -> backfill rehearsal -> B switch reads -> наблюдение -> C stop legacy writes -> rollback window -> D contract. Нельзя заранее создать contract migration и применить её вместе с expand только потому, что локально запускается один container.

## Runbook

Создать `docs/database/07-zero-downtime-content-migration.md`: команды каждого deploy, SQL verification, dashboards, stop criteria, rollback до contract и действия после contract. Приложить результаты rehearsal.

## Критерии приёмки

- Четыре фазы отделены migration/release boundaries.
- API остаётся доступным, данные не теряются, backfill идемпотентен.
- Минимум две соседние версии совместимы на каждом доконтрактном шаге.
- Contract запускается только после документированных проверок.
