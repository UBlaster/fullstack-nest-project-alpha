# Контекст проекта nest-fullstack-project

Актуализирован 25 сентября 2026 года после возврата в TT6-background-export-jobs-and-worker.
Текущий checkout: TT6-background-export-jobs-and-worker, базовый HEAD 9d42a23;
origin/TT6-background-export-jobs-and-worker — ebb7bf7 (локальная ветка впереди на один commit).
Файл — локальная память, не добавляется в commits. Записи ниже о master исторические.

## Текущее состояние TT6

- Именованный stash TT6 background export worker WIP before TT1 starter branch (3177c234)
  применён к рабочему дереву и сохранён в stash@{0}.
- Незакоммиченные изменения касаются backend exports/worker, очереди, хранилища, тестов,
  Compose и страницы проекта. Новые файлы находятся в backend/src/worker/ и backend/test/.
- Изменения после применения stash не добавлены в staging. Проверки приложения в этой задаче
  не запускались; выполнялись только сверка branch/status и состава stash.

## Назначение и стек

Учебный production-like modular monolith: User → Workspace → Project → Document.
Подтверждённые версии исходной базы: Node.js 20, npm, React 18.3, TypeScript, Vite,
React Router, NestJS 10.4, Prisma 6.19, PostgreSQL 16. Не обновляй стек автоматически.

## Ветки и учебные материалы

- STAGE ученика всегда начинается от актуального master.
- `0_TARUSOV_STAGE` — накопительная реализация Tarusov с последующими задачами,
  не исходный шаблон STAGE нового ученика.
- На проверенном master (`d69ce21`) auth/projects ещё в `backend/src/auth.ts` и
  `backend/src/resources.ts`; это исходное приложение, не завершённая Task 1.
- Историческая TT1 — `feature/TT-1-refacor-hash` (`1d3a385`): feature-модули,
  bcrypt, регистрация/удаление, DTO, создание проекта через workspace в URL.
- Task 1 и Guide 1 находятся в `docs/tasks/01-auth-projects-refactoring-and-password-hashing.md`
  и `docs/guides/01-password-hashing-dto-and-module-boundaries-primer.md`.
  Документы могут быть на диске, хотя `docs` игнорируется Git. Не меняй ignore-правила ради их поиска.
- Код и тесты соответствующей ветки определяют реализованное поведение. Документация отдельно
  фиксирует требования, ещё не выполненные исторической реализацией. Не смешивай эти категории.

## Устройство приложения

- Backend: Controller → Service → PrismaService, feature modules и Nest DI.
- WorkspaceMember связывает User с Workspace; уникальный ключ — `userId_workspaceId`.
  На исходном master create ещё выбирает первый membership; Task 1 требует URL workspace и lookup
  по обоим ID. JWT подтверждает identity, не membership.
- Project имеет workspace и создателя; Document — проект и автора. При удалении User связи
  авторства ограничены `Restrict`; memberships можно удалить. Общие данные не каскадируют от User.
- На исходном master projects принимает `any`, а login/seed используют plaintext. Runtime DTO,
  явный allowlist Prisma data и bcrypt — результат Task 1; hash не входит в public response.
- Полный RBAC и остальные подсистемы зависят от выполненной задачи/ветки. Не вводи их заранее.
- Repository/CQRS/DDD не нужны как механическая обёртка над Prisma.

## Локальное окружение

- Проверено 21 сентября по master: Redis отсутствует в Compose и package.json; прежняя запись
  о Redis 7 в README была ошибочной и основана на конфигурации другой ветки.
- Локальный Node проверенного терминала — 22.17.1, npm 10.9.2; образы dev используют Node 20.
  ESLint 10.8.1 в обоих lock-файлах требует ^20.19.0 || ^22.13.0 || >=24.
- Node 20 уже EOL по официальной странице Node.js; в этой задаче Dockerfile не обновлялись.
- Исходники backend/src и frontend/src смонтированы; Nest использует polling, Vite — usePolling
  с интервалом 800 мс. Локальные node_modules не смонтированы в backend/frontend.
