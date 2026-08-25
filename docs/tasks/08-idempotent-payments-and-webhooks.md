# Задача 8. Идемпотентные платежи, concurrency и webhooks

> [!summary] Результат
> Тестовый платёж создаётся один раз при повторах/конкуренции, webhook проверяется и дедуплицируется, а сбой после внешнего успеха восстанавливается reconciliation job.

## Границы и provider

Интеграция учебная: реальные деньги и карточные данные не используются. Создать `PaymentProvider` и `FakePaymentProvider`, работающий как отдельный сервис в Docker Compose. Backend знает только provider customer/payment IDs и статус.

## Модель данных

- `Payment`: `id`, `userId`, `workspaceId`, `amountMinor`, `currency`, `purpose`, `status`, `providerPaymentId?` unique, `idempotencyKey`, `version`, timestamps.
- unique `(userId, idempotencyKey)`.
- `PaymentEvent`: `providerEventId` unique, `paymentId?`, `type`, `payloadHash`, `processedAt?`, `result`, timestamps.
- `PaymentAudit`: paymentId, fromStatus, toStatus, reason, correlationId, createdAt. Не хранить body с секретами.

Статусы: `CREATED`, `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. Разрешённые переходы:

```text
CREATED -> PENDING | FAILED | CANCELLED
PENDING -> SUCCEEDED | FAILED | CANCELLED
terminal -> без переходов
```

## API создания

`POST /workspaces/:workspaceId/payments` требует header `Idempotency-Key` (UUID), permission `OWNER/ADMIN`, DTO `amountMinor` 100–10_000_000, `currency = RUB`, `purpose` 1–200.

1. В транзакции попытаться создать Payment по unique key.
2. При конфликте вернуть сохранённый payment и тот же HTTP result, не вызывать provider повторно.
3. Вызвать provider с тем же idempotency key.
4. Сохранить provider ID/status условным update по текущему status/version.
5. Первый запрос возвращает `201`, повтор — `200` с тем же payment ID.

Одновременные запросы с одинаковым key, но разным body получают `409`; для этого сохранить hash нормализованного request.

## Webhook

`POST /payments/webhooks/fake-provider` получает raw body. До JSON parsing проверить HMAC-SHA256 header с `PAYMENT_WEBHOOK_SECRET` и constant-time compare. Невалидная подпись — `401`.

- зарегистрировать `providerEventId` через unique constraint;
- duplicate event вернуть `200` без повторного transition;
- применить state machine транзакционно;
- out-of-order событие, которое откатывает terminal status, записать как `IGNORED`;
- неизвестный provider payment сохранить как `UNMATCHED` для reconciliation;
- быстро вернуть `200`; transient DB error — `500`, чтобы provider повторил доставку.

## Recovery

После provider success backend может упасть до update. Периодическая BullMQ job каждые 5 минут выбирает `CREATED/PENDING` старше 2 минут, запрашивает provider и применяет тот же transition handler. Ручной endpoint `POST /payments/:id/reconcile` доступен `OWNER/ADMIN`.

## Тесты

- первый и повторный request с одним key;
- одинаковый key с другим body — `409`;
- 10 параллельных запросов создают один Payment и один provider charge;
- invalid/missing signature, duplicate webhook, out-of-order events;
- provider success + падение backend восстанавливается reconciliation;
- optimistic concurrency не допускает два перехода;
- audit содержит переход, но не secret/card data;
- outsider — `404`, MEMBER/VIEWER — `403`;
- provider timeout даёт повторяемое состояние, а не второй charge.

## Конфигурация и документация

Env: provider base URL, API key, webhook secret, timeouts; только placeholders в `.env.example`. Создать `docs/payments/08-idempotency-and-webhooks.md` со state machine, signature algorithm, retry/reconciliation runbook.

## Критерии приёмки

Уникальные constraints и transitions находятся в migration/code, повторная доставка безопасна, восстановление проверено тестом, Docker использует только fake provider. Платёжные secrets и raw sensitive payload не логируются.

