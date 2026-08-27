# RBAC и изоляция данных

Доступ к workspace, project и document определяется membership и ролью `WorkspaceMember.role` в том workspace, которому принадлежит ресурс. JWT подтверждает личность; роль не кладётся в токен и проверяется на каждый запрос.

`createdById` проекта и `authorId` документа — данные аудита. Они не дают дополнительных прав.

## Матрица ролей

| Ресурс и действие | OWNER | ADMIN | MEMBER | VIEWER |
| --- | :---: | :---: | :---: | :---: |
| Создать новый workspace | да | да | да | да |
| Просмотреть workspace | да | да | да | да |
| Изменить workspace | да | да | нет | нет |
| Архивировать workspace | да | нет | нет | нет |
| Удалить workspace | да | нет | нет | нет |
| Просмотреть project | да | да | да | да |
| Создать project | да | да | да | нет |
| Изменить project | да | да | да | нет |
| Архивировать project | да | да | да | нет |
| Удалить project | да | да | нет | нет |
| Просмотреть document | да | да | да | да |
| Создать document | да | да | да | нет |
| Изменить document | да | да | да | нет |
| Архивировать document | да | да | да | нет |
| Удалить document | да | да | нет | нет |

Создать workspace может любой аутентифицированный пользователь, в том числе без membership. Автор сразу получает роль `OWNER`.

`MEMBER` может изменять любой project и document внутри своего workspace, не только свои записи.

## Политика HTTP-ответов

- `401 Unauthorized` — JWT отсутствует или невалиден.
- `404 Not Found` — ресурс не существует **или** пользователь не состоит в его workspace.
- `403 Forbidden` — пользователь состоит в workspace, ресурс найден, но роль не разрешает действие.
- `400 Bad Request` — тело запроса не прошло валидацию.

Outsider не должен по разнице `403` и `404` понять, существует ли чужой ресурс. Участник с недостаточной ролью получает `403`.

Цепочка проверки: ресурс → membership именно этого workspace → роль. Для document путь такой: `Document → Project → workspaceId → WorkspaceMember`.

Списки сразу ограничиваются доступным scope в запросе к БД: outsider видит пустой массив, а не ошибку по каждой строке.

## Архивация

`status` меняют только отдельные endpoint:

- `PATCH /workspaces/:workspaceId/archive`
- `PATCH /projects/:projectId/archive`
- `PATCH /documents/:documentId/archive`

Обычные `PATCH` не принимают поле `status`. Через них нельзя обойти право `archive`.

## Relation IDs

`workspaceId`, `projectId`, `authorId` и `createdById` берутся из URL и JWT. Значения из body при create/update игнорируются.
