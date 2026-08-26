# Задача 8. Идемпотентные платежи, concurrency и webhooks

> [!summary] Результат
> Тестовый платёж создаётся один раз при повторах/конкуренции, webhook проверяется и дедуплицируется, а сбой после внешнего успеха восстанавливается reconciliation job.

## Границы и provider

Интеграция учебная: реальные деньги и карточные данные не используются. Создать `PaymentProvider` и `FakePaymentProvider`, работающий как отдельный сервис в Docker Compose. Backend знает только provider customer/payment IDs и статус.

## Новые термины и связь с Workspace Docs

- **Idempotency** — повтор одной команды приводит к тому же результату, а не ко второму списанию.
- **Concurrency** — два запроса выполняются одновременно и могут прочитать одно старое состояние.
- **Webhook** — входящий HTTP request от provider о событии платежа.
- **Reconciliation** — периодическая сверка локального статуса со статусом provider после неизвестного результата.
- **State machine** — фиксированный список статусов и разрешённых переходов между ними.

Payment привязан к `Workspace`, потому что оплачивается функция workspace, и к `User`, который начал операцию. Добавьте `backend/src/payments/`, fake-provider service в Compose, migration и e2e-файл. Не добавляйте поля карты в Prisma schema.

Provider закрывается интерфейсом, чтобы тест не ходил в реальную сеть:

```ts
export interface PaymentProvider {
	createPayment(input: {
		idempotencyKey: string;
		amountMinor: number;
		currency: 'RUB';
	}): Promise<{ providerPaymentId: string; status: ProviderPaymentStatus }>;

	getPayment(providerPaymentId: string): Promise<ProviderPayment>;
}
```

Unique constraint — обязательная защита от race, обычного `findFirst` недостаточно:

```prisma
model Payment {
  // остальные поля
  userId         String
  idempotencyKey String
  requestHash    String

  @@unique([userId, idempotencyKey])
}
```

Webhook signature проверяется по raw body до обработки JSON:

```ts
const expected = createHmac('sha256', secret).update(rawBody).digest();
const received = Buffer.from(signature, 'hex');
if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
	throw new UnauthorizedException();
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

## Порядок выполнения

1. Зафиксировать Prisma models, constraints и state machine tests.
2. Поднять fake provider и реализовать adapter contract.
3. Реализовать один create request, затем idempotent repeat и parallel race.
4. Добавить raw-body webhook signature и event deduplication.
5. Подключить общий transition service и out-of-order tests.
6. Добавить reconciliation job, audit/redaction и failure recovery e2e.

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
