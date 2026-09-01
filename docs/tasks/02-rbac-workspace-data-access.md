# Задача 2. RBAC и изоляция данных workspace

> [!summary] Результат
> Workspace, projects и documents используют одну матрицу из трёх ролей. Участник получает только разрешённые действия, outsider не видит чужие данные, а существующий frontend продолжает работать без изменения контрактов.

> [!note] Перед началом
> Сначала прочитайте [RBAC и изоляция данных в NestJS](../guides/02-rbac-and-data-isolation-primer.md). Guide содержит полную реализацию на примере Team -> Board -> Note. В этой задаче вы последовательно переносите тот же pattern на Workspace -> Project -> Document.

## 1. Исходное состояние: сразу после предыдущей задачи

Начинайте работу из текущего состояния проекта. В нём уже выполнено следующее:

- auth и projects разнесены по NestJS modules;
- существуют ProjectsModule и DocumentsModule;
- ProjectsModule экспортирует ProjectsService;
- DocumentsModule импортирует ProjectsModule;
- DocumentsService получает ProjectsService через constructor injection;
- существует типизированный AuthenticatedRequest;
- JWT guard защищает существующие endpoints;
- существуют CreateProjectDto и UpdateProjectDto;
- project создаётся только через POST /workspaces/:workspaceId/projects;
- workspaceId берётся из URL, createdById — из JWT;
- Prisma input для project create/update собирается явно;
- пустой project PATCH возвращает 400;
- GET /projects возвращает доступные проекты;
- GET /projects/:projectId возвращает project вместе с documents;
- project и document уже проверяют membership, но пока не учитывают роль;
- Workspace API и общий access policy отсутствуют;
- DocumentsController и DocumentsService ещё используют any;
- document create/update ещё передают произвольные поля в Prisma;
- WorkspaceRole содержит OWNER, ADMIN, MEMBER и VIEWER;
- ProjectStatus и DocumentStatus уже существуют;
- глобальный ValidationPipe использует whitelist: true и transform: true без forbidNonWhitelisted.

Работайте только с перечисленными выше существующими modules и services: это полное исходное состояние для задачи.

## 2. Карта переноса из guide

Используйте одинаковый порядок реализации и заменяйте только предметные названия:

| Guide      | Текущий проект  |
| ---------- | --------------- |
| Team       | Workspace       |
| TeamMember | WorkspaceMember |
| Board      | Project         |
| Note       | Document        |
| TeamRole   | WorkspaceRole   |
| LEAD       | OWNER           |
| EDITOR     | MEMBER          |
| READER     | VIEWER          |
| teamId     | workspaceId     |
| boardId    | projectId       |

AccessPolicyService, AccessModule, permission matrix, hidden 404, provider export/import и relation path переносятся без изменения идеи.

## 3. Зафиксированная матрица прав

После этой задачи остаются только три роли:

- OWNER полностью управляет workspace и его ресурсами;
- MEMBER читает workspace, создаёт, изменяет и архивирует projects/documents;
- VIEWER только читает.

| Ресурс и действие      | OWNER | MEMBER | VIEWER |
| ---------------------- | :---: | :----: | :----: |
| Просмотреть workspace  |  да   |   да   |   да   |
| Изменить workspace     |  да   |  нет   |  нет   |
| Архивировать workspace |  да   |  нет   |  нет   |
| Удалить workspace      |  да   |  нет   |  нет   |
| Просмотреть project    |  да   |   да   |   да   |
| Создать project        |  да   |   да   |  нет   |
| Изменить project       |  да   |   да   |  нет   |
| Архивировать project   |  да   |   да   |  нет   |
| Удалить project        |  да   |  нет   |  нет   |
| Просмотреть document   |  да   |   да   |   да   |
| Создать document       |  да   |   да   |  нет   |
| Изменить document      |  да   |   да   |  нет   |
| Архивировать document  |  да   |   да   |  нет   |
| Удалить document       |  да   |  нет   |  нет   |

