# Памятка к задаче 4: Redis cache-aside

> [!tip] В двух словах
> **Быстрые повторы.** Cache снимает повторную нагрузку с БД, но добавляет вторую копию данных, которую нужно безопасно обновлять.

## Cache-aside

Приложение само управляет кешем:

```text
GET -> cache hit -> response
GET -> cache miss -> DB -> cache SET -> response
WRITE -> DB commit -> cache invalidate
```

PostgreSQL остаётся source of truth. Если Redis недоступен, запрос идёт в DB: медленнее, но правильно.

## Почему key — часть security model

Ключ `projects:list` смешает ответы всех tenants. Минимальный scope — tenant/workspace плюс все параметры, меняющие response. Если ответ зависит от пользователя или роли, эти признаки также входят в key либо кеширование происходит до персонализации.

Параметры нормализуют: `q= API ` и `q=api` должны давать один key. Длинные/чувствительные query удобно хешировать.

## TTL и invalidation решают разные проблемы

TTL ограничивает максимальное время stale data и убирает забытые keys. Invalidation обеспечивает read-after-write. Один большой TTL без invalidation показывает старые данные; очень короткий TTL превращает Redis в дорогой таймер.

Сначала commit БД, потом invalidate. Обратный порядок создаёт окно: cache очищен, параллельный reader загрузил старые данные, затем write завершился.

## Cache stampede

Когда популярный key истёк, сотни запросов одновременно идут в БД. Короткий distributed lock позволяет одному запросу пересчитать value. Lock обязан иметь expiry и token владельца; простой `DEL` может удалить уже чужой lock.

Jitter немного разносит expiry разных keys, чтобы они не протухали в одну секунду.

## Что кешировать не стоит

- редко повторяющиеся ответы;
- секреты и presigned URLs;
- permissions без продуманной invalidation;
- write response как источник истины;
- огромные objects, стоимость сериализации которых выше запроса.

## Полезные тесты

Проверяют не только одинаковый JSON, но и число DB calls, разделение tenants, инвалидирование, битый value, остановленный Redis и параллельный miss.

## Переиспользуемый сервис

```ts
async getOrLoad<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
	try {
		const raw = await this.redis.get(key);
		if (raw !== null) return JSON.parse(raw) as T;
	} catch (error) {
		this.logger.warn({ error }, 'Cache read failed');
	}

	const value = await load();
	try {
		await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
	} catch (error) {
		this.logger.warn({ error }, 'Cache write failed');
	}
	return value;
}
```

Версионный namespace упрощает invalidation:

```ts
const versionKey = `cache:team:${teamId}:version`;
const version = (await redis.get(versionKey)) ?? '0';
const listKey = `cache:team:${teamId}:v${version}:boards:${filterHash}`;

// после DB commit
await redis.incr(versionKey);
```

Старые keys не читаются и удаляются TTL. Access check всё равно выполняется до `getOrLoad`.

Для stampede lock token должен сниматься atomically:

```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
```

## Частые ошибки

- `KEYS *` в request path;
- один key для разных filters;
- access check после cache hit;
- ошибка Redis превращается в `500`;
- бессрочный lock;
- cache обновился, а DB transaction ещё не committed.
