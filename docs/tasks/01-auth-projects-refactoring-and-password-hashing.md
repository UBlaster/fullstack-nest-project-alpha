# Задача 1. Рефакторинг auth/projects и безопасные пароли

> [!summary] Результат
> Auth и projects разделены на понятные NestJS-модули, вход и регистрация используют хеши паролей, входные данные проходят DTO-валидацию, а поведение подтверждено e2e-тестами.

## Исходное состояние

- `auth.ts` и `resources.ts` содержат сразу controller, service и DTO нескольких функций.
- Пароль сравнивается с открытым значением из БД.
- В project endpoints используется `any`.
- При создании проекта workspace выбирается через первый найденный membership.
- Глобальный `ValidationPipe` уже включён.

## Сначала разберитесь с терминами

- **DTO (Data Transfer Object)** — класс, описывающий допустимое тело HTTP-запроса. В отличие от TypeScript interface, DTO существует во время работы приложения, поэтому `class-validator` может вернуть `400` до входа в service.
- **Hash пароля** — необратимый результат медленной функции. Мы не расшифровываем его, а вызываем `bcrypt.compare(candidate, storedHash)`.
- **Dependency Injection (DI)** — Nest сам создаёт service и передаёт его в constructor. Поэтому в коде не должно быть `new AuthService(...)`.
- **E2E-тест** — тест, который поднимает настоящий Nest application и вызывает endpoint через HTTP (`supertest`).

Эти определения используются в следующих задачах без повторного объяснения.

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

DTO проекта должен быть настоящим классом:

```ts
export class CreateProjectDto {
	@IsString()
	@Length(1, 120)
	name!: string;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	description?: string;
}
```

В `RegisterDto` проверяйте confirmation отдельным validator или явно в service. В Prisma передавайте только разрешённые поля:

```ts
const passwordHash = await bcrypt.hash(dto.password, this.hashRounds);

const user = await this.prisma.user.create({
	data: {
		email: dto.email.toLowerCase(),
		name: dto.name,
		password: passwordHash,
	},
	select: { id: true, email: true, name: true },
});
```

`passwordConfirmation` здесь намеренно отсутствует. Login меняется с текущего `user.password !== dto.password` на:

```ts
const passwordMatches = user
	? await bcrypt.compare(dto.password, user.password)
	: false;

if (!user || !passwordMatches) {
	throw new UnauthorizedException('Invalid credentials');
}
```

Workspace при создании project берётся из URL:

```ts
@Post('workspaces/:workspaceId/projects')
create(
	@Param('workspaceId') workspaceId: string,
	@Body() dto: CreateProjectDto,
	@Req() request: AuthenticatedRequest,
) {
	return this.projectsService.create(request.user.sub, workspaceId, dto);
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

## Порядок реализации

1. Разнести auth и projects по отдельным NestJS-модулям и подключить их в `AppModule`.
2. Добавить bcrypt и env-переменную в `.env.example`/Compose.
3. При регистрации проверить уникальность email, захешировать пароль и явно собрать Prisma `data`.
4. При login сначала найти пользователя, затем выполнить `bcrypt.compare`. Для неизвестного email и неверного пароля вернуть одинаковый `401 Invalid credentials`.
5. Обновить seed: хешировать `password123`; повторный seed остаётся идемпотентным.
6. Заменить `any` в project controller/service на DTO и тип пользователя request.
7. Исправить создание project: использовать `workspaceId` URL после проверки membership.
8. Реализовать удаление текущего аккаунта с проверкой пароля и описанным `409`.

После каждого шага запускайте соответствующий узкий тест. Не переносите весь файл и только затем пытайтесь исправить десятки ошибок.

> [!warning] Миграции
> Поле `User.password` уже имеет тип `String`, подходящий для bcrypt hash. Если Prisma schema не меняется, пустую migration создавать нельзя. Опубликованные migrations не редактировать.

## Тесты

- регистрация создаёт пользователя и не хранит исходный пароль;
- `passwordConfirmation` не попадает в БД;
- duplicate email — `409`, невалидные DTO — `400`;
- login работает для нового пользователя и всех seed-пользователей с `password123`;
- неизвестный email и неверный пароль дают одинаковый `401`;
- удаление с неверным паролем — `401`, с зависимыми audit-записями — `409`, допустимое удаление — `204`;
- create/update/delete project используют валидные DTO и явный workspace;
- пользователь без membership не создаёт project;
- существующие auth e2e-сценарии продолжают проходить.

## Документация и проверка

- Создать `docs/api/01-auth-and-projects.md`: endpoints, DTO, коды ошибок и env.
- Выполнить `format:check`, `lint`, `build`, `test:e2e`.
- Проверить seed и login в Docker Compose.

## Не входит в задачу

Refresh tokens, восстановление пароля, email verification, OAuth, repository abstraction и RBAC ролей.

## Критерии приёмки

- В коде нет прямого сравнения паролей и `any` в изменённых endpoints.
- В БД и seed находятся bcrypt hashes, но demo-пароль остаётся `password123`.
- Workspace проекта всегда задан URL и проверен.
- DTO отсекают служебные и неизвестные поля.
- Все перечисленные тесты и Docker-запуск проходят.
