# Контекст Task 4

Ветка: `feature/task-4-start`. Проверенная исходная база кода: `dd1498c`.

## Уже реализовано

Workspace → Project → Document: NestJS/Prisma/PostgreSQL backend с feature modules,
DI и Controller → Service → PrismaService; React/Vite frontend.
CRUD, JWT, RBAC и trigram search готовы.
Redis 7 с AOF/healthcheck и CACHE-настройки уже есть в Compose, ioredis — в backend package.
CacheModule/CacheService отсутствуют: feature reads обращаются к PostgreSQL.

- `backend/src/access/access-policy.service.ts` и `permissions.ts` задают доступ:
  OWNER/MEMBER/VIEWER читают projects/documents; нет ресурса/membership — скрытый `404`,
  запрещённое действие — `403`. JWT identity — `request.user.sub`.
- `backend/src/projects/projects.service.ts`: `listByWorkspace` обслуживает
  `GET /workspaces/:workspaceId/projects`: policy(view/project), затем Prisma where workspaceId,
  `_count.documents`, `createdBy.name`, порядок updatedAt DESC.
  Отдельный `GET /projects` возвращает проекты всех доступных workspaces.
- `backend/src/documents/documents.service.ts`: search для
  `GET /workspaces/:workspaceId/documents/search` сначала проверяет policy(view/document).
  SQL параметризован; workspace predicate предшествует ranking/pagination.
  Interactive transaction задаёт local thresholds 0.3, используются % и <%,
  порядок score DESC → updatedAt DESC → id ASC.
- `documents/dto/search-documents-query.dto.ts`: trimmed q 2–100,
  limit 1–50/default 20, offset 0–5000/default 0; пустые числа отклоняются.
  Ответ — id/projectId/title/status/updatedAt/author.name/score без content;
  ARCHIVED участвует в поиске. pg_trgm и GIN index уже закреплены migrations.
- ProjectsService/DocumentsService имеют create/update/archive/remove;
  archive меняет status, project delete каскадирует documents.
  Policy возвращает project.workspaceId из requireProject и document.project.workspaceId
  из requireDocument; create берёт workspace/project из URL.
  Это источники tenant для интеграции инвалидации.

## Текущая задача и проверки

Task 4 — cache-aside для двух указанных workspace reads с сохранением HTTP, доступа и SQL-контрактов.
Точки DI: `backend/src/projects/projects.module.ts`, `documents/documents.module.ts`
(сейчас импортируют AccessModule), ConfigModule в `app.module.ts`.
Материалы выдаются отдельно: Task `04-redis-cache-aside-for-read-endpoints.md`,
Guide `04-redis-cache-aside-primer.md`.

`backend/test/cache.e2e-spec.ts` уже импортирует отсутствующие cache-модули:
это acceptance будущей реализации текущей задачи. Регрессии поиска — `search.e2e-spec.ts`.
В настроенном окружении: `docker compose config --quiet`;
`docker compose exec -T backend npm run <script>`, scripts format:check/lint/build/test:e2e.
Целевой E2E: `test:e2e -- --runInBand cache.e2e-spec.ts`;
проверить также недоступный Redis по Task. E2E — выделенные PostgreSQL/Redis и собственные fixtures.