- В master отсутствуют frontend/.dockerignore и backend/.dockerignore. COPY . . при сборке
  frontend может захватить модули хоста. README описывает исключения до установки зависимостей;
  автоматическое изменение ignore-правил не выполняется, пользователю задан отдельный вопрос.
- workspace не устанавливает зависимости IDE и не получает node_modules контейнеров приложений.
  Его /workspace — bind mount всего checkout, поэтому зависимости ОС могут смешиваться.
- Docker Compose: backend/frontend и workspace для IDE. Dev-образы — `node:20-bookworm`,
  PostgreSQL — `postgres:16`.
- Проект в workspace-контейнере — `/workspace`; backend/frontend работают в `/app` своих образов.
  Зависимости находятся в образах приложений; наличие node_modules volumes не предполагается.
- Команды приложения: `docker compose exec -T backend npm run <script>` и аналогично frontend.
- Адреса с хоста: frontend `http://localhost:5173`, backend `http://localhost:3000`,
  Swagger `http://localhost:3000/api/docs`, health `http://localhost:3000/health`.
- Корневой `.env` создаётся по `.env.example`; Compose передаёт env сервисам.
- `db-init` применяет migrations и seed. Запуск окружения может менять БД, поэтому он не нужен
  для обычной редактуры документации.
- Demo credentials — только локальные fixtures; в БД должны быть hashes. Повторный seed
  не сбрасывает пользовательские пароли. JWT в frontend localStorage — учебное упрощение.

## Историческая запись: подготовка AGENTS.md в master, 9 сентября

- Task 1 и Guide 1 переработаны; код приложения не менялся. Документы остаются локально в `docs`.
- Подготовлен только корневой AGENTS.md: bootstrap локальной памяти для Cursor (`.cursor`),
  Claude Code (`.claude`) и Codex (`.codex`); контекст обновляется перед commit, work-rules создаётся
  один раз по `.cursor` и lint/format настройкам. Claude Code требует первого чтения AGENTS.md
  по запросу ученика и локального `.claude/CLAUDE.md` с imports; адаптер в master не включается.
- Прежние редакторские изменения `.cursor` возвращены к master; исходные правила не изменены.
- Проверки документации уже выполнены: 10 Mermaid-схем, strict-компиляция 19 учебных TS-файлов,
  три теста примеров, локальные ссылки и secret scan только Task 1/Guide 1. Секреты не найдены.
- Пользователь разрешил commit AGENTS.md в master. В staging должен быть только AGENTS.md;
  `.codex/`, Task/Guide и исходные `.cursor/rules/` в этот commit не входят. Push не разрешён.
- Источники поведения агентов: официальные Cursor Rules, Claude Code Memory и Codex AGENTS.md.
  Новый hash до создания commit не указан. Код приложения и БД не менялись.
## Актуальное состояние документов, 12 сентября

- Полная локальная копия 20 документов находится вне checkout:
  `C:/fontend/mentoring/folders/NotPublish/nest-fullstack-project-docs-20260903-121556`.
  Исходный ZIP-бэкап сохранён рядом. После бэкапа обе рабочие копии Task 1 и Guide 1 обновлены.
- Task 1 сокращён до семи подзадач по реализации `feature/task-2-start` (`34bba33`):
  файлы, DI, DTO, auth/bcrypt, проекты, seed и проверки. Дополнительные требования аудита удалены.
- Guide 1 перестроен по семи подзадачам с самостоятельным примером и HTTP-тестом.
  25 учебных файлов проверены локальным TypeScript strict; DTO проверены через ValidationPipe.
  Код проекта, migrations, seed и E2E не запускались и не менялись при редактуре.
- В текущем checkout после пользовательского переключения ветки осталось 17 игнорируемых
  документов; Task 2, Task 4 и Guide 4 доступны в полной внешней копии и Tarusov Stage.

## Подготовлено к commit: убрать docs из feature/task-5-start

- Пользователь поручил удалить docs из master и всех стартовых веток, сохранив Tarusov Stage.
- Проверены все локальные start-ветки (2, 3, 4, 5) и master. В master и start 2–4 docs уже
  отсутствует в Git. Во всех пяти ветках есть существующее ignore-правило для docs.
