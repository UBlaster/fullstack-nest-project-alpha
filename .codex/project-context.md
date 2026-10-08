# Контекст Task 2

Ветка: `feature/task-2-start`. Проверенная исходная база кода: `27efe73`.

## Уже реализовано

Менеджер Workspace → Project → Document: React/TypeScript frontend,
NestJS/Prisma/PostgreSQL backend с feature modules, DI и Controller → Service → PrismaService.

- `backend/src/prisma/prisma.module.ts` глобально экспортирует PrismaService.
  `backend/src/auth/` разделяет login, registration и account services и использует bcrypt.
  `AuthenticatedRequest.user` содержит `sub/email`; `@JwtAuth()` защищает resource controllers.
- `backend/prisma/schema.prisma`: membership уникален по `userId_workspaceId`,
  роли пока `OWNER/ADMIN/MEMBER/VIEWER`. Project имеет `workspaceId`,
  Document связан с workspace через Project. Project/Document status уже есть,
  Workspace status ещё отсутствует.
- `ProjectsModule` экспортирует ProjectsService и ProjectAccessService;
  `DocumentsModule` импортирует его. ProjectAccessService/DocumentAccessService
  дают скрытый `404` без membership, но роли не проверяют.
- Контроллеры разделены по URL в `projects/controllers/` и `documents/controllers/`.
  `POST /workspaces/:workspaceId/projects` берёт workspace из URL, создателя из JWT.
  Project DTO в `projects/dto/`; allowlist — `name/description`, пустой PATCH даёт `400`.
- `GET /projects` ограничен memberships и возвращает массив с `_count.documents`;
  detail содержит `documents[].author.name`. Document detail — `projectId/title/content`.
  Эти формы используют страницы `frontend/src/pages/`.
- Document body пока `any`, Prisma data не защищены allowlist.
  Frontend create отправляет `title/content/status: DRAFT`, edit — `title/content`;
  пустой content допустим. Общий `validation.pipe.ts` включает whitelist/transform
  без `forbidNonWhitelisted`.

## Текущая задача и ориентиры

Task 2 — единая policy с матрицей `OWNER/MEMBER/VIEWER`, Workspace API,
document DTO и archive endpoints по заданию. Сохранить клиентские контракты.
Точки работы: существующие access/feature services, Prisma schema/seed и `app.module.ts`.

Материалы выдаются отдельно: Task `02-rbac-workspace-data-access.md`,
Guide `02-rbac-and-data-isolation-primer.md` (в Git этой базы их нет).

## Проверки

`backend/test/rbac.e2e-spec.ts` — acceptance для прав, hidden 404, list isolation,
защиты relation/status полей и archive; это ещё не готовый RBAC.
Регрессии auth — `auth.e2e-spec.ts`.
Scripts backend: `format:check`, `lint`, `build`, `test:e2e`.
Из корня: `docker compose exec -T backend npm run <script>`;
E2E: `test:e2e -- --runInBand` на отдельной тестовой БД с применённой схемой.
