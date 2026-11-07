# Контекст Task 6: RabbitMQ

## Checkout и база

- Ветка: `TT6-RabbitMQ`, создана от `TT6-background-export-jobs-and-worker`.
- Проверенная база: `e548f570a08e495764494cf12064b51e3f3ee99e`.
- Task 6 реализована и проверена; состояние используется для стартовых баз.
  Постоянные work-rules не менялись.

## Существующие контракты

- NestJS + Prisma/PostgreSQL: Controller → Service → PrismaService, feature modules.
- POST workspace exports атомарно создаёт ExportJob + OutboxEvent и отвечает 202.
  GET/DELETE export доступны автору либо OWNER; outsider получает hidden 404.
- Worker проверяет membership, CAS claim, processingToken, heartbeat и cancel.
  CSV использует keyset pages по 500, backpressure и S3 multipart adapter.
- Каждая попытка владеет отдельным key
  `workspaces/{workspaceId}/exports/{exportJobId}/{processingToken}.csv`.
  Recovery/retention и file-only orphan cleanup сохраняют прежние контракты.
- UI использует одну кнопку: подготовка → disabled QUEUED/PROCESSING → скачивание.
  Перед скачиванием запрашивается свежая ссылка; при истечении хранения снова доступна подготовка.

## Перенос

- amqplib вместо BullMQ; Redis остаётся для кеша Task 4.
- RabbitMQ: durable quorum main/DLQ, четыре TTL retry queues и отдельная lease queue.
  Outbox ждёт publisher confirm; consumer использует prefetch 2 и manual ACK.
- Retry/DLQ подтверждаются до ACK; ошибка оставляет исходную доставку для redelivery.
  Пять попыток, backoff 5/10/20/40 секунд. Занятый lease не расходует budget.
- messageId служит корреляции: RabbitMQ допускает дубликаты сообщений/DLQ.
  Идемпотентность domain work обеспечивается PostgreSQL, а не ID брокера.
- Схема Prisma не менялась; новая migration не нужна. UI/API сохраняются.

## Ориентиры и проверки

- Код: `backend/src/queue/`, `backend/src/worker/`, Compose, `.env.example`.
- Tests: `background-exports.e2e-spec.ts` — PostgreSQL + реальный RabbitMQ, fake storage;
  `rabbitmq-exports.e2e-spec.ts` — confirms/ACK/retry/DLQ на mocks без сети и БД.
- `background-export-yandex.e2e-spec.ts` — шесть opt-in сценариев с настоящим HTTPS
  Yandex S3 (`TASK6_YANDEX_E2E=true`), выделенной тестовой БД и уникальными очередями.
  Multipart/GET/abort/retention реальны; сбои CompleteMultipartUpload управляемые.
- Task 6 и Guide 6 находятся во внешней папке учебных материалов, указанной ранее
  пользователем; документы других задач не меняются.
- Пройден 231 test с настройками Яндекса: 230 в полном прогоне и отдельный
  degraded-сценарий Redis. Ошибок нет; условные skips проверены в соответствующем режиме.
  Все 49 сценариев background exports прошли с настоящими PostgreSQL/RabbitMQ.
- `test-config.ts` изолирует ConfigService от process.env: в установленной версии
  Nest env имеет приоритет над constructor values. Очереди интеграционных тестов
  действительно уникальны; быстрые transport tests не зависят от настроек приложения.
- Сборка/обычный typecheck приложения отделены от тестов через tsconfig.json и
  tsconfig.build.json; Jest использует строгий test/tsconfig.json. Проверены build и
  typecheck копии Task 5 со всеми финальными тестами, без модулей/Prisma-типов Task 6.
- Через Computer Usage с настоящим Yandex Object Storage проверены VIEWER,
  завершение после ухода со страницы, отмена QUEUED/PROCESSING, успешный retry,
  FAILED/DLQ после пяти попыток и ошибка скачивания после истечения retention.
- Через UI скачан CSV из 40001 документа двух проектов, 7,94 MiB. Проверены все строки,
  три статуса, BOM/escaping, отсутствие content и документов чужого workspace.
- Облачные tests проверяют multipart >5 MiB, duplicate delivery, отмену активного MPU,
  cleanup при retry/FAILED и точечный retention без удаления чужого control object.
  Все созданные облачные fixtures и их записи тестовой БД очищены; итоговая проверка
  обеих тестовых областей Яндекса: 0 объектов и 0 incomplete multipart.
- Backend/frontend build, app/test typecheck, lint, format и Compose config прошли.
  Linux dev image собран; manual ACK/prefetch 2 и SIGTERM exit 0 быстрее 30 с проверены.
- Task/Guide не менялись: основные контракты согласованы; список быстрых команд
  Guide 6 пока не включает background-export-processor.e2e-spec.ts.
