# Auth и project API после задачи 1

## Переменные окружения

- `JWT_SECRET` — секрет подписи JWT.
- `JWT_EXPIRES_IN` — срок действия access token.
- `BCRYPT_ROUNDS` — cost bcrypt; для локальной разработки используется `12`.

Seed создаёт bcrypt hashes только при заполнении пустой базы. Если локальный PostgreSQL volume
был создан до выполнения этой задачи и содержит открытые demo-пароли, пересборка контейнера их
не заменит: seed намеренно пропускает непустую базу. Для проверки fresh seed используйте отдельную
тестовую базу или осознанно пересоздайте локальный учебный volume.

## Auth

### `POST /auth/register`

Принимает `email`, `name`, `password`, `passwordConfirmation`.

- `201` — пользователь создан; password и confirmation не возвращаются.
- `400` — DTO не прошёл валидацию или пароли не совпадают.
- `409` — email уже зарегистрирован.

### `POST /auth/login`

Принимает `email` и `password`. Возвращает access token и безопасные поля пользователя.
Неизвестный email и неверный пароль возвращают одинаковый `401`.

### `GET /auth/me`

Требует Bearer token и возвращает текущего пользователя без password.

### `DELETE /auth/me`

Требует Bearer token и body с `currentPassword`.

- `200` — memberships и пользователь удалены транзакционно.
- `401` — current password неверен.
- `409` — пользователь является создателем project или автором document.

## Projects

Все endpoints требуют Bearer token.

- `GET /projects` — проекты из workspace текущего пользователя.
- `GET /projects/:projectId` — доступный project вместе с documents.
- `POST /workspaces/:workspaceId/projects` — создаёт project в явно указанном workspace.
- `PATCH /projects/:projectId` — изменяет `name` и/или `description`; пустой body возвращает `400`.
- `DELETE /projects/:projectId` — удаляет доступный project.

Create DTO принимает `name` длиной 1–120 и optional `description` до 2000 символов.
Update DTO принимает те же поля как optional. Поля `workspaceId`, `createdById`, `status`,
timestamps и неизвестные поля не передаются в Prisma.

Project или workspace, недоступный текущему пользователю, возвращает `404`.
