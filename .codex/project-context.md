# Контекст Task 7: старт с acceptance-тестами

## Checkout и база

- Ветка `feature/task-7-start`, проверенная production-база:
  `c3198ed7307285b14914c8072bba03ee486b7c4c`.
  Полная база Task 6: `15e61b5dff91c88fc1ce5633ebfd4c400cad1b32`.
- Добавлены фазовые acceptance/e2e тесты Task 7; сама миграция ещё не реализована.
  Document.content остаётся обязательной строкой, body и migrations Task 7 отсутствуют.
  Проверка наличия теста не означает выполненный контракт: на starter ожидаемы
  пропуски по opt-in и красные проверки при явном включении нереализованной фазы.
- Starter уже отклоняет PATCH content:null/нестроковое на HTTP-границе;
  отсутствие поля и пустая строка допустимы. Девять DTO validation checks входят
  в c3198ed и не являются реализацией переноса.

## Существующие контракты

- NestJS feature modules/DI, Controller → Service → PrismaService,
  Prisma/PostgreSQL, React/Vite, JWT и workspace RBAC/isolation.
- Redis кеширует metadata; фоновый CSV использует RabbitMQ/amqplib, ExportJob +
  OutboxEvent и отдельный worker. Private files, sync/async metadata CSV — S3.
  Эти контракты, author/project и nested documents нужно сохранить.

## Цель и ориентиры

- Task 7 — поэтапно перенести Document.content в обязательный Document.body
  через A → backfill/reconcile → B → C → D, сохранив внешнее HTTP-поле content.
  Прочитать tasks/07-zero-downtime-document-content-migration.md и
  guides/07-zero-downtime-database-migrations-primer.md из набора задания.
- Рабочие пути: backend/prisma/schema.prisma, migrations/, seed.ts;
  backend/src/documents/, projects/projects.service.ts, access/access-policy.service.ts;
  backend/src/main.ts, worker/worker.ts и backend/test/.
- Схема меняется versioned migrations. Пустая migration для C не нужна;
  опубликованную историю, общий volume и рабочий env не сбрасывать.
  API content сохраняется во всех фазах, пустую строку запрещать нельзя.

## Фазовые тесты и безопасный запуск

- HTTP/SQL suites: document-body-release-a.e2e-spec.ts,
  document-body-release-b.e2e-spec.ts, document-body-release-cd.e2e-spec.ts.
  Соответствующие пары opt-in/URL: TASK7_RELEASE_A_E2E=true +
  TASK7_RELEASE_A_DATABASE_URL; аналогично TASK7_RELEASE_B_* и TASK7_RELEASE_CD_*.
- Backfill SQL suite: backfill-document-body.e2e-spec.ts с TASK7_BACKFILL_E2E=true
  и TASK7_BACKFILL_DATABASE_URL. No-DB suites: backfill-document-body-options.e2e-spec.ts
  и backfill-document-body-guard.e2e-spec.ts. Helpers: document-legacy-sql.ts и
  backfill-document-body-contract.ts; это тестовые контракты, не production CLI.
- CLI-тесты ожидают именованные exports parseOptions, assertReleaseAClient, readCounts
  и runBackfill; их типы и события описаны в test-only contract helper.
- SQL/HTTP guard допускает только PostgreSQL на localhost/127.0.0.1:55437,
  public schema и точную выделенную БД своей фазы: task7_release_a_test,
  task7_release_b_test, task7_release_cd_test либо task7_backfill_test.
  Для tests с записью не подставлять dev/rehearsal/обычную рабочую БД.
- No-DB backfill suites активны при наличии production script или явном opt-in.
  На starter без script и без flag они SKIP; явный opt-in при отсутствующем script
  должен дать понятный FAIL, а не скрыть незавершённую реализацию.
- Из backend для no-DB checks:
  `node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand --runTestsByPath test/backfill-document-body-options.e2e-spec.ts test/backfill-document-body-guard.e2e-spec.ts`.
  Для выбранной HTTP/SQL фазы использовать закрытый TEST_ENV с её opt-in/URL:
  `node --env-file=<TEST_ENV> node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand --runTestsByPath test/<PHASE_SUITE>.e2e-spec.ts`.
- Starter с content нельзя запускать против сохранённой финальной D-БД task7-final.
- Выполнять suite на схеме/коде своей фазы; исторические A/B не являются проверкой
  финального D. Строгие test/app typechecks и lint/format не отключать ради starter.
  Runtime rehearsal, данные и cleanup выполнять по Task/Guide; тестовые fixtures
  и секреты не переносить в рабочую БД или Git.
