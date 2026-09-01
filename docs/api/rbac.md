# RBAC и изоляция workspace

Все workspace, project и document endpoints требуют Bearer JWT. Роль берётся из WorkspaceMember конкретного workspace и не хранится в JWT.

## Роли

| Действие                                           | OWNER | MEMBER | VIEWER |
| -------------------------------------------------- | :---: | :----: | :----: |
| Читать workspace/project/document                  |  да   |   да   |   да   |
| Изменять, архивировать workspace                   |  да   |  нет   |  нет   |
| Удалять workspace                                  |  да   |  нет   |  нет   |
| Создавать, изменять, архивировать project/document |  да   |   да   |  нет   |
| Удалять project/document                           |  да   |  нет   |  нет   |

Любой аутентифицированный пользователь может создать workspace и становится его OWNER.

Роль ADMIN удалена. Migration преобразует существующие ADMIN memberships в MEMBER.

## HTTP-политика

- 401 — JWT отсутствует или невалиден.
- 404 — ресурс отсутствует или пользователь не состоит в его workspace.
- 403 — membership существует, но роль не разрешает действие.
- 400 — DTO невалиден или update не содержит изменяемых полей.

Одинаковый 404 для отсутствующего и чужого ресурса скрывает существование чужих IDs.

## Endpoints

### Workspaces

- GET /workspaces
- POST /workspaces
- GET /workspaces/:workspaceId
- PATCH /workspaces/:workspaceId
- PATCH /workspaces/:workspaceId/archive
- DELETE /workspaces/:workspaceId

### Projects

- GET /projects
- GET /workspaces/:workspaceId/projects
- POST /workspaces/:workspaceId/projects
- GET /projects/:projectId
- PATCH /projects/:projectId
- PATCH /projects/:projectId/archive
- DELETE /projects/:projectId

### Documents

- GET /projects/:projectId/documents
- POST /projects/:projectId/documents
- GET /documents/:documentId
- PATCH /documents/:documentId
- PATCH /documents/:documentId/archive
- DELETE /documents/:documentId

## Request scope

- workspaceId и projectId берутся из URL;
- userId, createdById и authorId берутся из JWT;
- create/update DTO содержат только клиентские поля;
- ValidationPipe использует whitelist без forbidNonWhitelisted;
- лишние поля удаляются, но дополнительно не передаются в Prisma благодаря явному data input.

## Архивирование

Status меняется только через отдельный archive endpoint. Обычный PATCH не принимает status.

- archive идемпотентен;
- archived resources остаются доступными в list/detail;
- архивирование parent не меняет status children;
- update/delete не блокируются status;
- unarchive не реализован.

## Frontend compatibility

- GET /projects сохраняет _count.documents;
- GET /projects/:projectId сохраняет documents и author.name;
- GET /documents/:documentId сохраняет projectId, title и content;
- document create принимает title/content и игнорирует лишний status: DRAFT;
- document update принимает title/content.