Создать новый workspace может любой аутентифицированный пользователь, даже если он ещё не имеет membership. Создатель становится OWNER.

MEMBER может изменять любой project и document своего workspace. Авторство не добавляет и не ограничивает права.

## 4. HTTP-политика

Во всех feature services действует один порядок:

- 401 — JWT отсутствует или невалиден;
- 404 — ресурс не существует;
- 404 — ресурс существует, но пользователь не состоит в его workspace;
- 403 — membership существует, но роль не разрешает действие;
- 400 — DTO не прошёл валидацию или update body не содержит изменяемых полей.

Outsider не должен отличить отсутствующий ID от ID чужого ресурса.

Lists не вызывают policy для каждой строки. Prisma query сразу ограничивается workspace текущего пользователя.

## 5. Ожидаемый API

Все endpoints требуют JWT:

- GET /workspaces;
- POST /workspaces;
- GET /workspaces/:workspaceId;
- PATCH /workspaces/:workspaceId;
- PATCH /workspaces/:workspaceId/archive;
- DELETE /workspaces/:workspaceId;
- GET /projects;
- GET /workspaces/:workspaceId/projects;
- POST /workspaces/:workspaceId/projects;
- GET /projects/:projectId;
- PATCH /projects/:projectId;
- PATCH /projects/:projectId/archive;
- DELETE /projects/:projectId;
- GET /projects/:projectId/documents;
- POST /projects/:projectId/documents;
- GET /documents/:documentId;
- PATCH /documents/:documentId;
- PATCH /documents/:documentId/archive;
- DELETE /documents/:documentId.

## 6. Контракты существующего frontend

URL недостаточно: сохраните используемые frontend структуры.

- GET /projects возвращает массив, в каждом project остаётся _count.documents.
- GET /projects/:projectId возвращает documents.
- У document внутри project detail остаётся author.name.
- GET /documents/:documentId возвращает как минимум projectId, title и content.
- POST /projects/:projectId/documents принимает payload frontend: title, content и лишнее поле status со значением DRAFT.
- PATCH /documents/:documentId принимает title и content.

ValidationPipe не изменяйте. При whitelist: true поле status без decorator удаляется из create DTO, а Prisma default создаёт document со статусом DRAFT. forbidNonWhitelisted не добавляйте.

## 7. Файлы задачи

Создайте:

```text
backend/src/access/access.module.ts
backend/src/access/access-policy.service.ts
backend/src/access/permissions.ts
backend/src/workspaces/workspaces.module.ts
backend/src/workspaces/workspaces.controller.ts
backend/src/workspaces/workspaces.service.ts
backend/src/workspaces/dto/create-workspace.dto.ts
backend/src/workspaces/dto/update-workspace.dto.ts
backend/src/documents/dto/create-document.dto.ts
backend/src/documents/dto/update-document.dto.ts
backend/prisma/migrations/<timestamp>_simplify_roles_and_add_workspace_status/migration.sql
backend/test/rbac.e2e-spec.ts
docs/api/rbac.md
```

Измените:

```text
backend/prisma/schema.prisma
backend/prisma/seed.ts
backend/src/app.module.ts
backend/src/projects/projects.module.ts
backend/src/projects/projects.controller.ts
backend/src/projects/projects.service.ts
backend/src/documents/documents.module.ts
backend/src/documents/documents.controller.ts
backend/src/documents/documents.service.ts
```

Существующие project DTO не пересоздавайте.

## 8. Шаг 1. Schema и migration

Откройте backend/prisma/schema.prisma и раздел guide о миграциях ролей и статусов.

Измените WorkspaceRole:

```prisma
enum WorkspaceRole {
  OWNER
  MEMBER
  VIEWER
}
```

Роль ADMIN удаляется. Для существующих данных зафиксировано соответствие:

```text
ADMIN -> MEMBER
```

Добавьте:

```prisma
enum WorkspaceStatus {
  ACTIVE
  ARCHIVED
}
```

В Workspace добавьте status с default ACTIVE.

