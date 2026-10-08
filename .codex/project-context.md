# Контекст Task 1

Ветка: `feature/task-1-start`. Проверенная исходная база кода: `8ec6b4a`.
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

## Текущая задача

Task 1 — границы feature modules/Nest DI, runtime DTO и bcrypt с auth/project API,
описанным в задании. Сохранить имеющиеся project/document ответы.
Строковое поле пароля само по себе не требует migration.

Материалы выдаются отдельно: Task `01-auth-projects-refactoring-and-password-hashing.md`,
Guide `01-password-hashing-dto-and-module-boundaries-primer.md`
(локально могут размещаться в `docs/tasks/` и `docs/guides/`; в Git этой базы их нет).

## Проверки

`backend/test/auth.e2e-spec.ts` уже проверяет ожидаемый auth/project API Task 1,
bcrypt и удаление аккаунта; наличие тестов не означает готовую реализацию.
Используется общий validation pipe.
Scripts backend: `format:check`, `lint`, `build`, `test:e2e`.
Из корня в настроенном окружении: `docker compose exec -T backend npm run <script>`;
для auth: `test:e2e -- --runInBand auth.e2e-spec.ts`. E2E/seed — на отдельной тестовой БД.
