# Задача 1. Рефакторинг auth/projects и безопасные пароли

> [!summary] Результат
> Auth и projects разделены на понятные NestJS-модули, вход и регистрация используют хеши паролей, а входные данные проходят DTO-валидацию.

> [!note] Связанный материал
> См. [памятку к задаче 1](../guides/01-password-hashing-dto-and-module-boundaries-primer.md).

## Исходное состояние

- `auth.ts` и `resources.ts` содержат сразу controller, service и DTO нескольких функций.
- Пароль сравнивается с открытым значением из БД.
- В project endpoints используется `any`.
- При создании проекта workspace выбирается через первый найденный membership.
- Глобальный `ValidationPipe` уже включён.

## Какие файлы должны получиться

```text
backend/src/auth/auth.module.ts
backend/src/auth/auth.controller.ts
backend/src/auth/auth.service.ts
backend/src/auth/jwt.strategy.ts
backend/src/auth/dto/login.dto.ts
backend/src/auth/dto/register.dto.ts
backend/src/auth/dto/delete-account.dto.ts
backend/src/projects/projects.module.ts
backend/src/projects/projects.controller.ts
backend/src/projects/projects.service.ts
backend/src/projects/dto/create-project.dto.ts
backend/src/projects/dto/update-project.dto.ts
```

Удалите старые определения из `backend/src/auth.ts` и `backend/src/resources.ts` только после подключения новых modules в `backend/src/app.module.ts`. Documents временно могут остаться в `resources.ts` до задачи №2.

## Опорная реализация

DTO проекта должен быть настоящим классом. Реализуйте validators согласно разделу «Требования к DTO»:

```ts
export class CreateProjectDto {
	// name: обязательная строка с установленными границами длины
	// description: необязательная строка с максимальной длиной
}
```

В `RegisterDto` проверяйте confirmation, а в Prisma передавайте только разрешённые поля. Подробный пример находится в памятке №1.

```ts
export class AuthService {
	// register(): проверить confirmation, нормализовать email,
	// захешировать пароль и сохранить только разрешённые поля
	// login(): сравнить пароль через bcrypt и выдать JWT
}
```

`passwordConfirmation` не должно попадать в Prisma `data`. Текущее прямое сравнение пароля необходимо заменить вызовом bcrypt:

```ts
const passwordMatches = await bcrypt.compare(/* введённый пароль */, /* hash из БД */);
```

Workspace при создании project берётся из URL:

```ts
@Post('workspaces/:workspaceId/projects')
create(
	@Param('workspaceId') workspaceId: string,
	@Body() dto: CreateProjectDto,
	@Req() request: AuthenticatedRequest,
) {
	// Передать userId, workspaceId и валидированный DTO в service.
}
```

В service нельзя оставлять текущий `findFirst({ where: { userId } })`: он выбирает случайный workspace пользователя. Ищите составной ключ `userId_workspaceId`.

## Зафиксированные решения

- Использовать `bcrypt` с параметром `BCRYPT_ROUNDS` из env; для локальной разработки default — `12`.
- Сохранить текущую архитектуру `Controller -> Service -> PrismaService`. Отдельный repository layer не добавлять.
- Создать папки `auth/` и `projects/` с module, controller, service и `dto/`.
- Добавить `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `DELETE /auth/me`.
- `POST /auth/register` принимает `email`, `name`, `password`, `passwordConfirmation`. Confirmation проверяется DTO/custom validator и никогда не записывается в БД.
- `DELETE /auth/me` принимает `currentPassword`. Если у пользователя есть созданные projects/documents, вернуть `409 Conflict`; иначе удалить memberships и пользователя одной транзакцией.
- Project создаётся только через `POST /workspaces/:workspaceId/projects`. Workspace не выбирается автоматически.

## Требования к DTO

- `RegisterDto`: валидный email, непустое имя длиной 2–100, пароль длиной 8–72, совпадающий `passwordConfirmation`.
- `LoginDto`: email и непустой пароль.
- `DeleteAccountDto`: непустой `currentPassword`.
- `CreateProjectDto`: name длиной 1–120, optional description до 2000 символов.
- `UpdateProjectDto`: те же изменяемые поля, но optional; пустой body получает `400`.
- Поля `workspaceId`, `createdById`, `status`, timestamps и неизвестные поля не должны попадать в Prisma `data`.

> [!warning] Миграции
> Поле `User.password` уже имеет тип `String`, подходящий для bcrypt hash. Если Prisma schema не меняется, пустую migration создавать нельзя. Опубликованные migrations не редактировать.

## Документация и проверка

- Создать `docs/api/01-auth-and-projects.md`: endpoints, DTO, коды ошибок и env.
- Выполнить `format:check`, `lint` и `build`.
- Проверить seed и login в Docker Compose.

## Не входит в задачу

Refresh tokens, восстановление пароля, email verification, OAuth, repository abstraction и RBAC ролей.

## Критерии приёмки

- В коде нет прямого сравнения паролей и `any` в изменённых endpoints.
- В БД и seed находятся bcrypt hashes, но demo-пароль остаётся `password123`.
- Workspace проекта всегда задан URL и проверен.
- DTO отсекают служебные и неизвестные поля.
- Регистрация, login, удаление аккаунта и project endpoints работают по зафиксированным HTTP-контрактам.
- Backend запускается в Docker Compose.
