# Контекст Task 1

Ветка: `master`. Проверенная исходная база кода: `c489b92`.
Начало Task 1; перечисленное ниже — состояние до её реализации.

## Уже есть в базе

Учебный менеджер User → Workspace → Project → Document: React/TypeScript/Vite frontend,
NestJS backend с Prisma/PostgreSQL. Целевая цепочка — Controller → Service → PrismaService.

- Auth находится в `backend/src/auth.ts`, projects/documents — в `backend/src/resources.ts`;
  wiring — `app.module.ts`, Prisma — `prisma.service.ts` в той же папке.
  Есть login и `GET /auth/me`, но нет регистрации/удаления аккаунта;
  login и `backend/prisma/seed.ts` используют открытые пароли.
- `POST /projects` выбирает первый membership; project create/update принимает `any`.
  Documents вручную создаёт ProjectsService и использует его private-проверку доступа.
- В `backend/prisma/schema.prisma` пароль уже строковый; membership уникален по
  `userId_workspaceId`. Project связан с workspace/создателем, Document — с project/автором;
  связи авторства с User имеют `Restrict`.
- Project list ограничен memberships и содержит `_count.documents`, `createdBy.name`;
  detail — `documents[].author.name`. Порядок — `updatedAt desc`.
  Ответы используются страницами `frontend/src/pages/`.
- `backend/src/validation.pipe.ts` уже включает `whitelist` и `transform`: лишние поля DTO удаляются.
- Локальный дебаг: `start:debug`, `.vscode/launch.json` и opt-in
  `docker-compose.debug.yml`; API — 3000, frontend — 5173, Inspector — 9229.
  Source maps уже включены; Docker debugger использует mapping `backend` → `/app`.
- Middleware сохраняет UUID `X-Request-ID` в асинхронном контексте. Общий helper
  `observeS3` пишет безопасные metadata без изменения результата или исходной ошибки.
  Самого S3-адаптера и file API в этой базе нет; Postman-сценарий предназначен
  для завершённой Task 5. Запуск и ограничения описаны в `DEBUG.md`.

## Текущая задача

Task 1 — границы feature modules/Nest DI, runtime DTO и bcrypt с auth/project API,
описанным в задании. Сохранить имеющиеся project/document ответы.
Строковое поле пароля само по себе не требует migration.

Материалы выдаются отдельно: Task `01-auth-projects-refactoring-and-password-hashing.md`,
Guide `01-password-hashing-dto-and-module-boundaries-primer.md`
(локально могут размещаться в `docs/tasks/` и `docs/guides/`; в Git этой базы их нет).

## Проверки

`backend/test/auth.e2e-spec.ts` — smoke исходного приложения с demo seed;
новую функциональность он полностью не покрывает. Используется общий validation pipe.
Scripts backend: `format:check`, `lint`, `build`, `test:e2e`.
Отдельный `diagnostics.e2e-spec.ts` проверяет request context и безопасное логирование
без PostgreSQL/S3; его можно запускать с `--runInBand diagnostics.e2e-spec.ts`.
Из корня в настроенном окружении: `docker compose exec -T backend npm run <script>`;
для auth: `test:e2e -- --runInBand auth.e2e-spec.ts`. E2E/seed — на отдельной тестовой БД.
