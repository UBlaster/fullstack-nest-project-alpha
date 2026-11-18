# Старт Task 9 на готовой Task 8

## Checkout и база

- Ветка `feature/task-9-start`, исходная проверенная база `tt8` — `93c67d9`.
  Здесь сохраняется готовая Task 8 со Stripe и SSE; Task 9 ещё не реализована.
  Стартовая Task 8 основана на завершённой Task 7 (`95329e4`).
- Task 8 теперь допускает одного провайдера на выбор: Stripe или ЮKassa.
  Текущее решение использует только Stripe в тестовом режиме.
- Материалы следующего задания: tasks/09-opentelemetry-logs-traces-and-metrics.md
  и guides/09-observability-logs-traces-and-metrics-primer.md из набора заданий.

## Контракты базы

- Nest feature modules/DI, Controller → Service → PrismaService, PostgreSQL/Prisma,
  React/Vite, JWT и отдельный workspace access layer. Роли OWNER/MEMBER/VIEWER;
  платежи доступны OWNER, outsider получает 404, MEMBER/VIEWER — 403.
- Схема кода после Task 7 использует обязательный Document.body, JSON/DTO — content.
  Redis остаётся metadata cache, экспорт — RabbitMQ/amqplib + outbox/worker.
  Исходные migrations Task 7 и прежняя payment migration не переписывались.

## Реализованное поведение

- Stripe SDK 23.1.0, API 2026-10-28.endive; Hosted Checkout, card-only через
  allowed_payment_method_types. WORKSPACE_DEMO стоит 1000 minor units USD.
  Карточные данные вводятся у Stripe, frontend открывает готовый URL Session.
- Payment.provider добавлен новой migration: существующие операции — yookassa,
  новые — stripe. Legacy история доступна, её checkout URL скрыт; Stripe recovery,
  webhook binding и maintenance не обрабатывают операции старого провайдера.
- Локальный user/key отделён от сохранённых provider UUID/body. Reservation до HTTP;
  request hash включает provider и цену. Повтор сохраняет исходные key/body/return URLs.
- Проверка Snapshot: test mode, Session ID, mode, сумма/валюта, metadata/client reference.
  complete+paid — успех; expired+unpaid — отмена; complete+unpaid остаётся pending
  без старой checkout-ссылки. Возврат/закрытие страницы не назначает status.
- Webhook: raw bytes + Stripe-Signature SDK verification до GET/DB, затем собственный
  authenticated GET Session и общий transition service. CAS/audit атомарны, terminal
  не откатывается; event dedup — provider/eventType/Session ID.
- Recovery неизвестного ID повторяет POST лишь до 23 часов от первого dispatch;
  позже needsReview без нового POST. Известный ID проверяется GET. Stripe может
  повторить сохранённый 500, поэтому replay не гарантирует восстановление ID.
- Payment/event leases учитывают SDK transport retry budget и SQL-запас.
  Сверка работает в существующем worker, без новой очереди или контейнера.
- Публичные поля выбираются явно. Capabilities отдаёт enabled/provider/цену без secrets;
  frontend форматирует цену, сохраняет попытки и восстанавливает login return.
  Unknown попытка автоматически не получает новый ключ.
- GET /payments/:id/events с Bearer и проверкой доступа отправляет свежий публичный
  слепок, затем изменения из общей БД через 2 секунды после предыдущего чтения.
  Timestamp-only writes не отправляются. Stop: terminal/needsReview/disconnect/5 минут.
  PaymentDetails использует fetch SSE с двумя reconnect через 1 и 2 секунды в общем
  окне 5 минут, без повторов HTTP 4xx и без HTTP polling. Ручной GET и POST reconcile сохранены.
- Workspace с платежами: hard delete — 409/WORKSPACE_HAS_PAYMENTS, archive допустим.

## Проверки и оставшиеся ограничения

- Целевые проверки готового решения: backend 117 PASS, frontend 44 PASS; types,
  scoped lint/format и diff-check прошли. Полный прежний backend-набор не запускался.
- При подготовке стартовых веток общий набор с замоканным провайдером: 13 PASS,
  строгий test typecheck и scoped lint/format прошли. Записи только в task8_stripe_test.
- Общий набор backend/test/task8-payment-contract.e2e-spec.ts использует PaymentProviderMock
  без проверки протоколов и подписей провайдеров, без фиксированной цены или валюты.
  Подключение мока к Nest DI находится в task8-payment-contract.harness.ts;
  notify передаёт уже проверенное уведомление в обработчик бизнес-событий.
  Запуск включается явно через TASK8_CONTRACT_TESTS=true и выбор файла в Jest.
  В стартовой Task 8 этот helper является заготовкой для подключения реализации ученика.
- SQL проверки использовали отдельную task8_stripe_test в существующем PostgreSQL;
  HTTP adapter — официальный SDK с управляемым test-only stub, не реальный Stripe.
  Проверено сохранение legacy Payment и default stripe при новой migration.
- Настоящий Stripe Checkout и подписанный webhook ранее проверены на отдельной БД;
  при подготовке стартовых веток живая оплата не повторялась. Для локальных webhook
  нужен работающий Stripe CLI listener, secrets остаются в игнорируемом env.
- Локальная workspace_docs всё ещё отличается от D-схемы документов: body nullable,
  content сохранён, VALIDATE/NOT NULL/DROP не применены из-за 555 групп дублирующихся ID
  и неконсистентного Document_pkey. Не продолжать contract/backfill до отдельного ремонта.
  Это ограничение локальной БД, не исправление данных в рамках Stripe-интеграции.