- Для `feature/task-5-start`, parent `f34664b`, в отдельном индексе подготовлены только удаления:
  `docs/tasks/02-rbac-workspace-data-access.md`,
  `docs/tasks/04-redis-cache-aside-for-read-endpoints.md`,
  `docs/guides/04-redis-cache-aside-primer.md`.
- Staged diff отдельного индекса проверен: ровно три D под docs, без других изменений.
  Создаётся новый дочерний commit без переписывания истории и без переключения checkout.
- `0_TARUSOV_STAGE` остаётся на `8176319`; текущий индекс, локальные docs и внешняя копия
  сохраняются. Fetch/pull/push не выполняются. Новый commit hash до создания не указан.
## Подготовлено к commit: требования локального запуска в README, 20 сентября

- В `README.md` добавлен раздел предварительной установки с официальными ссылками Docker Desktop
  для Windows, macOS и Linux и DBeaver Community.
- Docker Desktop обозначен обязательным для запуска сервисов; DBeaver — инструментом учебной
  работы с PostgreSQL, но не runtime-зависимостью приложения.
- Уточнено, что Node.js, npm, PostgreSQL и Redis отдельно устанавливать не требуется;
  в стек README добавлен фактически используемый Compose-сервис Redis 7.
- Добавлены команды проверки Docker и параметры подключения DBeaver к локальному PostgreSQL.
- Проверки: официальные страницы открываются; `docker compose config --quiet`, `git diff --check`
  и проверка LF прошли. Приложение, migrations, seed и E2E не запускались.
- В `master` создан commit `5097c73` только с `README.md`; `.codex/project-context.md`
  остаётся локальным unstaged-изменением.
## Подготовлено к commit: GUI-инструменты в README, 20 сентября

- В `README.md` явно указано требование использовать Docker Desktop с графическим интерфейсом;
  перечислены доступные через UI контейнеры, логи, образы и volumes.
- Добавлены официальные ссылки на Redis Insight и инструкцию по его установке; инструмент описан
  как desktop-GUI для просмотра ключей, структур данных и выполнения Redis-команд.
- Официальные страницы Redis проверены. `git diff --check` и проверка LF прошли.
- В `master` создан commit `0906d89` только с `README.md`; `.codex/project-context.md`
  остаётся локальным unstaged-изменением.

## Подготовлено к commit: проверенная инструкция Windows/macOS, 21 сентября

- README описывает основной сценарий локального редактора с запуском приложения через Docker,
  отличие от Dev Container и независимость Node.js 22 на хосте от Node.js 20 в образах.
- Общие команды: локальные npm ci для обоих пакетов, генерация Prisma Client для IDE,
  docker compose up --build -d. Отдельно описаны WSL 2/виртуализация для Windows и Docker Desktop
  Apple Silicon/Intel для macOS. Общие шаги и правила hot reload/пересборки объединены.
- Исправлены ошибочное наличие Redis в master и ссылка README на удалённый project-context.mdc.
  Redis Insight сохранён как инструмент для последующих Redis-заданий.
- Прочитаны только основные конфиги, manifests/lock-файлы и generator/datasource Prisma.
  Manifests совпадают с корневыми требованиями lock-файлов; проверены engine основных инструментов.
- Проверены официальные Docker/Microsoft/Node/npm справки; Compose config --quiet, LF,
  Markdown fences, локальные ссылки и git diff --check прошли.
- Docker Engine недоступен по named pipe; запуск, hot reload и macOS не проверялись на практике.
  Установка зависимостей, migrations, seed, E2E и полный аудит не выполнялись.
- В commit входит только README.md; локальная память остаётся unstaged. Hash ещё не создан.
## Согласованный план рефакторинга для следующего чата, 25 сентября 2026

Пользователь поручил создать новый чат в этом же проекте и сохранённом checkout и начать
работу по плану ниже. Рабочие ветки: master, feature/task-1-start ... feature/task-5-start
и TT6-background-export-jobs-and-worker. Локальные backup-ветки — точки возврата; отдельные
refactor-ветки не используются и уже удалены. Пользователь согласовал указанные commit/push
и последовательные merge. Backup-ветки остаются только локальными. Worktree не создавать.

