# Задача 1. Рефакторинг auth/projects и безопасные пароли

> [!summary] Результат
> Auth и projects разделены на понятные NestJS-модули, вход и регистрация используют хеши паролей, входные данные проходят DTO-валидацию, а поведение подтверждено e2e-тестами.

## Исходное состояние

- `auth.ts` и `resources.ts` содержат сразу controller, service и DTO нескольких функций.
- Пароль сравнивается с открытым значением из БД.
- В project endpoints используется `any`.
- При создании проекта workspace выбирается через первый найденный membership.
- Глобальный `ValidationPipe` уже включён.

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

