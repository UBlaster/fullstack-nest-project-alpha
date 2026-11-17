# Контекст Task 8: тестовые платежи ЮKassa

## Checkout и база

- Рабочая ветка `tt8`, старт `feature/task-8-start` на
  `95329e49e2021e44838b805a165d8a4e95ff5e77`; решение Task 7 в базе —
  `182336cdc85d9435456d3c4ba8a09482bf78018a`. Стартовая ветка не изменена.
- Актуальные Task/Guide 8 выбирают настоящий API v3 ЮKassa и тестовый магазин.
  Прежний fake provider/HMAC пример не актуален. Реальные деньги не используются.
- Документы: tasks/08-idempotent-payments-and-webhooks.md и
  guides/08-payment-idempotency-concurrency-and-webhooks-primer.md из набора заданий.

## Контракты базы

- NestJS feature modules/DI, Controller → Service → PrismaService, Prisma/PostgreSQL,
  React/Vite, JWT и отдельный AccessPolicyService для workspace membership.
  Роли OWNER/MEMBER/VIEWER. Платежи доступны только OWNER; outsider 404, member/viewer 403.
- Document.body обязателен, физического content нет; DTO/JSON остаётся content.
  Исходные 13 migrations Task 7 не меняются. Redis — metadata cache, экспорт —
  RabbitMQ/amqplib + outbox/worker. S3 и прежние CRUD/экспорт сохраняются.

## Реализовано в рабочей ветке

- Payment/PaymentEvent/PaymentAudit и новая migration. Локальный user/key отделён
  от сохранённого provider UUID/body; резервирование предшествует HTTP.
  Фиксированная покупка WORKSPACE_DEMO — 10000 копеек RUB.
- PaymentTransitionService: проверенный create/webhook/reconcile snapshot, version CAS,
  атомарная привязка provider ID, переход и audit. Terminal status не откатывается.
- Публичные ответы читаются через paymentResponseSelect; providerRequest/ключи/lease
  не выбираются для GET/history. Create/reconcile читают публичное состояние после
  recover; recover/apply не возвращают полную модель. Час в миллисекундах — HOUR_MS.
- Webhook проверяется GET ЮKassa: test/shop/сумма/metadata. HMAC не используется.
  Незавершённые события имеют отдельную повторную сверку и lease в существующем worker.
- Неизвестный provider ID восстанавливается только прежним POST/key/body до 23 часов
  от первого dispatch. Позднее — needsReview без нового POST; известный ID сверяется GET.
- React: workspace checkout/history и /payments/:id/result, сохранение попытки для
  пользователя/workspace и ограниченный polling. Переходы оформлены кнопками в общем стиле.
  История Payment[] не менялась; отдельный capabilities endpoint возвращает enabled после
  проверки доступа. При выключенной интеграции создание/сверка недоступны, история видна.
  HTTP 401 ведёт на login с безопасным returnTo; поздний 401 не удаляет новую сессию.
  Секретов во frontend нет.
- Workspace с платежами сохраняет историю: DELETE возвращает 409 и предлагает archive.
  Без credentials payment feature выключен; остальные функции продолжают работать.

## Проверки и границы

- backend/test/task8-* проверяют настоящий HTTP adapter с тестовым stub и отдельную
  task8_payments_test на loopback:55437. SQL opt-in требует TASK8_PAYMENTS_E2E и отдельный URL.
  Обычный Compose обращается к ЮKassa; URL stub задаётся только DI override в тестах.
- API и worker получают одинаковую payment-конфигурацию; .env.example содержит placeholders.
  test_-gate — проектное ограничение до POST, не замена проверке response.test/shop.
  Рабочие env и секреты не менять/не печатать; проверки с записью только в test DB.
- До рефакторинга проекций backend-регрессия: 318 PASS, 0 FAIL, 51 opt-in SKIP;
  облачная Yandex suite исключена. После него SQL-регрессия целиком не повторялась.
- Актуальные targeted checks: backend response/capabilities 18 PASS, frontend 25 PASS;
  проверены публичные selections/JSON, 201/200/202, URL masking, CAS, access-before-config,
  сохранение попыток, polling и восстановление входа. Строгий test typecheck, scoped
  lint/format и обе сборки прошли. Browser smoke со stub не является оплатой в ЮKassa.
- Runbook: docs/payments/08-yookassa-test-payments.md. Настоящая ручная приёмка ЮKassa
  пока NOT RUN: нужны credentials тестового магазина, HTTPS endpoint и настройка событий.
- В текущей локальной workspace_docs применена payment migration; history/capabilities
  проверены живым HTTP для четырёх demo аккаунтов в A/B/C, все membership этих аккаунтов OWNER.
  Credentials ЮKassa отсутствуют: capabilities.enabled=false, создание/сверка отключены в UI.
- Эта локальная БД отличается от завершённой Task 7: Document.body nullable, content сохранён;
  VALIDATE/NOT NULL/DROP ещё не применены. В Document найдены 555 групп повторяющихся ID
  с разными строками, backfill остановлен без изменения содержимого. Документные endpoints
  D-client пока несовместимы с этой БД. Не продолжать contract до отдельного ремонта дубликатов.
  Backup и baseline сохранены в .local/task8-live-repair-20261117; все 14159 документов
  и membership сверены с baseline, существующие API/worker возобновлены.
