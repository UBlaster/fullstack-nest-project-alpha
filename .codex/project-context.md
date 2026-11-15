# Контекст Task 7

## Checkout и итог

- Ветка TT7, база feature/task-7-start на c3198ed7307285b14914c8072bba03ee486b7c4c.
  Полная проверенная база Task 6: 15e61b5dff91c88fc1ce5633ebfd4c400cad1b32.
- Task 7 завершён целиком: подготовка, A, перенос данных, B, C, D и завершение стендов.
  Этот checkout содержит готовое решение; следующих задач здесь ещё нет.
- Подробные команды, результаты всех фаз и сводка изменений:
  docs/database/07-zero-downtime-content-migration.md.

## Финальное поведение D

- NestJS → Service → PrismaService, feature modules/DI, JWT и workspace RBAC сохранены.
  Redis кеширует metadata; RabbitMQ/amqplib обслуживает фоновый CSV с отдельным worker.
  Private files/CSV используют прежний S3 bucket; внешний API не переименовывался.
- Document.body — обязательная строка в SQL/Prisma D, legacy content в модели/БД отсутствует.
  HTTP DTO/JSON по-прежнему content: mapper явно собирает прежние поля из body и скрывает
  внутренний body. Author/project и nested documents сохранены; frontend не менялся.
- Create/text PATCH и seed пишут только body. Title-only PATCH текст не трогает.
  Null/нестроковый content даёт HTTP 400 до записи; пустая строка допустима.
- DocumentsService, ProjectsService nested documents, AccessPolicy.requireDocument и
  возвращаемые записи используют явные проекции. SQL C/D независим от legacy,
  включая file/capabilities authorization и seed upsert select:{id:true}.
- История содержит 13 реальных migrations: исходные 7, expand A, nullable legacy B,
  затем 20261112191141_document_body_check, 20261112191142_document_body_check_validate,
  20261112191143_document_body_not_null, 20261112191144_document_content_drop.
  Каждая DDL в отдельной короткой транзакции с lock 1s / statement 5s.
  Valid CHECK document_body_nn оставлен, прежний GIN title/gin_trgm_ops сохранён.
- Backend/scripts/backfill-document-body.ts — исторический инструмент только A:
  missing/reconcile, keyset, короткие commits/restart. Current D client отвергается
  до подключения к БД; из операционных C/D artifacts alias/script исключены.
  После первого C копирование content → body и запуск A/R0 запрещены.
  После contract код можно вернуть только к проверенному C; схему исправлять вперёд.

## Обычный запуск и сохранённые данные

- Все созданные runtime-процессы и учебные контейнеры остановлены. Исходные .env,
  Compose и Dockerfiles не менялись; три env-файла проверены по исходным SHA-256.
- Проверенный обычный D-контур — отдельный Compose project task7-final, со своими
  тремя сохранёнными volumes и seed из 3600 документов. Старый project/volumes сохранены.
  Для запуска использовать ровно 7 сервисов, без ненужного workspace service:
  docker compose -p task7-final up -d postgres redis rabbitmq db-init backend worker frontend
- task7-pg, task7-redis, task7-rabbitmq тоже остановлены, volumes не удалены.
  В task7_dev и task7_rehearsal финальная D-схема и по 3600 исходных seed-документов;
  каждый body проверен против исходного текста. Rehearsal runtime fixtures удалены,
  остались 4 seed users, 3 workspace, 120 projects; files/jobs/outbox пусты.
- Frozen artifacts R0/A/A-backfill/B/C/D и manifest/client/build hashes сохранены в
  .local/task7/artifacts. Тот же C проверен после D без пересборки/генерации клиента.
  Backups до contract и итоговый D до cleanup — .local/task7/backups.
- Закрытые env/fixtures и учёт ресурсов остаются только в .local/task7; их значения
  не выводить/не коммитить. Bucket не удалялся: собственные 7 export objects удалены,
  9 известных ключей подтверждены отсутствующими. Redis regression DB1 очищена;
  чужие объекты/queues/volumes не затрагивались.

## Проверки

- Полная регрессия D: 273 PASS, 46 opt-in SKIP, 17 активных suites. Строгие app/test
  typechecks, ESLint/Prettier изменённых файлов, backend и frontend build прошли.
- A/перенос/B проверены ранее. B и C прошли по 10 минут: по 172 чтения и 43 записи
  через два instances/два workspace; пустой/Unicode текст, права, целостность и логи.
- Same frozen C suite до/после D: 11/11 в каждой фазе; неизменность 95 исходников,
  18 файлов клиента и 4 test/config файлов подтверждена. SQL без legacy проверен.
- На заполненной rehearsal проверены lock timeout/rollback/history recovery,
  все 4 DDL в budget, C/D CRUD и реальные file upload/download/delete, оба workers,
  S3 CSV, cache invalidation и D → C → D без отката схемы. Новых migration-related 5xx нет.
- Fresh обычный Compose D: 13/13 migrations, seed3600, frontend, CRUD, Redis TTL/cache,
  sync/async CSV и S3 проверены; собственные fixtures удалены, очереди пусты.
- Исторические A/B/backfill fixtures используют typed parameterized SQL для своих
  схем. Обычные тестовые DB-fixtures переведены на body; HTTP content сохранён.
  У старых heartbeat/outbox тестов устранены readiness races; подтверждён clock skew
  Docker PG вперёд на 160–164ms. Production export-код и системные часы не менялись.
- Фазовые тесты совместимы со стартовой Prisma-моделью без body. Test-only contract
  helper загружает backfill CLI лениво и не содержит его реализации. Без CLI/opt-in
  no-DB suites пропускаются; явный opt-in без реализации даёт понятный FAIL.
  После этих переносимых адаптаций повторно прошли строгий test typecheck,
  lint/format и 29 no-DB checks; полная инфраструктурная регрессия не повторялась.
- Сводки в .local/task7: final-regression-results.local, final-data-verification.local,
  release-d-results.local, rehearsal-cleanup-results.local,
  rehearsal-containers-stop-results.local и final-compose-*.local.
  Новая задача ещё не начата; состояние Task 7 не подменять будущим планом.
