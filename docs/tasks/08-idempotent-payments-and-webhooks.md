# Задача 8. Идемпотентные платежи, concurrency и webhooks

> [!summary] Результат
> Тестовый платёж создаётся один раз при повторах/конкуренции, webhook проверяется и дедуплицируется, а сбой после внешнего успеха восстанавливается reconciliation job.

> [!note] Связанный материал
> См. [памятку к задаче 8](../guides/08-payment-idempotency-concurrency-and-webhooks-primer.md).

## Проблема

Повторный POST, параллельные клики и повторная доставка webhook могут создать несколько логических платежей или откатить уже завершённый статус. Timeout provider оставляет неизвестный результат: автоматическое повторное списание или немедленный `FAILED` одинаково опасны.

## Предусловия

Задачи №2 и №6 завершены. Используйте готовые `AccessPolicyService`, BullMQ connection/worker и общий механизм retries; не создавайте второй access или queue layer внутри payments.

## Границы и provider

Интеграция учебная: реальные деньги и карточные данные не используются. Создать `PaymentProvider` и `FakePaymentProvider`, работающий как отдельный сервис в Docker Compose. Backend знает только provider customer/payment IDs и статус.

## Связь с Workspace Docs

Payment привязан к `Workspace`, потому что оплачивается функция workspace, и к `User`, который начал операцию. Добавьте `backend/src/payments/`, fake-provider service в Compose и migration. Не добавляйте поля карты в Prisma schema.

Provider закрывается интерфейсом, чтобы backend не зависел от деталей fake provider:

```ts
export interface PaymentProvider {
	// createPayment(...)
	// getPayment(...)
}
```

Unique constraint — обязательная защита от race, обычного `findFirst` недостаточно:

```prisma
model Payment {
  // остальные поля
  userId         String
  idempotencyKey String
  requestHash    String

  // Добавить составную уникальность, защищающую повтор одного запроса.
  @@unique([userId, idempotencyKey])
}
```

Webhook signature проверяется по raw body до обработки JSON:

```ts
export class PaymentWebhookService {
	// verifySignature(rawBody, signature): HMAC-SHA256 + constant-time compare
	// process(event): дедупликация event ID и вызов общего transition service
}
```

Один `PaymentTransitionService` должен использоваться create response, webhook и reconciliation, иначе три места начнут по-разному трактовать out-of-order events.

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

## Конфигурация и документация

Env: provider base URL, API key, webhook secret, timeouts; только placeholders в `.env.example`. Создать `docs/payments/08-idempotency-and-webhooks.md` со state machine, signature algorithm, retry/reconciliation runbook.

## Критерии приёмки

Уникальные constraints и transitions находятся в migration/code, повторная доставка безопасна, неизвестное состояние восстанавливается через reconciliation, Docker использует только fake provider. Платёжные secrets и raw sensitive payload не логируются.
