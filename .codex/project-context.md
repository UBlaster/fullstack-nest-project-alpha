# Контекст Task 3

Ветка: `feature/task-3-start`. Проверенная исходная база кода: `481ad0d`.

## Уже реализовано

Workspace → Project → Document: NestJS/Prisma/PostgreSQL backend с feature modules,
DI и Controller → Service → PrismaService; React/Vite frontend.
CRUD, JWT и workspace RBAC готовы. Search endpoint/DTO, pg_trgm и trigram index ещё отсутствуют.

- `backend/src/access/access-policy.service.ts` предоставляет `requireWorkspace(userId,
  workspaceId, action, resource)`, `requireProject`, `requireDocument`.
  Нет ресурса/membership — скрытый `404`, запрещённое действие участника — `403`.
  В `permissions.ts` document/view разрешён OWNER/MEMBER/VIEWER; JWT identity — `request.user.sub`.
- `backend/prisma/schema.prisma`: tenant-путь Document.projectId → Project.workspaceId.
  Document имеет title/content/status/updatedAt/author; статусы DRAFT/ACTIVE/ARCHIVED.
  B-tree indexes Project.workspaceId, Document.projectId/authorId уже существуют.
- `backend/src/documents/documents.service.ts` получает Prisma/policy через DI;
  list ограничен projectId и загружает author.name через relation.
  DocumentsModule регистрирует document-ID/project-document controllers;
  workspace search controller пока отсутствует.
- `backend/src/projects/projects.service.ts`: detail получает documents/author.name через include;
  lists — _count.documents и createdBy.name. Project и workspace lists ограничены membership.
  Существующие relation reads нужно измерять, а не считать доказанным N+1.
- `backend/src/validation.pipe.ts` включает whitelist/transform.
  UI документов проекта — `frontend/src/pages/project/ui/ProjectPage.tsx`;
  HTTP helper — `frontend/src/shared/api/client.ts`.

## Текущая задача и проверки

Task 3 — workspace-поиск по заголовкам и измерение read-запросов.
Точки расширения: DocumentsModule/service/controller/DTO, новые Prisma migrations, указанный UI.
Материалы выдаются отдельно: Task `03-postgresql-trigram-search-and-query-optimization.md`,
Guide `03-sql-indexes-n-plus-one-and-trigram-search-primer.md`.

`backend/test/search.e2e-spec.ts` уже задаёт acceptance поиска, ещё не реализованного в базе.
В настроенном окружении: `docker compose exec -T backend npm run <script>`;
scripts — `format:check`, `lint`, `build`, `test:e2e`.
Целевой запуск: `test:e2e -- --runInBand search.e2e-spec.ts`; сохранить auth/RBAC проверки.
После изменений frontend — его format/lint/build scripts.
E2E — на выделенной тестовой БД, cleanup только собственных fixtures.
