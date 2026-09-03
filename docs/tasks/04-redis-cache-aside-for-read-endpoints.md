# Задача 4. Redis cache-aside для тяжёлых read endpoints

> [!summary] Результат
> `GET /workspaces/:workspaceId/projects` и permission-aware trigram search используют Redis cache-aside без обхода RBAC и tenant isolation. PostgreSQL остаётся источником истины, write инвалидирует workspace namespace после commit, concurrent miss не создаёт stampede, а недоступный Redis не меняет HTTP-контракт.

> [!note] Перед началом
> Прочитайте [Redis cache-aside: correctness, invalidation и stampede protection](../guides/04-redis-cache-aside-primer.md). Guide использует самостоятельный пример Store -> Catalog и содержит явную карту переноса на Workspace Docs.

## 1. Фактическое исходное состояние после task3

Не создавайте новый access layer, search route или response model. В проекте уже есть:

- роли `OWNER`, `MEMBER`, `VIEWER`, единые `AccessPolicyService` и permission matrix;
- hidden `404` для outsider и `403` для участника без permission;
- `ProjectsService.listByWorkspace` и route `GET /workspaces/:workspaceId/projects`;
- `DocumentsService.search` и route `GET /workspaces/:workspaceId/documents/search`;
- search DTO: trimmed `q` 2–100, `limit` 1–50/default 20, `offset` 0–5000/default 0;
- tenant predicate внутри search SQL до ranking/pagination, transaction-local threshold `0.3`, `%`, `<%` и GIN index;
- search shape `id`, `projectId`, `title`, `status`, `updatedAt`, `author.name`, `score`, без `content`;
- project-list shape с `_count.documents` и `createdBy.name`;
- текущие archive semantics и последовательные migrations задач №1–3.

Task4 расширяет существующие services. Не вводите несуществующий `DocumentsSearchService`, не меняйте SQL, DTO, routes, status-модель, sorting, pagination, public shapes или опубликованные migrations.

## 2. Correctness отдельно от performance

Cache correctness означает: hit эквивалентен текущему PostgreSQL path для того же workspace и параметров, не обходит authorization и после успешной mutation не возвращает старую version.

Инварианты:

1. JWT guard работает до feature-service.
2. Existing policy выполняется до любого cache read, lock или loader.
3. Tenant и все параметры ответа входят в key.
4. DB write завершается до invalidation.
5. Redis error приводит к DB fallback, а не к `500` или ослаблению policy.
6. Hit/miss возвращают исходный public shape.
7. Cache не хранит JWT, password, email, `Document.content` или permissions.

Correctness доказывают функциональные тесты. Ускорение — отдельный эксперимент: latency assertion, один локальный замер или само наличие Redis не являются критерием корректности.

## 3. Архитектура и файлы

Добавьте `redis:7-bookworm` в Compose с AOF volume и healthcheck. Добавьте `ioredis`, настройки в `.env.example`, один `CacheModule`/`CacheService`, интеграцию в существующие Projects/Documents modules, `backend/test/cache.e2e-spec.ts` и `docs/infrastructure/04-redis-cache.md`.

Сохраняйте modular monolith:

```text
Controller -> FeatureService -> AccessPolicyService
                         |----> CacheService -> Redis
                         |----> PrismaService -> PostgreSQL
```

`CacheModule` владеет единственным lifecycle-managed Redis client и экспортирует `CacheService`. Feature services не создают `new Redis()` и не получают raw client. Не добавляйте Repository, CQRS, event bus или новый search service ради cache.

## 4. Конфигурация

```text
REDIS_URL=redis://redis:6379
CACHE_ENABLED=true
CACHE_PROJECTS_TTL_SECONDS=60
CACHE_SEARCH_TTL_SECONDS=30
CACHE_LOCK_TTL_MS=5000
```

- При включённом cache `REDIS_URL` обязателен.
- TTL/lock timeout валидируются при bootstrap как положительные integers.
- При `CACHE_ENABLED=false` оба reads идут прямо в PostgreSQL.
- Backend не зависит от Redis readiness для старта: Redis — деградируемая оптимизация.
- Client закрывается через Nest lifecycle hook.

## 5. Единственная разрешённая key schema

Version key:

```text
wsdocs:v1:workspace:{workspaceId}:version
```

Data keys:

```text
wsdocs:v1:workspace:{workspaceId}:v{version}:projects
wsdocs:v1:workspace:{workspaceId}:v{version}:search:{sha256(canonicalParams)}
```

`canonicalParams` строится после DTO transform/validation в фиксированном порядке:

```json
{ "q": "<trimmed q>", "limit": 20, "offset": 0 }
```