1. Сначала TT6. Сохранённый stash@{0} уже применён к рабочему дереву; сверить его с WIP,
   не применять повторно вслепую. Проверить изменения, выборочно добавить только файлы
   задачи, создать commit и отправить локальные коммиты в origin/TT6-background-export-jobs-and-worker.
   Только после успешного push создать локальную TT6-background-export-jobs-and-worker-backup
   от опубликованной вершины. Затем уйти с TT6 и вернуться после Task 5.
2. До первой правки master сверить master-backup с его исходной вершиной. Добавить реально
   работающий ESLint-запрет DTO-синтаксиса field!: Type и исправить DTO. Обязательные поля
   должны остаться обязательными; @IsOptional() только для действительно опциональных.
   Проверить, создать commit и push master.
3. До любого изменения Task 1, включая merge, сверить feature/task-1-start-backup с её
   текущей вершиной. Затем слить master в feature/task-1-start. Здесь переносится только
   правило/DTO; контроллеры, сервисы и auth-декоратор Task 1 не рефакторить. Проверить,
   commit и push.
4. До merge сверить backup Task 2. Слить Task 1 в feature/task-2-start, разрешив конфликты
   с сохранением модульной реализации и тестов. В Task 2 один раз разделить контроллеры
   по базовым URL внутри модулей (controllers/), сервисы по обязанностям и ввести общий
   JWT-декоратор вместо прямых @UseGuards(AuthGuard('jwt')) на защищённых маршрутах.
   Публичные URL, HTTP-методы, доступ и ответы сохранить. Проверить, commit и push.
5. До merge сверить backup Task 3; слить Task 2 в feature/task-3-start, адаптировать поиск,
   проверить, commit и push.
6. До merge сверить backup Task 4; слить Task 3 в feature/task-4-start, адаптировать кеш
   и инвалидацию, проверить, commit и push.
7. До merge сверить backup Task 5; слить Task 4 в feature/task-5-start. Известны конфликты
   .env.example и docker-compose.yml; сохранить нужные Redis-настройки и обе линии истории.
   Проверить, commit и push. Затем вернуться в TT6 с готовым backup, слить Task 5,
   адаптировать файлы/экспорт/worker, проверить, commit и push.
8. Контроль тестов на каждом этапе: в E2E и любых других тестах допустимы только
   механические исправления импортов, файловых путей и привязки маршрутов, необходимые
   при переносе контроллеров/сервисов. Нельзя переписывать сценарии, ожидаемые ответы,
   статусы, проверки прав, fixtures или другую логику теста ради прохождения. Если
   поведение приложения расходится с тестом, сообщить пользователю конкретное расхождение
   и ждать его решения по нему. Публичный HTTP-контракт сохраняется. Стартовые ветки
   могут содержать ожидаемо красные приёмочные тесты ещё не реализованного задания;
   отличать их от регрессий рефакторинга.

Локальные backup-ветки на момент передачи: master-backup = 3944f65,
feature/task-1-start-backup = 5a34684, feature/task-2-start-backup = 0a9b9ca,
feature/task-3-start-backup = a22cec1, feature/task-4-start-backup = d779cfc,
feature/task-5-start-backup = a1a5a3e. Перед работой с каждой веткой проверить её
актуальную вершину. Если она сдвинулась, сохранить новую вершину дополнительным локальным
backup, не перезаписывая старый. У TT6 пока нет backup после текущего WIP.

## Ход рефакторинга, 25 сентября 2026

- TT6 WIP из stash@{0} сверен со staged diff: 18 файлов задачи, включая перенос worker, проверки экспорта, изменения хранилища, Compose и UI. Stash повторно не применялся.
- В staging только файлы TT6; .codex не добавлялась. Проверки cached diff, backend lint/format и TypeScript noEmit для backend/frontend прошли.
- Обычная сборка уперлась в EPERM при записи существующих dist/tsbuildinfo. Docker Engine недоступен, выделенная тестовая БД не настроена; E2E не запускались.

