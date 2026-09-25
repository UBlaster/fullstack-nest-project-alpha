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

- Node.js 20 в Docker-образах, npm;
- React 18.3, TypeScript, Vite, React Router;
- NestJS 10.4, Prisma 6.19;
- PostgreSQL 16;
- Docker Desktop и Docker Compose.

Архитектура backend: `Controller → Service → Prisma`.

## Как устроена разработка

Основной сценарий для Windows и macOS: открываете локальную папку проекта в редакторе,
а frontend, backend и PostgreSQL запускаете через Docker Compose.

- На компьютере Node.js и npm устанавливают `backend/node_modules` и `frontend/node_modules`
  для TypeScript, автодополнения и инструментов редактора.
- В контейнерах приложений находятся отдельные Node.js 20 и `/app/node_modules`.
  Dockerfile устанавливают зависимости командой `npm install` при сборке образов.
- Compose подключает локальные `backend/src` и `frontend/src` в `/app/src` соответствующих
  контейнеров. Сохраняете исходник — NestJS пересобирает backend, Vite обновляет frontend.
  Для отслеживания изменений настроен polling; у Vite интервал 800 мс.
- Локальные `node_modules` не смонтированы в контейнеры приложений. Переключение версии через
  nvm меняет Node.js в локальном терминале, но не версию Node.js внутри Docker.

Поэтому локальный Node.js 22 и Node.js 20 в Docker могут использоваться одновременно.
Это не означает, что код «написан на Node 20»: версия среды запуска задана в Dockerfile.
Корневой `npm run dev` — обёртка над `docker compose up --build`; локальный Node ей нужен
для запуска npm. Саму команду `docker compose` можно выполнить без локального Node.js.

### Разработка через Dev Container

В `.devcontainer/devcontainer.json` предусмотрено подключение редактора к сервису `workspace`.
В нём есть Node.js 20 и Git, а весь checkout доступен в `/workspace`. Приложения при этом всё
равно работают в отдельных сервисах `backend` и `frontend`.

Текущая конфигурация не устанавливает зависимости для редактора в `workspace` и не подключает
туда `/app/node_modules` из сервисов приложений. Само открытие Dev Container не решает вопрос
отсутствующих типов. Кроме того, `/workspace` — общая с компьютером папка: установленный туда
`node_modules` будет виден на хосте. Не смешивайте зависимости разных ОС в одной папке.
В инструкции ниже используется локальный редактор на обеих ОС; Dev Container настраивать не нужно.

## Что установить на компьютер