Не теряйте `limit`/`offset`. Не помещайте raw query в key/log: SHA-256 ограничивает длину и скрывает текст. У project list нет query-параметров, поэтому suffix `normalizedQuery` ему не нужен.

Role/userId не входят в data key, потому что текущий payload одинаков для трёх читающих ролей; безопасность обеспечивает policy перед cache. Если shape станет actor-dependent, добавьте actor/permission variant или кешируйте только общий pre-personalized payload.

Запрещены глобальные keys без `workspaceId`, data key без version, search key без полного `q/limit/offset`, общий key разных schema versions и кеширование результата глобального/постфильтрованного query.

## 6. Cache-aside и degraded mode

Для каждого endpoint:

1. Проверить access с resource `project` или `document`.
2. Прочитать workspace version; отсутствие означает `0`.
3. Построить versioned data key.
4. Вернуть валидный JSON hit.
5. На miss выполнить stampede-safe loader.
6. Loader вызывает прежний tenant-scoped Prisma/SQL path.
7. Записать JSON с TTL и bounded jitter до ±10%.
8. Любую Redis connect/get/set/version/lock ошибку залогировать без payload и продолжить через DB.

Повреждённый JSON — miss: удалить best-effort только точный key и загрузить source of truth. Cache layer не перехватывает auth/policy/validation/PostgreSQL errors и не превращает их в miss.

## 7. Stampede protection

Простая схема `GET -> miss -> DB -> SET` для этих endpoints запрещена.

```text
lockKey = {fullDataKey}:lock
SET lockKey uniqueToken NX PX CACHE_LOCK_TTL_MS
```

- Владелец lock делает second cache read, один DB load и SET с TTL/jitter.
- Lock снимается compare-and-delete Lua script только при совпадении token.
- Не-владелец выполняет не более трёх коротких bounded retries; затем идёт в DB без бесконечного ожидания.
- Lock всегда имеет expiry; token уникален для attempt.

Запрещены обычный `DEL lockKey`, бессрочный lock, бесконечный polling и process-local mutex: первый может удалить чужой reacquired lock, остальные не защищают multi-instance backend.

## 8. Invalidation после write

После успешного DB commit выполнить:

```text
INCR wsdocs:v1:workspace:{workspaceId}:version
```

Один coarse-grained version одновременно инвалидирует project list и search. Старые keys больше не читаются и удаляются TTL. Лишний miss допустим, stale read — нет.

| Mutation                         | Источник workspaceId                             | После DB success |
| -------------------------------- | ------------------------------------------------ | ---------------- |
| create project                   | route `workspaceId`                              | bump version     |
| update/archive/delete project    | context `requireProject`                         | bump version     |
| create document                  | context `requireProject`                         | bump version     |
| update/archive/delete document   | `document.project.workspaceId` из policy context | bump version     |
| будущая membership/role mutation | route/policy context                             | bump version     |

Task4 не добавляет отсутствующие membership routes. Но будущая операция membership/role обязана bump-нуть workspace version; policy всё равно выполняется на каждом read, cache не хранит permissions.

Нельзя invalidировать до commit: параллельный reader способен снова заполнить старое значение. Если DB write откатился, version не меняется. Если commit прошёл, а `INCR` упал, write не откатывается; ошибка логируется, stale window ограничен TTL. Guaranteed retry/outbox — отдельная задача.

Loader, начатый на version N до concurrent write, пишет только key N; после bump N+1 этот value недоступен. Запрещены `KEYS *`, `FLUSHDB`, `FLUSHALL`, глобальный `SCAN` и prefix deletion вне точного tenant namespace.

## 9. Интеграция без изменения контрактов

Project list:

```text
ProjectsService.listByWorkspace
-> requireWorkspace(userId, workspaceId, 'view', 'project')
-> remember(project key)
-> прежний project.findMany({ where: { workspaceId }, include/orderBy без изменений })
```

`GET /projects` не кешируется: он агрегирует несколько workspaces и требует отдельной strategy.

Search:

```text
DocumentsService.search
-> requireWorkspace(userId, workspaceId, 'view', 'document')
-> remember(search key from q/limit/offset)
-> прежняя interactive transaction, set_config, parameterized trigram SQL и response mapping
```

Tenant filter остаётся внутри SQL. `ARCHIVED` documents продолжают участвовать в search. `content` не загружается и не кешируется.

## 10. Real E2E-flow

`backend/test/cache.e2e-spec.ts` использует реальный `AppModule`, HTTP server, Redis 7 и PostgreSQL 16; Redis client, `CacheService` и DB loader не mock-аются.

Fixtures:

- unique prefix `task4-e2e-*` для users, двух workspaces, projects/documents;
- основной workspace с OWNER/MEMBER/VIEWER, outsider без membership;
- foreign workspace с отдельным owner и совпадающим search document;
- JWT получаются через реальный `POST /auth/login`;
- cleanup удаляет только exact test IDs/emails и точные Redis keys test workspace;
- suite не зависит от seed и не использует `deleteMany({})`, `KEYS *`, `FLUSHDB` или удаление Redis volume.

Обязательный flow:

1. Project list/search без JWT возвращают `401` и не создают data keys.
2. Первый GET OWNER даёт miss, исходный shape и versioned key с положительным TTL.
3. Второй GET доказывает hit: controlled direct DB change затрагивает только собственный probe-fixture без invalidation, cached response остаётся прежним; затем fixture восстанавливается либо меняется публичной mutation.
4. OWNER, MEMBER и VIEWER получают `200` для list/search, в том числе после прогрева cache другой ролью.
5. HTTP create/update/archive/delete project bump-ит version; следующий list miss видит актуальные данные.
6. HTTP create/update/archive/delete document bump-ит version; следующий search miss отражает актуальный title/status/deletion.
7. Search miss и hit не содержат foreign document, `content`, email или поля вне task3 shape.
8. Outsider с JWT получает hidden `404` и не читает/не заполняет cache чужого workspace.
9. При одинаковой phrase выдача основного workspace не содержит foreign fixture ни на miss, ни на hit.
10. При остановленном Redis разрешённые OWNER/MEMBER/VIEWER reads идут в PostgreSQL с `200`; outsider остаётся `404`, no-JWT — `401`.

Не доказывайте hit временем. Проверяйте точный test-owned key/TTL и controlled probe либо test-only query counter вокруг реального Prisma provider. Concurrency test отправляет несколько simultaneous miss одного key и подтверждает один normal loader path или bounded fallback без deadlock.

## 11. Документация и проверки

В `docs/infrastructure/04-redis-cache.md` опишите endpoints, полную key schema, canonical params, TTL/jitter, invalidation matrix, Lua release, degraded mode и очистку только exact dev/test namespace.

```bash
docker compose config
docker compose up -d redis db db-init backend
docker compose ps
docker compose exec redis redis-cli ping
docker compose exec backend npm run format:check
docker compose exec backend npm run lint
docker compose exec backend npm run build
docker compose exec backend npm run test:e2e -- --runInBand cache.e2e-spec.ts
docker compose exec backend npm run test:e2e -- --runInBand
```

Остановите только Redis и повторите degraded-mode HTTP cases, затем запустите Redis обратно.

## 12. Не входит в задачу

- cache для `GET /projects`, login, permissions или document detail;
- изменение task3 SQL/index/DTO/ranking/pagination;
- изменение RBAC, routes, status semantics или response shapes;
- write-through/write-behind, Redis Cluster/Sentinel, outbox и performance SLA.

## 13. Критерии приёмки

- RBAC, hidden `404`, tenant isolation, search и migrations сохранены.
- OWNER/MEMBER/VIEWER читают и ищут; outsider получает `404`, no-JWT — `401`.
- Policy выполняется до каждого cache operation, включая hit.
- Keys tenant-scoped, versioned и учитывают все параметры ответа.
- Hit/miss эквивалентны исходному public shape и не содержат foreign data.
- Все project/document mutations bump-ят version после DB success.
- Stampede protection использует `SET NX PX`, second read, bounded retry и token-safe Lua release.
- Нет global keys, `KEYS *`, небезопасного lock `DEL` или invalidation до commit.
- Redis failure деградирует в PostgreSQL без обхода authorization.
- E2E использует real NestJS + Redis + PostgreSQL, владеет fixtures и не зависит от seed.
- Correctness assertions не основаны на latency; performance исследуется отдельно.
- Compose, format, lint, build, cache E2E и полный E2E проходят.

## 14. Самопроверка

- [ ] Я расширил существующие `ProjectsService` и `DocumentsService`.
- [ ] Task3 route, SQL, DTO, sorting и shape не изменены.
- [ ] Policy вызывается до Redis.
- [ ] Search key содержит workspace, version и hash `q/limit/offset`.
- [ ] Version bump выполняется после DB success.
- [ ] Stale loader не пишет в новую version.
- [ ] Lock ограничен по времени и снимается своим token.
- [ ] Redis error не становится `500`.
- [ ] Тесты не очищают чужие DB fixtures/Redis namespaces.
- [ ] Hit/miss, invalidation, isolation, `401`, hidden `404` и degraded mode доказаны real E2E.