- master: проверен backup 3944f65 = исходной вершине. В staged diff только backend/eslint.config.mjs и backend/src/auth.ts: запрет definite assertion в *Dto и declare для обязательных полей LoginDto. ESLint проверен на отрицательном примере; lint и format:check прошли. TypeScript упирается в устаревший Prisma Client (нет ADMIN), prisma generate не смог скачать engine из-за сетевого ограничения.

- Task 1: backup 5a34684 совпал с исходной вершиной; master слит без конфликтов в 8ec6b4a. Diff от backup содержит только правило ESLint и два поля LoginDto; контроллеры/сервисы и тесты не менялись. Lint и формат прошли; TypeScript остановлен тем же устаревшим Prisma Client.

- Task 2: перед merge исходная локальная вершина 34bba33 сохранена дополнительным backup feature/task-2-start-backup-20260925; старый backup 0a9b9ca не менялся. Конфликт старого auth.ts разрешен в пользу модулей; auth.e2e-spec.ts оставлен точно как в Task 2, diff тестов от backup пуст. Контроллеры разнесены по базовым URL, сервисы по обязанностям, добавлен общий JwtAuth, DTO переведены на declare. Backend lint, format, source TypeScript noEmit и статическая сверка маршрутов прошли. Полный TypeScript блокирует старый Prisma Client, E2E без выделенной БД не запускались.

- Task 3: текущая вершина 35eb245 сохранена как feature/task-3-start-backup-20260925; старый backup a22cec1 сохранен. Task 2 слита с сохранением AccessPolicyService и RBAC из Task 3; новые методы archive/listByWorkspace перенесены в контроллеры по базовым URL. Тесты, включая acceptance для поиска, не менялись. Backend lint, format, полный TypeScript noEmit и проверка route metadata прошли; E2E без отдельной тестовой БД не запускались. Поиск в стартовой ветке еще не реализован.

- Task 4: текущая вершина 5ca2cc8 сохранена как feature/task-4-start-backup-20260925; старый backup d779cfc сохранен. Task 3 слита; search endpoint перенесен в WorkspaceDocumentsController с тем же URL и методом. Тесты от исходной Task 4 не менялись. Backend lint, format и TypeScript только src прошли. Полный TypeScript остановлен тремя ожидаемыми импортами отсутствующего src/cache из приемочного cache.e2e; E2E не запускались без выделенной БД. Реализация кеша/инвалидации в стартовой ветке отсутствует.

- Task 5: текущая вершина 02b38da сохранена как feature/task-5-start-backup-20260925; старый backup a1a5a3e сохранен. Task 4 слита; конфликты .env.example и Compose разрешены версией Task 5, где уже есть Redis/cache и S3/file settings. CacheService, инвалидация, CRUD-сервисы и тесты от исходной Task 5 не менялись; модули объединяют CacheModule с разделенными контроллерами. Backend lint, format, TypeScript src и docker compose config прошли. Полный TypeScript блокируют ожидаемые импорты отсутствующих src/document-files, documents-export и storage в приемочном object-storage.e2e; E2E не запускались.

- TT6: после успешного push 447a3d4 создан локальный backup TT6-background-export-jobs-and-worker-backup. Task 5 (045983b) слита с сохранением трёх docs-удалений стартовой ветки и tracked core rules .cursor/rules по AGENTS.md; .codex исключена из staging. CSV export перенесен в workspace documents controller; files и exports контроллеры разнесены по базовым URL, общий JwtAuth, обязательные поля upload DTO объявлены через declare. Тесты от TT6 backup не менялись. Backend lint, format, полный TypeScript noEmit, Compose config и сверка маршрутов прошли. E2E не запускались: Docker Engine и выделенная тестовая БД недоступны. Подготовлено к merge commit, hash еще не создан.

- Итог 25 сентября: master 8096dd5, Task 1 8ec6b4a, Task 2 27efe73, Task 3 481ad0d, Task 4 dd1498c, Task 5 045983b и TT6 e3ad0a7 совпадают с origin. Текущий checkout TT6 e3ad0a7; только локальная .codex/ не отслеживается. Дополнительные backup Task 2-5 и TT6 остаются только локально.
