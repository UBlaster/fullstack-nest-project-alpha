# Контекст проекта nest-fullstack-project

Актуализирован 9 сентября 2026 года по правилам `.codex/work-rules.md` и фактам проверки Task 1.
Это ориентир для работы, не утверждение, что все ветки имеют одинаковую реализацию.
Текущий checkout: `master`, база `d69ce21`. Файл — локальная память, не добавляется в commits.

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

## Подготовлено к разрешённому commit в master

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
