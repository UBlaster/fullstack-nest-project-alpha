# Миграции базы данных в Workspace Docs

Эта инструкция объясняет, как в проекте работают Prisma, PostgreSQL и migrations.
Она рассчитана на разработчика, который хорошо знаком с frontend, но только начинает разбираться в backend.

## Короткая идея

В проекте есть три разных понятия:

- `schema.prisma` — описание того, как база должна выглядеть сейчас;
- migration — сохранённая инструкция, как перейти от старой структуры базы к новой;
- PostgreSQL — сама работающая база данных, в которой хранятся таблицы и данные.

Изменение только `schema.prisma` не изменяет PostgreSQL.
Чтобы изменить базу, нужно создать migration и применить её.

Пример:

```text
Изменили schema.prisma
        ↓
Создали migration.sql
        ↓
Prisma выполнила SQL в PostgreSQL
        ↓
База и код снова соответствуют друг другу
```

## Где находятся файлы

Основные файлы базы:

```text
backend/prisma/schema.prisma
backend/prisma/seed.ts
backend/prisma/migrations/
```

### `schema.prisma`

Файл `backend/prisma/schema.prisma` описывает модели приложения:

- `User` — пользователь;
- `Workspace` — рабочее пространство;
- `WorkspaceMember` — связь пользователя с workspace и его роль;
- `Project` — проект внутри workspace;
- `Document` — документ внутри проекта.

Например:

```prisma
model Project {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  description String?
}
```

Это означает, что у проекта есть обязательные `id`, `workspaceId` и `name`, а `description` может быть пустым.

Важно: `schema.prisma` — это не SQL-скрипт, который автоматически выполняется при каждом запуске приложения.
Это схема, на основе которой Prisma создаёт Prisma Client и новые migrations.

### `migrations`

Каждая папка внутри `backend/prisma/migrations` — отдельный шаг истории базы.

Сейчас в проекте есть:

```text
20260818000000_init/
  migration.sql

20260822190000_store_plain_password/
  migration.sql
```

Первая миграция создаёт основные таблицы, enum-значения, индексы и внешние ключи.

Вторая миграция переименовывает колонку `User.passwordHash` в `User.password`.
Она нужна, потому что история базы должна быть воспроизводимой с нуля:

```text
пустая база
  → создаётся passwordHash
  → passwordHash переименовывается в password
  → запускается seed
```

Старые migrations нельзя удалять или переписывать после того, как они были переданы другим разработчикам.
Если нужно новое изменение, создаётся новая migration.

### `seed.ts`

Файл `backend/prisma/seed.ts` заполняет базу демонстрационными данными:

- 4 пользователя;
- 3 workspace;
- участников workspace;
- проекты и документы.

Seed использует `upsert`, поэтому его можно запускать повторно без создания дублей.
Seed — это данные для разработки и проверки, а не замена migrations.

## Что происходит при запуске Docker

В `docker-compose.yml` есть сервис `db-init`:

```yaml
command: ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed"]
```

Порядок запуска:

```text
1. PostgreSQL запускается
2. PostgreSQL становится готовой принимать подключения
3. db-init выполняет prisma migrate deploy
4. db-init выполняет prisma db seed; seed добавляет демонстрационные данные только при отсутствии пользователей
5. backend запускается
```

Команда `prisma migrate deploy` применяет уже существующие migrations по порядку.
Она не создаёт новую migration из изменений в `schema.prisma`.

Команда seed запускается при каждом создании `db-init`, но сам скрипт сначала проверяет базу.
Если в ней уже есть хотя бы один пользователь, seed завершается без изменения существующих данных.

Поэтому простая пересборка Docker не заменяет создание migration.

## Правильный процесс изменения базы

Предположим, нужно добавить пользователю номер телефона.

### Шаг 1. Изменить `schema.prisma`

```prisma
model User {
  id    String @id @default(cuid())
  email String @unique
  name  String
  phone String?
}
```

### Шаг 2. Создать migration

Из папки `backend` выполнить:

```bash
npx prisma migrate dev --name add_phone_to_user
```

Prisma сравнит схему с базой, создаст новую папку и SQL примерно такого вида:

```sql
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
```

Обычно SQL пишет Prisma. При сложных изменениях migration можно проверить и аккуратно поправить вручную.

### Шаг 3. Проверить migration

Проверьте:

- что SQL делает ожидаемое изменение;
- что данные не удаляются случайно;
- что обязательное новое поле не ломает существующие строки;
- что при необходимости добавлено заполнение старых данных.

### Шаг 4. Запустить приложение

```bash
docker compose up --build
```

При запуске `db-init` применит новую migration через `prisma migrate deploy`.

### Шаг 5. Передать migration в Git

В Git должны попасть и схема, и история изменения:

```text
backend/prisma/schema.prisma
backend/prisma/migrations/<новая-папка>/migration.sql
```

## Команды Prisma

Команды выполняются из папки `backend`.

### Создать и применить migration во время разработки

```bash
npx prisma migrate dev --name describe_change
```

Используется разработчиком при изменении `schema.prisma`.

### Применить готовые migrations

```bash
npx prisma migrate deploy
```

Используется в Docker-сервисе `db-init` и подходит для установки проекта на новой базе или запуска подготовленного приложения.

### Запустить seed вручную

```bash
npx prisma db seed
```

### Перегенерировать Prisma Client

```bash
npx prisma generate
```

Обычно Prisma Client генерируется автоматически при установке зависимостей или во время migration-команд.

## Что будет, если просто пересобрать Docker

Если добавить поле в `schema.prisma`, но не создать migration, а затем выполнить:

```bash
docker compose up --build
```

то PostgreSQL не получит новую колонку.

Приложение и Prisma Client могут уже ожидать это поле, но в базе его не будет. При обращении к нему появится ошибка вроде:

```text
The column "phone" does not exist in the current database
```

Правильная последовательность:

```text
изменить schema.prisma
  → prisma migrate dev --name ...
  → проверить migration.sql
  → docker compose up --build
```

Перезапуск только backend:

```bash
docker compose restart backend
```

миграции не запускает, потому что сервис `db-init` при этом не выполняется.

## Новая установка проекта другим человеком

Новый разработчик должен:

1. склонировать репозиторий;
2. создать `.env` на основе `.env.example`;
3. запустить:

```bash
docker compose up --build
```

На чистой базе Prisma применит все migrations по порядку:

```text
init
  → store_plain_password
  → все последующие migrations
```

После этого seed создаст демонстрационные данные.

Пользователю не нужно вручную писать SQL и создавать таблицы.
Он должен получить весь каталог `backend/prisma/migrations` из репозитория.

## Что нельзя делать

### Не использовать `prisma db push` вместо migration

`db push` быстро меняет базу, но не создаёт нормальную историю изменений.
Для этого проекта изменения схемы делаются только через migrations.

### Не удалять старые migrations

Новая база должна уметь пройти всю историю с нуля.
Если удалить старый шаг, следующая migration может ссылаться на таблицу или колонку, которой больше нет.

### Не редактировать опубликованные migrations

Если migration уже применялась у другого разработчика, её нельзя исправлять задним числом.
Создайте новую migration.

### Не коммитить локальную базу и секреты

Не добавляйте в Git:

```text
.env
node_modules
dist
postgres-data
```

В репозитории должны находиться migrations, но не сами файлы PostgreSQL data.

## Полный сброс учебной базы

Обычная остановка контейнеров сохраняет данные:

```bash
docker compose down
```

Полный сброс удаляет PostgreSQL volume:

```bash
docker compose down -v
docker compose up --build
```

После этого база создастся заново, все migrations выполнятся с начала, а seed снова создаст демонстрационный набор данных.

## Главное правило

Запомните короткую формулу:

```text
schema.prisma — что хотим получить
migration — как перейти к этому состоянию
PostgreSQL — где реально лежат таблицы и данные
seed — какие тестовые данные положить в таблицы
Docker — как запустить весь процесс автоматически
```
