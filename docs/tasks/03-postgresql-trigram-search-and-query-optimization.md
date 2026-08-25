# Задача 3. SQL, N+1, индексы и PostgreSQL Trigram Search

> [!summary] Результат
> Основные read-запросы измерены, N+1 устранён, а документы ищутся по title через быстрый permission-aware trigram search.

## Предусловие

Задача выполняется после задачи №2: `AccessPolicyService` и workspace isolation уже работают.

## Зафиксированный контракт поиска

`GET /workspaces/:workspaceId/documents/search?q=api&limit=20&offset=0`

- поиск только по `Document.title`;
- нечувствительность к регистру;
- сортировка: similarity по убыванию, затем `updatedAt DESC`, затем `id ASC`;
- `q`: после trim от 2 до 100 символов;
- `limit`: default 20, min 1, max 50;
- `offset`: default 0, min 0, max 5000;
- ответ содержит `id`, `projectId`, `title`, `status`, `updatedAt`, `author.name`, `score`; полный `content` не возвращается;
- поиск выполняется только внутри workspace URL после membership/view permission.

## Что нужно сделать

1. Добавить Prisma migration с `CREATE EXTENSION IF NOT EXISTS pg_trgm` и GIN-индексом `Document.title gin_trgm_ops`.
2. Реализовать search через безопасный параметризованный `$queryRaw`; строковую конкатенацию SQL не использовать.
3. Добавить `SearchDocumentsQueryDto` с transform/validation параметров.
4. Проверить list/get/search запросы на наборе не менее 10 000 documents.
5. Найти запросы в циклах. Заменить их relation filter, include/select, `_count` или одним batch query.
6. Для каждого добавленного индекса сохранить доказательство из `EXPLAIN (ANALYZE, BUFFERS)` до/после.
7. Не добавлять индекс, если план и измерения не показывают пользу.

## Relation и permission rules

- сначала проверить доступ к `workspaceId`;
- SQL обязательно содержит фильтр `Project.workspaceId = workspaceId` через join;
- клиент не передаёт список разрешённых project IDs;
- outsider получает `404` на workspace search;
- `VIEWER` может искать, потому что search является чтением;
- archived documents участвуют в поиске; фильтра по status в этой задаче нет.

> [!warning] SQL
> Названия таблиц/колонок Prisma могут быть case-sensitive в PostgreSQL. Migration и raw query должны использовать фактические quoted identifiers текущей схемы.

## Измерение

Создать `docs/performance/03-query-analysis.md` и записать:

- версию PostgreSQL и объём данных;
- точный SQL/сценарий;
- план до и после;
- execution time и buffers;
- какой N+1 найден и сколько запросов стало после исправления;
- ограничения результата. Один локальный замер не объявлять production SLA.

## Тесты

- точное и частичное совпадение title;
- ranking более похожего title выше менее похожего;
- регистронезависимость и стабильный tie-break;
- пустой/короткий/слишком длинный query — `400`;
- limit/offset defaults и границы;
- response не содержит content;
- документы другого workspace отсутствуют;
- outsider получает `404`, все четыре роли с view permission — `200`;
- специальные символы не ломают SQL и не создают injection.

## Не входит в задачу

Поиск по content, Elasticsearch/OpenSearch, semantic search, Redis cache и изменение RBAC.

## Критерии приёмки

- Расширение и индекс создаются новой migration на чистой и заполненной БД.
- Search контракт и permission rules соблюдаются.
- Нет запросов к БД внутри цикла в исследованных сценариях.
- В репозитории есть воспроизводимый EXPLAIN-отчёт.
- Backend проверки и e2e-тесты проходят в Docker Compose.