- [Git](https://git-scm.com/downloads/) — для клонирования своего форка и работы с ветками.
- [Docker Desktop](https://docs.docker.com/desktop/) — используем приложение с UI для просмотра
  контейнеров, логов, образов и volumes. Docker CLI и Compose входят в комплект.
- [Node.js 22.x с npm](https://nodejs.org/en/download) — для локальных зависимостей редактора.
  Выберите последний patch-релиз ветки 22.x; ESLint из lock-файлов требует в этой ветке
  как минимум 22.13.0. Если Node 22 уже выбран через nvm, переключаться на 20 не требуется.
- Редактор, установленный локально на Windows/macOS.
- [DBeaver Community](https://dbeaver.io/download/) — для просмотра PostgreSQL в учебных заданиях;
  для запуска приложения этот GUI-клиент не обязателен.

PostgreSQL отдельно не устанавливайте: его запускает Compose. Redis в стартовом `master`
отсутствует. [Redis Insight](https://redis.io/insight/) — GUI для ключей и данных Redis;
он понадобится в заданиях, где появляется Redis, а для начального запуска не нужен.

Docker-образы проекта пока используют Node.js 20. На дату проверки, 21 сентября 2026 года,
эта версия уже [снята с поддержки](https://nodejs.org/en/about/previous-releases).
Обновление среды контейнеров требует отдельной проверки проекта; локальная установка Node 22
сама по себе не обновляет Docker-образы.

### Windows: подготовка

1. Проверьте «Диспетчер задач → Производительность → ЦП → Виртуализация».
   Если она отключена, включите Intel VT-x / Virtualization Technology или AMD SVM / AMD-V
   в BIOS/UEFI по инструкции производителя компьютера. Если уже включена, менять BIOS не нужно.
2. Для этого сценария используйте Docker Desktop с WSL 2 backend. Установите WSL из PowerShell
   с правами администратора, если его ещё нет:

   ```powershell
   wsl --install --no-distribution
   ```

   Перезагрузитесь по запросу установщика. Затем обновите и проверьте WSL:

   ```powershell
   wsl --update
   wsl --version
   ```

   Docker требует WSL не ниже 2.1.5. Команда с `--no-distribution` не устанавливает Ubuntu:
   для работы Docker из PowerShell отдельный пользовательский Linux-дистрибутив не нужен.
   См. [команды WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).
3. Установите и запустите [Docker Desktop для Windows](https://docs.docker.com/desktop/setup/install/windows-install/).
   Используйте Linux containers и WSL 2 engine (Settings → General, если настройка отображается).
   Docker допускает и другие backend, но здесь описан только сценарий с WSL 2.
4. Установите Git и Node.js из списка выше. Откройте новый обычный PowerShell и локальный редактор.
   Храните проект, например, в `C:\projects\nest-fullstack-project`. Работа через Remote WSL
   и перенос checkout в Linux для этой инструкции не требуются.

Официальные требования Windows и оборудования приведены на странице установки Docker.
[Документация Docker о WSL 2](https://docs.docker.com/desktop/features/wsl/) описывает запуск
Docker непосредственно из Windows-терминала.

### macOS: подготовка

1. Установите [Docker Desktop для macOS](https://docs.docker.com/desktop/setup/install/mac-install/):
   вариант Apple Silicon для Mac с чипами M-серии, Intel — для Intel Mac.
2. Запустите Docker Desktop из Applications и завершите первоначальную настройку.
   WSL на macOS не используется; включать виртуализацию через BIOS не требуется.
3. Установите Git, Node.js и редактор из общего списка. Откройте обычный Terminal
   и локальную папку проекта в редакторе.

Дальнейшие действия одинаковы для Windows и macOS, кроме команды копирования `.env`.

## Первый запуск: общие шаги

1. Создайте свой fork на GitHub, затем клонируйте его. Замените URL в кавычках на адрес своего форка:

   ```bash
   git clone "https://github.com/YOUR_LOGIN/fullstack-nest-project-alpha.git" nest-fullstack-project
   cd nest-fullstack-project
   ```

2. Проверьте инструменты и запущенный Docker Engine:

   ```bash
   node --version
   npm --version
   docker compose version
   docker info
   ```

   Если `docker info` не соединяется с сервером, дождитесь запуска Docker Desktop.

3. Создайте `.env` в корне проекта один раз. Существующий настроенный файл не перезаписывайте.

   Windows, PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   macOS, Terminal:

   ```bash
   cp .env.example .env
   ```

4. Перед установкой локальных зависимостей убедитесь, что в `frontend/.dockerignore` и
   `backend/.dockerignore` есть исключения:

   ```text
   node_modules
   dist
   .env
   .env.*
   *.log
   ```

   Если файлов нет, создайте их с этим содержимым. Это важно на обеих ОС: `COPY . .`
   в Dockerfile может скопировать локальные зависимости поверх Linux-зависимостей образа.
   `.gitignore` не управляет Docker-сборкой. См. [правила .dockerignore](https://docs.docker.com/build/concepts/context/#dockerignore-files).

5. Установите локальные зависимости и сгенерируйте типы Prisma для редактора:

   ```bash
   npm ci --prefix backend
   npm ci --prefix frontend
   npm run prisma:generate --prefix backend
   ```

   Последняя команда генерирует Prisma Client, не запускает миграции и не меняет данные БД.
   Зависимости устанавливаются отдельно в backend и frontend; корневого `npm install` недостаточно.

6. Из корня проекта запустите окружение:

   ```bash
   docker compose up --build -d
   docker compose ps -a
   ```

   Compose запускает PostgreSQL, `db-init`, backend, frontend и вспомогательный `workspace`.
   `db-init` применяет миграции и запускает seed. Успешный статус этого одноразового сервиса —
   `Exited (0)`; остальные сервисы должны работать. `workspace` не означает, что редактор
   подключился к контейнеру: при обычном открытии папки он остаётся локальным.

Адреса после запуска:

- [Frontend](http://localhost:5173)
- [API](http://localhost:3000)
- [Swagger](http://localhost:3000/api/docs)
- [Health check](http://localhost:3000/health)

При ошибке запуска смотрите Docker Desktop или `docker compose logs --tail=80 db-init backend frontend`.
Порты 5432, 3000 и 5173 должны быть свободны. На macOS при отказе в доступе к папке проверьте
разрешения Docker Desktop на файловый доступ; на Windows при ошибке виртуализации вернитесь
к подготовке WSL 2 и BIOS/UEFI.

## Ежедневная работа и обновление проекта

Редактируйте локальные исходники, сохраняйте и смотрите результат в браузере.
Автоматически видны изменения смонтированных файлов, а не любых файлов репозитория:

- `backend/src` и `frontend/src`: работают Nest watch и Vite hot reload; сборка образов не нужна.
- `package.json`, `package-lock.json`, Dockerfile: повторите локальные `npm ci` для изменённой части,
  затем `docker compose up --build -d`. Установка пакета на компьютере не устанавливает его в контейнер.
- `prisma/schema.prisma`: файл виден backend, но миграции и генерация клиента не происходят от
  одного сохранения. Следуйте [инструкции по миграциям](DATABASE_MIGRATIONS.md); локальный клиент
  для IDE обновляйте через `npm run prisma:generate --prefix backend`.
- `.env` и настройки Compose: повторите `docker compose up -d`, чтобы применить изменения
  конфигурации сервисов; только используемые Compose переменные влияют на контейнеры.
- Файл вне `volumes` соответствующего сервиса: проверьте Dockerfile; скопированным при сборке
  файлам потребуется пересборка образа. Например, это относится к `frontend/public`, если добавить её.

После получения изменений из Git действия зависят от того, какие файлы изменились, по правилам выше.
Сохранение исходника не синхронизирует `node_modules`. Если подсказки IDE не обновились после
установки зависимостей и генерации Prisma Client, перезапустите TypeScript server или редактор.

Проверки в запущенных контейнерах:

```bash
docker compose exec backend npm run lint
docker compose exec frontend npm run lint
```

Остановить окружение с сохранением PostgreSQL volume: `docker compose down`.
Не добавляйте `-v` для обычной остановки: этот флаг удаляет данные volumes.
Для повторного запуска используйте `docker compose up -d`.

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

Правила работы с AI-агентами находятся в [AGENTS.md](AGENTS.md).
Конфигурация запуска определяется [docker-compose.yml](docker-compose.yml) и Dockerfile сервисов.

Во всех текстовых файлах проекта необходимо использовать окончания строк **LF**. Формат **CRLF** не допускается, в том числе при работе на Windows. Правило закреплено в `.gitattributes`, а конфигурации Prettier для frontend и backend используют `endOfLine: "lf"`.
