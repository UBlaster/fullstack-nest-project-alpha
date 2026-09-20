# Workspace Docs Starter

Учебный production-like modular monolith для изучения frontend- и backend-разработки. Приложение моделирует рабочие пространства, проекты и документы внутри них.

## Возможности

- регистрация и вход пользователя по JWT;
- рабочие пространства с участниками и ролями `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`;
- проекты и документы внутри workspace;
- workspace isolation для списков и прямого доступа к проектам и документам;
- демонстрационные данные для нескольких пользователей, workspace, проектов и документов.

Полный RBAC пока не реализован: роли сохранены в предметной модели как часть учебного проекта.

## Стек

- Node.js 20 LTS, npm;
- React 18.3, TypeScript, Vite, React Router;
- NestJS 10.4, Prisma 6.19;
- PostgreSQL 16;
- Redis 7;
- Docker Compose и Docker Dev Mode.

Архитектура backend: `Controller → Service → Prisma`.

## Что установить перед запуском

- [Docker Desktop](https://docs.docker.com/desktop/) — обязателен. Он устанавливает Docker Engine и
  Docker Compose, в которых запускаются все сервисы проекта. Инструкции для
  [Windows](https://docs.docker.com/desktop/setup/install/windows-install/),
  [macOS](https://docs.docker.com/desktop/setup/install/mac-install/) и
  [Linux](https://docs.docker.com/desktop/setup/install/linux/).
- [DBeaver Community](https://dbeaver.io/download/) — установите для просмотра и ручной
  проверки PostgreSQL в учебных заданиях. DBeaver не участвует в запуске приложения,
  поэтому для самого запуска он не обязателен.

Отдельно устанавливать Node.js, npm, PostgreSQL и Redis не нужно: нужные версии уже заданы
в Docker-образах проекта.

Перед запуском проверьте, что Docker Desktop запущен и команды доступны:

```bash
docker --version
docker compose version
```

## Запуск

Создайте корневой `.env` из примера:

```bash
cp .env.example .env
```

В PowerShell:

```powershell
Copy-Item .env.example .env
```

Запустите dev-окружение:

```bash
docker compose up --build
```

Для фонового запуска используйте `docker compose up --build -d`.

Compose запускает frontend, backend, PostgreSQL и служебный `db-init`, который применяет migrations и добавляет seed-данные только в пустую базу. При последующих запусках Docker существующие данные не перезаписываются. Для работы приложения локальные `node_modules` не требуются.

Адреса сервисов:

- Frontend: http://localhost:5173
- API: http://localhost:3000
- Swagger: http://localhost:3000/api/docs
- Health check: http://localhost:3000/health

После изменений исходников dev-сервисы используют hot reload. Пересборка обычно нужна после изменения Dockerfile или зависимостей.

Остановить окружение: `docker compose down`.

## Демонстрационные пользователи

Все пользователи seed используют пароль `password123`:

- `admin@example.com`
- `member@example.com`
- `viewer@example.com`
- `other@example.com`

## Проверка

E2E-сценарии авторизации запускаются внутри backend-контейнера:

```bash
docker compose exec backend npm run test:e2e
```

Для проверки конфигурации и состояния окружения:

```bash
docker compose config
docker compose ps
```

## База данных

Схема описана в `backend/prisma/schema.prisma`, а seed — в `backend/prisma/seed.ts`. Изменения структуры базы выполняются через Prisma migrations. Подробная инструкция находится в [DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md).

Параметры подключения DBeaver к локальной базе после запуска Compose:

- тип базы: PostgreSQL;
- host: `localhost`;
- port: `5432`;
- database: `workspace_docs`;
- username: `app`;
- password: `app`.

Эти параметры соответствуют значениям из корневого `.env.example`.

Не коммитьте `.env`, secrets, `node_modules`, `dist` и данные PostgreSQL.

## Разработка

Основные правила проекта и актуальный контекст находятся в [`project-context.mdc`](.cursor/rules/project-context.mdc). Этот файл является источником правды для архитектуры, окружения и ограничений проекта.

Во всех текстовых файлах проекта необходимо использовать окончания строк **LF**. Формат **CRLF** не допускается, в том числе при работе на Windows. Правило закреплено в `.gitattributes`, а конфигурации Prettier для frontend и backend используют `endOfLine: "lf"`.
