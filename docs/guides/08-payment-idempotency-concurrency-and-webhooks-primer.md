# Памятка к задаче 8: payment idempotency, concurrency и webhooks

> [!tip] В двух словах
> **Не списать дважды.** Network retry, два клика и повторный webhook должны приводить к одному логическому платежу.

## Почему retry опасен для POST

Клиент отправил оплату, provider её принял, но response потерялся. Клиент повторяет request. Без idempotency backend создаст второй charge.

Idempotency key связывает повторы одной операции. Backend хранит key, нормализованный request hash и результат. Тот же key + тот же request возвращает тот же payment; тот же key + другой request — конфликт.

> [!note]
> Проверка `SELECT`, затем `INSERT` без unique constraint имеет race. Истина закрепляется constraint/transaction, а не только `if` в TypeScript.

## State machine

Статус — не произвольная строка. Таблица разрешённых переходов предотвращает `SUCCEEDED -> PENDING` от запоздавшего события. Transition handler один и используется API, webhook и reconciliation.

Optimistic locking добавляет `version`:

```sql
UPDATE payment SET status = ..., version = version + 1
WHERE id = ... AND version = expected_version;
```

Ноль обновлённых строк означает concurrent change и требует перечитать состояние.

## Webhook — внешний недоверенный request

Provider подписывает raw bytes. Если сначала распарсить и пересобрать JSON, подпись может не совпасть. Сравнение подписи делают constant-time, event ID закрепляют unique constraint.

Webhook может прийти дважды, раньше API response или не по порядку. Handler должен отвечать быстро, быть идемпотентным и не предполагать идеальную последовательность.

## Reconciliation закрывает неизвестное состояние

External operation уже успешна, но backend упал до локального commit. Нельзя просто повторить charge. Reconciliation спрашивает provider по stable ID/key и синхронизирует локальный status.

## Что нельзя хранить/логировать

Номера карт, CVV, provider secret, webhook signature и raw sensitive payload. Audit хранит IDs, переходы, result/error code и correlation ID.

## Частые ошибки

- idempotency только в памяти процесса;
- key глобальный без user/operation scope;
- duplicate webhook повторяет side effect;
- webhook без signature/с parsed body;
- terminal status можно откатить;
- timeout автоматически означает payment failed;
- тестировать повторы последовательно, но не параллельно.