Создайте migration в режиме create-only. Проверьте SQL вручную: PostgreSQL enum нельзя безопасно уменьшить простым удалением строки из schema. Migration должна сначала сохранить существующие memberships, преобразовать ADMIN в MEMBER и только затем заменить enum.

Не редактируйте опубликованные migrations и не используйте prisma db push вместо новой migration.

Checkpoint:

- Prisma schema содержит три роли;
- существующие ADMIN memberships не теряются и становятся MEMBER;
- Workspace.status имеет default ACTIVE;
- migration применяется;
- prisma generate и backend build проходят.

## 9. Шаг 2. Permission matrix

Откройте раздел guide «Матрицу прав хранят как данные».

Создайте backend/src/access/permissions.ts:

- AccessAction: view, create, update, archive, delete;
- AccessResource: workspace, project, document;
- одна матрица для трёх ресурсов;
- assertAllowed выбрасывает ForbiddenException.

Перенесите значения строго из раздела «Зафиксированная матрица прав» этой задачи. Не распределяйте проверки по отдельным if в feature services.

Checkpoint:

- в проекте существует один источник role permissions;
- ADMIN не встречается в типах или матрице;
- VIEWER отсутствует во всех mutation permissions.

## 10. Шаг 3. AccessPolicyService как общий provider

Откройте разделы guide о provider, HTTP-политике и полной реализации policy.

Создайте AccessPolicyService с методами:

```ts
requireWorkspace(userId, workspaceId, action, resource?)
requireProject(userId, projectId, action, resource?)
requireDocument(userId, documentId, action)
```

Каждый метод должен:

1. найти ресурс;
2. определить workspaceId;
3. найти WorkspaceMember по составному ключу userId_workspaceId;
4. вернуть 404 при отсутствии ресурса или membership;
5. проверить permission;
6. вернуть найденный resource context.

Relation paths:

```text
Workspace: workspaceId
Project: Project.workspaceId
Document: Document -> Project -> workspaceId
```

Создайте AccessModule, объявите AccessPolicyService в providers и экспортируйте его.

Используйте существующий DI-pattern как ориентир:

```text
ProjectsModule exports ProjectsService
DocumentsModule imports ProjectsModule
DocumentsService получает ProjectsService через constructor
```

Новый pattern:

```text
AccessModule exports AccessPolicyService
WorkspacesModule, ProjectsModule и DocumentsModule импортируют AccessModule
Feature services получают AccessPolicyService через constructor
```

Не создавайте services через new. AccessPolicyService не читает request и JWT: controller передаёт request.user.sub в feature-service, а feature-service передаёт userId в policy.

Checkpoint:

- AppModule компилируется;
- Nest разрешает AccessPolicyService во всех трёх feature modules;
- policy является provider только AccessModule;
- feature controllers не запрашивают WorkspaceMember.

## 11. Шаг 4. Workspace vertical slice

Откройте раздел guide «Team: корневой vertical slice».

Создайте WorkspacesModule, controller, service и DTO.

DTO contracts:

- CreateWorkspaceDto принимает обязательный name после trim длиной 1–120;
- UpdateWorkspaceDto принимает optional name с теми же правилами;
- пустой update возвращает 400 по уже существующему pattern ProjectsService.

Порядок реализации:

1. POST /workspaces создаёт workspace и OWNER membership одним nested write.
2. GET /workspaces использует scoped Prisma query по members.some.userId.
3. GET /workspaces/:workspaceId использует policy view.
4. PATCH использует policy update.
5. PATCH /archive использует policy archive.
6. DELETE использует policy delete.
7. Подключите WorkspacesModule в AppModule.

Создание workspace является исключением: существующего membership ещё нет, поэтому достаточно JWT и атомарного создания OWNER.

Checkpoint:

- новый пользователь создаёт workspace и становится OWNER;
- MEMBER и VIEWER читают workspace;
- MEMBER и VIEWER получают 403 на update/archive/delete;
- outsider получает 404 по workspace ID;
- outsider видит пустой или ограниченный GET /workspaces.

