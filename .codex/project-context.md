# Контекст Task 5

Ветка: `feature/task-5-start`. Проверенная исходная база кода: `045983b`.

## Уже реализовано

Workspace → Project → Document: NestJS/Prisma/PostgreSQL backend с feature modules,
DI и Controller → Service → PrismaService; React/Vite frontend.
Есть CRUD, JWT, RBAC, workspace search и Redis cache-aside.

- `backend/prisma/schema.prisma`: Project.workspaceId, Document.projectId/authorId,
  title/content/status/timestamps и relation author→User уже существуют.
  DocumentFile и relation файлов ещё нет.
- `backend/src/access/access-policy.service.ts`: `requireDocument(userId, documentId, action)`
  возвращает document с project.workspaceId; есть `requireWorkspace(userId, workspaceId, action, resource)`.
  Нет membership — скрытый `404`, запрещённое действие — `403`;
  `permissions.ts`: document/view — все три роли, update — OWNER/MEMBER, delete — OWNER.
  JWT identity — `request.user.sub`.
- `backend/src/documents/controllers/workspace-documents.controller.ts` обслуживает workspace search.
  DocumentsService.search включает tenant predicate в SQL; ответ —
  id/projectId/title/status/updatedAt/author.name/score без content.
  Существующие DTO, ranking и shape сохраняются.
- `backend/src/cache/cache.service.ts` кеширует workspace project list/document search.
  Policy выполняется до Redis; ключи включают workspace version,
  успешные project/document mutations повышают version; при отказе Redis остаётся PostgreSQL fallback.
  Files/export не входят в эти read-контракты.
- `frontend/src/shared/api/client.ts` добавляет bearer token и разбирает JSON (204 → null).
  `frontend/src/pages/document/ui/DocumentPage.tsx` содержит document CRUD;
  `frontend/src/pages/project/ui/ProjectPage.tsx` знает project.workspaceId и workspace search.
  File UI и CSV download пока отсутствуют.

## Текущая задача и ориентиры

Task 5 — private-вложения через Yandex Object Storage/presigned URLs
и потоковый CSV workspace с ограниченной памятью и остановкой после disconnect.
Материалы выдаются отдельно: Task `05-object-storage-presigned-urls-and-streaming-export.md`,
Guide `05-object-storage-presigned-urls-and-streams-primer.md`.

Точки расширения: Prisma schema/new migration, `backend/src/storage/`,
`backend/src/document-files/`, documents-export service, DocumentsModule/workspace controller и указанный UI.
AWS SDK v3 и storage scripts уже есть в `backend/package.json`,
но модули storage/document-files/export и файлы этих scripts ещё отсутствуют.

## Проверки

`backend/test/object-storage.e2e-spec.ts` уже импортирует отсутствующие модули текущей задачи:
это acceptance-заготовка, общий test:e2e пока не обещает зелёный результат.
В настроенном окружении: `docker compose config --quiet`;
`docker compose exec -T <backend|frontend> npm run <script>`, scripts format:check/lint/build.
Backend E2E: `test:e2e -- --runInBand object-storage.e2e-spec.ts` после реализации;
сохранить auth/rbac/search/cache проверки. Использовать выделенную тестовую БД
и только собственные fixtures/objects.
