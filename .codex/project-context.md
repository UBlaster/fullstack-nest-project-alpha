# Контекст Task 6

## Checkout и база

- Ветка: `feature/task-6-start`. Функциональная база Task 5: `e735fa4543145eb09a6721ce6c17306dc7e5d9a8`.
- Сохранены общие JWT/RBAC, controller split, DTO validation, Redis cache и локальная отладка.
- Реализации Task 6 нет; её acceptance-тесты сохранены.

## Уже реализовано

NestJS/Prisma/PostgreSQL backend: Controller → Service → PrismaService, DI и feature modules;
React/Vite frontend с workspace → project → document и tenant isolation.

- Task 5: private-вложения в Yandex Object Storage, presigned upload/download,
  lifecycle DocumentFile и потоковый синхронный CSV workspace.
- `backend/src/document-files/`, `backend/src/storage/` и
  `backend/src/documents/documents-export.service.ts` уже существуют.
  WorkspaceDocumentsController обслуживает search и синхронный `export.csv`.
- Prisma содержит DocumentFile; ExportJob/OutboxEvent и migration Task 6 отсутствуют.
- Redis обслуживает cache-aside Task 4. RabbitMQ, worker и фоновый export UI отсутствуют.
- Локальная отладка API и безопасная S3-диагностика сохранены; настройки —
  `docker-compose.debug.yml`, `.vscode/launch.json` и `DEBUG.md`.

## Текущая задача

Реализовать Task 6 — фоновые CSV jobs и отдельный worker с RabbitMQ.
Материалы выдаются отдельно: Task `06-background-export-jobs-and-worker.md`,
Guide `06-background-jobs-retries-and-dlq-primer.md`.

Точки расширения: новая migration/Prisma models, feature modules backend, S3 streaming,
очередь/worker, Compose и ProjectPage. Готовых модулей или заглушек Task 6 в базе нет.

## Тесты и проверки

- Сохранены все тесты Task 6: background export API/worker/storage/orphans/shutdown,
  processor, RabbitMQ transport и opt-in Yandex acceptance. Их imports и строгие
  проверки намеренно требуют будущую реализацию; до неё общий E2E не обещает зелёный результат.
- `tsconfig.json` и `tsconfig.build.json` собирают приложение отдельно от тестов.
  Jest использует строгий `backend/test/tsconfig.json`; skip/stubs для скрытия отсутствующего кода не добавлены.
- `test-config.ts` изолирует тестовые значения ConfigService от process.env.
- Backend/frontend build, обычный typecheck приложения, lint затронутого кода и оба
  Compose-конфига проверены с сохранёнными тестами и без реализации Task 6.
- Чистый Linux-образ с Prisma Client Task 5 и всеми 14 наборами тестов также прошёл
  build/typecheck без модулей, моделей и зависимостей Task 6; тесты не попали в dist.
- После реализации: backend app/test typecheck, build, lint и E2E; frontend build/lint.
  Проверки с записью запускаются только на выделенной тестовой БД и собственных S3 fixtures.