## 12. Шаг 5. Projects через общий policy

Начните с существующих:

```text
backend/src/projects/projects.module.ts
backend/src/projects/projects.controller.ts
backend/src/projects/projects.service.ts
backend/src/projects/dto/create-project.dto.ts
backend/src/projects/dto/update-project.dto.ts
```

Не повторяйте project DTO и nested project create.

Выполните по порядку:

1. ProjectsModule импортирует AccessModule.
2. ProjectsService получает AccessPolicyService через constructor.
3. Существующий ensureProjectAccess заменяется policy.
4. GET /projects сохраняет scoped query и frontend response shape.
5. Добавьте GET /workspaces/:workspaceId/projects.
6. Existing POST /workspaces/:workspaceId/projects проверяет project/create через workspace context.
7. Existing PATCH проверяет project/update и сохраняет empty-update validation.
8. Добавьте PATCH /projects/:projectId/archive.
9. DELETE проверяет project/delete.

GET /workspaces/:workspaceId/projects сначала проверяет доступ к workspace, затем выбирает только project с указанным workspaceId.

Checkpoint:

- OWNER и MEMBER создают/изменяют/архивируют project;
- только OWNER удаляет project;
- VIEWER получает 403 на mutation;
- outsider получает 404 по project ID;
- GET /projects не содержит чужих projects;
- project list и detail продолжают открываться во frontend.

## 13. Шаг 6. Documents, DTO и relation path

Откройте раздел guide «Note: relation path и mass assignment».

Создайте:

- CreateDocumentDto: title после trim длиной 1–160 и content типа string;
- UpdateDocumentDto: optional title и content с теми же типами;
- проверку, что document update содержит хотя бы одно изменяемое поле.

Content может быть пустой строкой: это сохраняет существующий клиентский контракт.

Измените DocumentsController:

- используйте AuthenticatedRequest вместо any;
- примените JWT guard на уровне controller;
- используйте единое имя параметра documentId.

Измените DocumentsService:

1. Получите AccessPolicyService через constructor.
2. Удалите локальную ensureDocumentAccess.
3. List проверяет document/view через project context.
4. Create проверяет document/create через project context.
5. Get/update/archive/delete проверяют document по полному relation path.
6. Prisma create input собирается только из title, content, projectId из URL и authorId из JWT.
7. Prisma update input содержит только title и content.

После этого DocumentsService больше не нужен ProjectsService. Уберите ProjectsModule из DocumentsModule, если других потребителей нет, и импортируйте AccessModule.

Поля projectId, authorId, status и timestamps из body не должны попадать в Prisma input. При текущем whitelist они отбрасываются, а не вызывают 400.

Checkpoint:

- frontend создаёт document с payload title/content/status DRAFT;
- созданный document принадлежит project из URL;
- authorId принадлежит пользователю из JWT;
- GET document возвращает projectId, title и content;
- project detail сохраняет documents и author.name;
- outsider получает 404;
- VIEWER получает 403 на mutation.

## 14. Шаг 7. Archive endpoints

Добавьте отдельные endpoints:

- PATCH /workspaces/:workspaceId/archive;
- PATCH /projects/:projectId/archive;
- PATCH /documents/:documentId/archive.

Зафиксированная семантика:

- archive идемпотентно выставляет ARCHIVED;
- повторный archive возвращает ресурс со статусом ARCHIVED;
- archived resources остаются в list и доступны через detail;
- archive workspace не меняет status его projects/documents;
- archive project не меняет status documents;
- update и delete не блокируются текущим status;
- unarchive не входит в задачу;
- обычные PATCH не принимают status.

Checkpoint:

- status не меняется через обычный PATCH;
- OWNER архивирует любой ресурс;
- MEMBER архивирует project/document, но не workspace;
- VIEWER получает 403;
- outsider получает 404.

## 15. Шаг 8. Seed

Сохраните bcrypt, BCRYPT_ROUNDS и demo password password123.

