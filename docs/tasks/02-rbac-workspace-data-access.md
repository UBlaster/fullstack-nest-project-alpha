# Задача 2. RBAC и изоляция данных workspace

> [!summary] Результат
> Workspace, projects и documents защищены единой матрицей ролей, outsider не видит чужие данные, а различие `403/404` работает одинаково во всех endpoints.

> [!note] Связанный материал
> См. [памятку к задаче 2](../guides/02-rbac-and-data-isolation-primer.md).

## Зачем нужна эта задача

Сейчас JWT защищает API от неавторизованных запросов, а отдельные методы проверяют membership. Этого недостаточно:

- роль участника workspace не влияет на разрешённые действия;
- проверки проектов и документов продублированы и обходятся разными способами;
- при создании проекта выбирается первый workspace пользователя, хотя пользователь может состоять в нескольких;
- API workspace пока отсутствует;
- seed не содержит настоящего outsider: сейчас каждый seed-пользователь состоит в каждом workspace;
- изоляция данных между workspace не гарантируется единым механизмом.

Цель задачи — сделать один понятный механизм проверки доступа и применить его ко всем операциям с workspace, project и document.

## Зафиксированная матрица прав

Роль пользователя берётся из `WorkspaceMember.role` того workspace, которому принадлежит ресурс.

| Ресурс и действие        | OWNER | ADMIN | MEMBER | VIEWER |
| ------------------------ | :---: | :---: | :----: | :----: |
| Создать новый workspace¹ |  ✅   |  ✅   |   ✅   |   ✅   |
| Просмотреть workspace    |  ✅   |  ✅   |   ✅   |   ✅   |
| Изменить workspace       |  ✅   |  ✅   |   ❌   |   ❌   |
| Архивировать workspace   |  ✅   |  ❌   |   ❌   |   ❌   |
| Удалить workspace        |  ✅   |  ❌   |   ❌   |   ❌   |
| Просмотреть project      |  ✅   |  ✅   |   ✅   |   ✅   |
| Создать project          |  ✅   |  ✅   |   ✅   |   ❌   |
| Изменить project         |  ✅   |  ✅   |   ✅   |   ❌   |
| Архивировать project     |  ✅   |  ✅   |   ✅   |   ❌   |
| Удалить project          |  ✅   |  ✅   |   ❌   |   ❌   |
| Просмотреть document     |  ✅   |  ✅   |   ✅   |   ✅   |
| Создать document         |  ✅   |  ✅   |   ✅   |   ❌   |
| Изменить document        |  ✅   |  ✅   |   ✅   |   ❌   |
| Архивировать document    |  ✅   |  ✅   |   ✅   |   ❌   |
| Удалить document         |  ✅   |  ✅   |   ❌   |   ❌   |

¹ Роль в существующем workspace для этого действия не используется. Создать новый workspace может также аутентифицированный пользователь без единого membership.

Создание workspace должно одновременно создать membership с ролью `OWNER` для автора.

В рамках этой задачи `MEMBER` может изменять любой project и document внутри своего workspace, а не только созданные им записи. Если нужны права «только автор документа», это отдельное изменение модели доступа и отдельная задача.

## Политика HTTP-ответов

Эта политика обязательна и должна одинаково работать во всех контроллерах:

- `401 Unauthorized` — JWT отсутствует или невалиден;
- `404 Not Found` — ресурс не существует **или** пользователь не состоит в workspace ресурса;
- `403 Forbidden` — пользователь состоит в workspace, ресурс найден, но его роль не разрешает действие;
- `400 Bad Request` — тело запроса или значение enum не прошло валидацию.

Смысл скрытого `404`: outsider не должен по разнице между `403` и `404` определить, существует ли чужой project/document.

Для вложенного URL необходимо проверить всю цепочку. Например, запрос документа через project допустим только тогда, когда document действительно принадлежит указанному project, а project — доступному пользователю workspace.

## Ожидаемый API

Нужно реализовать или привести к единому поведению следующие операции:

- `GET /workspaces` — список workspace текущего пользователя;
- `POST /workspaces` — создать workspace и membership `OWNER`;
- `GET /workspaces/:workspaceId`;
- `PATCH /workspaces/:workspaceId`;
- `PATCH /workspaces/:workspaceId/archive`;
- `DELETE /workspaces/:workspaceId`;
- `GET /workspaces/:workspaceId/projects`;
- `POST /workspaces/:workspaceId/projects`;
- `GET /projects/:projectId`;
- `PATCH /projects/:projectId`;
- `PATCH /projects/:projectId/archive`;
- `DELETE /projects/:projectId`;
- `GET /projects/:projectId/documents`;
- `POST /projects/:projectId/documents`;
- `GET /documents/:documentId`;
- `PATCH /documents/:documentId`;
- `PATCH /documents/:documentId/archive`;
- `DELETE /documents/:documentId`.

Архивирование выполняется только отдельными endpoint `PATCH /.../:id/archive`. Они изменяют `status` ресурса на `ARCHIVED` и проверяют permission `archive`. Обычные update endpoint не принимают поле `status`, поэтому через них нельзя обойти отдельное право на архивирование.

