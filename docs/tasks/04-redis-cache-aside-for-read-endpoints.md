# Задача 4. Redis cache-aside для тяжёлых read endpoints

> [!summary] Результат
> Списки проектов и trigram search кешируются безопасно по workspace, записи инвалидируются после изменений, а падение Redis не ломает API.

> [!note] Связанный материал
> См. [памятку к задаче 4](../guides/04-redis-cache-aside-primer.md).

## Проблема

Повторные project list и document search каждый раз выполняют одинаковую работу в PostgreSQL. Простое добавление Redis опасно: общий key может смешать workspace, устаревший value пережить write, а недоступный cache превратить рабочий API в `500`.

## Предусловия и стек

Задачи №2 и №3 завершены. Использовать Redis 7 в Docker Compose и клиент `ioredis`. Добавить отдельный `CacheModule`/`CacheService`; бизнес-сервисы не работают с клиентом Redis напрямую.

Добавьте `redis` service в корневой `docker-compose.yml`, переменные в `.env.example`, а код — в `backend/src/cache/cache.module.ts` и `cache.service.ts`. Подключите его к готовым `ProjectsService`, `DocumentsSearchService` и операциям membership из задачи №2.

```yaml
redis:
  image: redis:7-bookworm
  # Добавить command, volume и healthcheck.
```

`CacheService` не должен скрывать access check: policy вызывается до него.

```ts
export class CacheService {
	// remember(key, ttl, load): cache hit/miss и fallback к load()
	// invalidateWorkspace(workspaceId): увеличить version namespace
	// withLock(key, load): защита от stampede с TTL и token владельца
}
```

В project list порядок такой: `requireWorkspace(view)` -> нормализованный key -> `remember(..., () => prisma.project.findMany(...))`.

## Кешируемые операции

1. `GET /workspaces/:workspaceId/projects`: TTL 60 секунд.
2. `GET /workspaces/:workspaceId/documents/search`: TTL 30 секунд.

Ключи имеют версию и scope:

```text
wsdocs:v1:workspace:{workspaceId}:projects:{normalizedQuery}
wsdocs:v1:workspace:{workspaceId}:search:{sha256(normalizedQuery)}
```

Перед чтением cache всегда выполнить membership/view check. В value не хранить JWT, email или полный content.

## Cache-aside алгоритм

1. Проверить access policy.
2. Нормализовать параметры и построить key.
3. Прочитать Redis; валидный hit сразу вернуть.
4. При miss поставить короткий lock через `SET key value NX PX 5000`.
5. Владелец lock читает PostgreSQL и записывает JSON с TTL и jitter ±10%.
6. Остальные запросы делают до трёх коротких повторов чтения; затем идут в PostgreSQL.
7. Lock снимается compare-and-delete Lua script, только своим token.

Ошибка connect/get/set/lock логируется без sensitive data, после чего запрос продолжается через PostgreSQL. Redis никогда не является источником истины.

## Invalidation

- create/update/archive/delete project очищает project-list keys workspace;
- create/update/archive/delete document очищает search keys workspace;
- изменение membership/role очищает оба namespace workspace;
- invalidation выполняется после успешного commit БД;
- использовать version key или `SCAN` небольшого namespaced набора; production request не должен выполнять глобальный `KEYS *`.

Практический вариант для этого проекта — workspace version: хранить `wsdocs:v1:workspace:{id}:version`, включать version в list/search keys и увеличивать `INCR` после write. Тогда не требуется искать все старые keys; они спокойно истекут по TTL.

## Конфигурация

Добавить в `.env.example` и Compose: `REDIS_URL`, `CACHE_ENABLED`, TTL и lock timeout. Значения валидировать при старте. Redis получает healthcheck; backend не зависит от его readiness для запуска.

## Документация

Создать `docs/infrastructure/04-redis-cache.md`: endpoints, keys, TTL, invalidation matrix, degraded mode, локальная проверка hit/miss и очистка только dev namespace.

## Не входит в задачу

Кеширование login, отдельных документов, write-behind, Redis Cluster и использование cache как хранилища permissions.

## Критерии приёмки

- Ответы cache hit и DB path эквивалентны.
- Cache изолирован по workspace и не обходит RBAC.
- После write пользователь не видит устаревший список.
- При остановленном Redis API остаётся работоспособным.
- Документация и Docker healthcheck добавлены.