Сделайте роли детерминированными:

- admin@example.com остаётся demo login frontend и получает OWNER;
- member@example.com получает MEMBER;
- viewer@example.com получает VIEWER;
- other@example.com является outsider без membership.

Не назначайте outsider создателем project или автором document.

Seed по-прежнему заполняет только пустую базу. Проверяйте его на fresh database: существующий early-exit не обновит старые данные.

Checkpoint:

- все demo passwords являются bcrypt hashes;
- admin@example.com входит с password123;
- в основном workspace представлены OWNER, MEMBER и VIEWER;
- other@example.com не видит его workspace/projects/documents.

## 16. Шаг 9. Изолированные e2e

Создайте backend/test/rbac.e2e-spec.ts. Не используйте seed как fixture.

В beforeAll создайте собственные данные:

- OWNER;
- MEMBER;
- VIEWER;
- outsider;
- основной workspace;
- чужой workspace;
- project и document в каждом scope.

Используйте отдельные IDs/email с префиксом task2 и удаляйте только эти данные.

Обязательные группы тестов:

1. Все защищённые routes возвращают 401 без JWT.
2. OWNER выполняет все действия.
3. MEMBER создаёт, изменяет и архивирует project/document, но не управляет workspace и не удаляет children.
4. VIEWER читает и получает 403 на mutation.
5. Outsider получает 404 для чужих workspace/project/document.
6. GET /workspaces и GET /projects не содержат чужих данных.
7. Nested project list содержит только указанный workspace.
8. projectId, workspaceId, authorId и createdById из body не меняют relation.
9. Обычный PATCH не меняет status.
10. Пустой workspace/document PATCH возвращает 400.
11. Повторный archive сохраняет ARCHIVED.
12. Frontend request и response shapes сохраняются.

Существующие семь e2e предыдущей задачи должны продолжать проходить.

## 17. Шаг 10. Документация и финальная проверка

Создайте docs/api/rbac.md:

- три роли и permission matrix;
- правило ADMIN -> MEMBER для migration;
- routes;
- 401/403/404;
- hidden 404;
- archive semantics;
- whitelist behavior;
- frontend compatibility.

README не изменяйте.

Выполните:

```bash
npm run format:check
npm run lint
npm run build
npm run test:e2e
```

Затем проверьте fresh seed, login admin@example.com / password123 и frontend:

1. список projects открывается и показывает document count;
2. project detail показывает documents и author;
3. document создаётся;
4. document открывается и сохраняется.

## Что не входит в задачу

- приглашения и управление memberships;
- изменение ролей через API;
- передача OWNER;
- ownership permissions;
- индивидуальные ACL;
- refresh tokens;
- permission guard;
- CASL или другая RBAC-библиотека;
- repository layer, CQRS, DDD или Clean Architecture;
- запрет операций над archived resources;
- unarchive.

## Критерии приёмки

- В WorkspaceRole остаются OWNER, MEMBER и VIEWER; ADMIN отсутствует.
- Migration преобразует существующий ADMIN в MEMBER без потери memberships.
- WorkspaceStatus добавлен versioned migration.
- Permission matrix совпадает с guide по уровням LEAD/EDITOR/READER.
- AccessPolicyService является provider AccessModule и используется через Nest DI.
- Workspace проверяется напрямую, project через workspaceId, document через project.
- Lists ограничиваются на уровне Prisma query.
- Создатель workspace получает OWNER.
- MEMBER и VIEWER получают ожидаемые 403.
- Outsider получает скрытый 404 и не видит чужие данные.
- Document DTO и explicit Prisma input защищают relations и service-managed поля.
- Пустые project/workspace/document updates возвращают 400.
- Archive semantics соответствуют зафиксированному контракту.
- ValidationPipe остаётся без forbidNonWhitelisted.
- Существующие frontend URL, payloads и response shapes сохранены.
- Seed содержит три роли и настоящего outsider с bcrypt password.
- Старые и новые e2e проходят вместе.
- Format check, lint и build проходят.
