# Задача 4. Redis cache-aside для тяжёлых read endpoints

> [!summary] Результат
> Списки проектов и trigram search кешируются безопасно по workspace, записи инвалидируются после изменений, а падение Redis не ломает API.

## Предусловия и стек

Задачи №2 и №3 завершены. Использовать Redis 7 в Docker Compose и клиент `ioredis`. Добавить отдельный `CacheModule`/`CacheService`; бизнес-сервисы не работают с клиентом Redis напрямую.

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

## Конфигурация

Добавить в `.env.example` и Compose: `REDIS_URL`, `CACHE_ENABLED`, TTL и lock timeout. Значения валидировать при старте. Redis получает healthcheck; backend не зависит от его readiness для запуска.

## Тесты

- первый запрос — miss + DB + set; второй — hit без DB query;
- разные workspace/query получают разные keys;
- outsider не получает cached response чужого workspace;
- create/update/archive/delete инвалидируют нужные данные;
- изменение role/membership инвалидирует cache;
- Redis get/set/connect error приводит к корректному ответу из PostgreSQL;
- 10 параллельных miss не вызывают 10 одинаковых DB query при доступном lock;
- битый JSON удаляется/игнорируется и восстанавливается из БД;
- TTL и jitter находятся в заданных границах.

## Документация

Создать `docs/infrastructure/04-redis-cache.md`: endpoints, keys, TTL, invalidation matrix, degraded mode, локальная проверка hit/miss и очистка только dev namespace.

## Не входит в задачу

Кеширование login, отдельных документов, write-behind, Redis Cluster и использование cache как хранилища permissions.

## Критерии приёмки

- Ответы cache hit и DB path эквивалентны.
- Cache изолирован по workspace и не обходит RBAC.
- После write пользователь не видит устаревший список.
- При остановленном Redis API остаётся работоспособным.
- Тесты, документация и Docker healthcheck добавлены.