Для workspace сейчас нет статуса, поэтому нужно добавить `WorkspaceStatus` со значениями `ACTIVE` и `ARCHIVED`, поле `Workspace.status` с default `ACTIVE` и Prisma migration.

Старый `GET /projects` используется frontend, поэтому его нужно сохранить. Он возвращает общий список проектов из всех workspace, в которых состоит текущий пользователь. Новый `GET /workspaces/:workspaceId/projects` возвращает проекты только указанного доступного workspace. Оба списка обязаны исключать чужие проекты.

## Требования к общему механизму доступа

Создайте injectable-сервис `AccessPolicyService`, который:

1. получает пользователя из уже проверенного JWT;
2. находит workspace-контекст ресурса;
3. проверяет membership;
4. проверяет роль по матрице;
5. возвращает найденный ресурс или контекст либо выбрасывает `NotFoundException`/`ForbiddenException` по зафиксированной выше HTTP-политике.

`AccessPolicyService` должен вызываться из feature-сервисов через Nest dependency injection. JWT-аутентификация остаётся в существующем `AuthGuard('jwt')`; отдельный permission guard и внешняя RBAC-библиотека в этой задаче не нужны.

Контроллеры не должны вручную запрашивать `WorkspaceMember`. Сервисы проектов и документов не должны создавать друг друга через `new` и обращаться к приватным методам через квадратные скобки. Правила ролей должны храниться в одном месте, а не в нескольких `if` по всему проекту.

Проверка relation path:

- workspace проверяется напрямую по `workspaceId`;
- project — через `Project.workspaceId`;
- document — через `Document -> Project -> workspaceId`;
- вложенный document list/create сначала проверяет доступ к указанному project;
- ID из body не должен позволять перенести ресурс в чужой workspace/project в обход policy.

## Привязка к текущему коду

Сейчас проблемные места находятся в `backend/src/resources.ts`:

- `ensureProjectAccess` и `ensureDocumentAccess` повторяют membership query;
- `DocumentsService` вызывает `new ProjectsService(this.prisma)['ensureProjectAccess'](...)` и обходит DI/private;
- проверки разрешают любое действие любой роли;
- workspace controller/service отсутствуют;
- `data: { ...data }` позволяет передать служебные поля;
- seed добавляет каждого пользователя во все три workspace, поэтому `other@example.com` не является outsider.

Разнесите код в `workspaces/`, `projects/`, `documents/` и общий `access/`:

```text
backend/src/access/access-policy.service.ts
backend/src/access/permissions.ts
backend/src/workspaces/...
backend/src/projects/...
backend/src/documents/...
```

## Опорный код policy

Правила должны читаться как данные, а не как десятки несвязанных `if`:

```ts
export type AccessAction = 'view' | 'create' | 'update' | 'archive' | 'delete';
export type AccessResource = 'workspace' | 'project' | 'document';

const projectPermissions: Record<AccessAction, WorkspaceRole[]> = {
	view: ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
	create: ['OWNER', 'ADMIN', 'MEMBER'],
	update: ['OWNER', 'ADMIN', 'MEMBER'],
	archive: ['OWNER', 'ADMIN', 'MEMBER'],
	delete: ['OWNER', 'ADMIN'],
};
```

Проверка project должна соблюдать порядок `ресурс -> membership -> роль`. Реализуйте методы без готового кода из task:

```ts
export class AccessPolicyService {
	// requireWorkspace(userId, workspaceId, action)
	// requireProject(userId, projectId, action)
	// requireDocument(userId, documentId, action)
	// Во всех методах применить единую политику 404/403.
}
```

Document загружайте вместе с relation, нужным для workspace check:

```text
Document -> Project -> workspaceId -> WorkspaceMember
```

Create собирайте явно: `{ title: dto.title, content: dto.content, projectId, authorId: userId }`. `projectId` и `authorId` из body не принимать.

Создать отдельный документ `docs/api/rbac.md` и описать в нём матрицу ролей и политику `401/403/404`. README в рамках этой задачи не изменять. Существующий frontend должен продолжить работать через сохранённые `GET /projects`, `GET /projects/:projectId`, `GET /documents/:documentId` и document endpoints.

## Что не входит в задачу

- приглашения в workspace и управление участниками;
- передача роли `OWNER` другому пользователю;
- индивидуальные ACL для отдельного project/document;
- правило «редактировать только собственный document»;
- refresh tokens и изменение механизма логина;
- подключение CASL или другой внешней authorization-библиотеки.

## Критерии приёмки

- Матрица прав находится в документации и соответствует реализации.
- Все четыре роли сохраняют существующие названия Prisma enum.
- Создатель workspace становится его `OWNER`.
- Для list/get/create/update/archive/delete используется единый policy/service.
- Project проверяется через workspace, document — через project и workspace.
- Outsider получает `404` и не видит чужие ресурсы в списках.
- Участник workspace с недостаточными правами получает `403`.
- Нет создания `ProjectsService`/`DocumentsService` вручную через `new`.
- Prisma schema, migration, seed и документация обновлены.
- Backend проходит format check, lint и build.
