# Контекст Task 8: идемпотентные платежи и webhooks

## Checkout и база

- Ветка `feature/task-8-start`, проверенная база решения Task 7:
  `182336cdc85d9435456d3c4ba8a09482bf78018a`.
- Task 7 завершена в финальном состоянии D. Task 8 ещё не реализована:
  payments module, Payment-модели, fake provider и payment reconciliation отсутствуют.
- Цель Task 8 — учебный workspace payment через fake provider, безопасный при
  повторах/конкуренции, повторных webhooks и неизвестном результате внешнего вызова.
  Реальные деньги и карточные данные не используются.

## Готовые контракты

- NestJS feature modules/DI, Controller → Service → PrismaService,
  Prisma/PostgreSQL и React/Vite. JWT устанавливает личность; AccessPolicyService
  отдельно проверяет membership, права и workspace isolation.
- Роли базы: OWNER/MEMBER/VIEWER. Document.body обязателен; физического content нет.
  HTTP DTO/JSON по-прежнему content, внутренний body не выдаётся. Create/text PATCH
  и seed пишут body; пустая строка допустима, null/нестроковое значение — 400.
- История Task 7 содержит 13 migrations, valid CHECK document_body_nn и прежний
  GIN по title. Опубликованную историю не переписывать; новая схема Task 8 требует
  новой migration, без возврата legacy Document.content.
- Redis — metadata cache-aside. Экспорт использует RabbitMQ/amqplib, ExportJob +
  OutboxEvent, отдельный worker, retries/lease/CAS и publisher confirms. Это готовый
  export-specific transport; BullMQ и его repeat scheduler в базе отсутствуют.
- Private files и metadata CSV используют S3; API/worker и инфраструктура уже
  описаны в docker-compose.yml. Сохранять прежние CRUD, cache invalidation и экспорт.

## Ориентиры Task 8

- Прочитать tasks/08-idempotent-payments-and-webhooks.md и
  guides/08-payment-idempotency-concurrency-and-webhooks-primer.md из набора задания.
- До реализации согласовать старые предпосылки спецификации с этой базой: BullMQ
  против RabbitMQ/amqplib и OWNER/ADMIN против фактических ролей без ADMIN.
  Это не требует переделки завершённой Task 7 сейчас.
- Task требует подпись до JSON parsing, а Guide описывает rawBody рядом с parsed DTO.
  Raw body в текущем bootstrap ещё не включён; точную HTTP-границу webhook уточнить
  перед реализацией, не выдавая пример Guide за уже существующее поведение.
- Нужные существующие пути: backend/src/access/, auth/, prisma/, queue/, outbox/,
  worker/, backend/src/main.ts, app.module.ts, backend/prisma/schema.prisma,
  backend/prisma/migrations/, backend/test/ и docker-compose.yml.
  Новый feature scope задания — backend/src/payments/ и отдельный fake-provider service.
- Минимальные контракты для проверки: один логический платёж при повторах и
  конкуренции; конфликт того же ключа с другим запросом; проверка подписи/дедупликация
  событий; общие переходы статусов и recovery после неизвестного provider outcome.

## Проверки

- Строгие app/test typechecks, lint/format изменённых файлов, backend/frontend build
  по затронутому scope; реальные HTTP/SQL проверки только на выделенной тестовой БД.
- Payment checks включают параллельные запросы, duplicate/out-of-order/unmatched events,
  отрицательную подпись, права/изоляцию и provider-success → local-failure recovery.
  Fake provider должен давать управляемые сценарии без случайности.
- Сохранять регрессии CRUD, Redis и sync/async CSV. S3/queues — только собственные
  fixtures с точным cleanup; секреты и sensitive payload не печатать и не коммитить.
