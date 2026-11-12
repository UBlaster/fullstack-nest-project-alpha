# Контекст стартовой базы после Task 6

## Checkout и база

- Ветка: `feature/task-7-start`.
- Проверенная полная база Task 6: `15e61b5dff91c88fc1ce5633ebfd4c400cad1b32`.
- Код и тесты Task 6 сохранены полностью. Следующее задание ещё не реализовано;
  его Task/Guide и цель нужно прочитать перед началом работы.
- Подготовка Task 7: PATCH документа отклоняет `content: null` и другие нестроковые
  значения на HTTP-границе; отсутствие поля и пустая строка допустимы.
  Схема `Document` не менялась, перенос `content` в `body` ещё не начат.

## Уже реализовано

NestJS + Prisma/PostgreSQL backend с DI, feature modules и
Controller → Service → PrismaService; React/Vite frontend.
JWT, workspace RBAC/isolation, CRUD/search, Redis cache-aside и private-файлы Yandex S3.

- Task 5: presigned file upload/download, DocumentFile lifecycle, синхронный CSV.
- Task 6: фоновый workspace CSV, отдельный worker и RabbitMQ через amqplib.
  Redis используется для кеша, транспорт jobs — RabbitMQ.
- `POST /workspaces/:workspaceId/exports` атомарно создаёт ExportJob + OutboxEvent,
  отвечает 202; `GET/DELETE /exports/:id` доступны автору либо OWNER.
  Для чужого workspace возвращается hidden 404.
- Durable quorum main/DLQ, четыре TTL retry queues, lease queue,
  publisher confirms, manual ACK/prefetch 2; пять попыток, backoff 5/10/20/40 секунд.
  Идемпотентность обеспечивается PostgreSQL/CAS, processingToken и heartbeat.
- CSV: keyset pages, backpressure, S3 multipart; cancel/recovery/retention выполняют
  точечный cleanup своих attempt keys. File orphan cleanup ограничен documents namespace.
- UI: одна кнопка подготовка → disabled QUEUED/PROCESSING → скачивание;
  свежая ссылка перед скачиванием и возврат к подготовке при истечении хранения.
- Prisma models ExportJob/OutboxEvent и migration Task 6 уже существуют.
  API/worker подключены в Compose, есть отдельные debug profiles и безопасная S3-диагностика.

## Ориентиры и проверки

- Код: `backend/src/exports/`, `outbox/`, `queue/`, `worker/`, `storage/`,
  `frontend/src/pages/project/ui/ProjectPage.tsx`.
- Тесты Task 6: API/worker, processor, RabbitMQ transport, storage/shutdown/orphans;
  `background-export-yandex.e2e-spec.ts` — opt-in настоящий Yandex S3
  (`TASK6_YANDEX_E2E=true`), отдельная тестовая БД и уникальные очереди.
- Пройден 231 test: 230 в полном прогоне с настройками Яндекса и отдельный Redis-down.
  Проверены реальный multipart >5 MiB, скачивание CSV из 40001 документа через UI,
  cancel/retry/DLQ/retention; ошибки CompleteMultipartUpload создавались управляемо.
  Собственные облачные fixtures очищены, остаток объектов и incomplete multipart — 0.
- Backend/frontend build, строгий app/test typecheck, lint и Compose проверены.
  После удаления английских комментариев дополнительно пройдены 13 diagnostic tests.
- Сборка приложения отделена от тестов через `tsconfig.build.json`;
  Jest использует строгий `backend/test/tsconfig.json`.
  `test-config.ts` изолирует ConfigService от process.env.
- Проверки с записью выполняются только на выделенной тестовой БД и собственных S3 fixtures.
  Общую схему/опубликованные migrations не переписывать без требования нового задания.
- `update-document-validation.e2e-spec.ts`: 9 проверок настоящего ValidationPipe/DTO
  без БД и сети прошли; ESLint и Prettier изменённых файлов также прошли.
