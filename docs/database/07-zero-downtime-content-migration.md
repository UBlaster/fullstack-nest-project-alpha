# Task 7: перенос Document.content в Document.body

## Текущий этап и граница выполнения

Подготовка, A, перенос данных, B и C завершены, включая отдельные десятиминутные
окна полного B и C. Contract D применён в rehearsal: body обязателен, legacy content
удалён; тот же замороженный C artifact/client работает после D, откат D → C → D проверен.
Новый обычный Compose-контур `task7-final` поднят из исходных env/Compose/Dockerfiles:
fresh seed 3600, frontend/CRUD/кеш/экспорт прошли smoke.

Пользователь снял прежнюю паузу и поручил закончить оставшиеся этапы. **Task 7 завершена**:
полная регрессия D, dev deploy, backend/frontend сборки и уборка собственных fixtures
прошли. Native rehearsal API/worker и три учебных контейнера остановлены; все семь
services обычного Compose-контура тоже остановлены с сохранением D-данных, volumes,
images и backups. Утренний запуск — подготовленный `task7-final` с 3600 документами
по команде ниже. Commit/push не выполнялись.

## Подготовленный контур

- База R0: commit `c3198ed7307285b14914c8072bba03ee486b7c4c`.
  R0 сохранён в `.local/task7/artifacts/R0`, с собственными dependencies и
  Prisma Client 6.19.0. Его generate/build прошли; исходники сверены с архивом.
- PostgreSQL 16: `task7-pg`, loopback-порт 55437, volume `task7-pg-data`.
  `task7_dev` — разработка; `task7_shadow` — только служебная shadow БД;
  `task7_rehearsal` — отдельная копия R0 для совместного запуска API.
- До A dev/rehearsal содержали по 4 пользователя, 3 workspace, 120 проектов и
  3600 документов. DocumentFile, ExportJob и OutboxEvent были пусты.
  Backup R0: `.local/task7/backups/task7-base.dump`.
- Redis: `task7-redis`, loopback-порт 56379, appendonly/noeviction.
  RabbitMQ: `task7-rabbitmq`, фиксированный hostname `task7-rabbitmq`,
  AMQP 55672 и Management 55673, опубликованы только на loopback.
  Проверки готовности контейнеров пройдены; это не проверка приложения.
- Закрытые настройки: `.local/task7/postgres.env` для dev/shadow,
  `.local/task7/rabbitmq.env` для брокера,
  `.local/task7/rehearsal.env` для API/worker. Рабочие `.env` не менялись.
  Значения, строки подключения и JWT в runbook не записываются.
- Сохраняется прежний учебный S3 bucket. Разрешены только собственные уникальные
  fixture-объекты, учёт — `.local/task7/resources.local`.
  Не удалять bucket и не запускать общий orphan apply. Рабочие objectKey/jobs
  в rehearsal не копируются. Пробный собственный объект уже удалён.

API R0/A и worker одного rehearsal-контура используют одну PostgreSQL-БД,
один учебный Redis и одну топологию `rehearsal-exports`/`rehearsal-exports-dead`.
Рабочие кеши и очереди к этой репетиции не подключаются.

## Состав поставок и migrations

R0 включает исходные семь migrations, без изменений опубликованного SQL:

1. `20260818000000_init`.
2. `20260822190000_store_plain_password`.
3. `20260901120000_simplify_roles_and_add_workspace_status`.
4. `20260903140000_enable_pg_trgm`.
5. `20260903141000_add_document_title_trigram_index`.
6. `20260905120000_add_document_files`.
7. `20260906120000_add_background_exports`.

A сохранён в `.local/task7/artifacts/A`: отдельные код/schema/client/dependencies
и эти же семь migrations плюс `20261112155553_document_body_expand`.
Будущие B/contract migrations в A не входят. Общий `docker compose up` для
управления фазами не используется: db-init применяет все pending migrations и seed.

Для переноса отдельно сохранён `.local/task7/artifacts/A-backfill/backend`:
CLI, package/tsconfig, Prisma schema/восемь migrations A и самостоятельная копия
dependencies с клиентом A. SQL/API/schema работают в прежней фазе A; исходники и
client работающего API не подменяются при запуске CLI.

Prisma A: `content String`, `body String?`. Существующий
`Document_title_trgm_idx` остаётся GIN-индексом по title с `gin_trgm_ops`;
schema явно описывает этот прежний индекс. Новая migration добавляет только body:

```sql
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE "Document" ADD COLUMN "body" TEXT;

COMMIT;
```

Ожидаемый lock — ACCESS EXCLUSIVE. Бюджеты относятся к ожиданию lock и одной
SQL-команде соответственно. В rehearsal запись Prisma migration history показывает
17,205 мс от started_at до finished_at для этой migration с одной DDL-командой.
Вся CLI-команда deploy заняла 15,3 с; это не длительность блокировки таблицы.
Отдельное время ALTER без транзакционной/миграционной обвязки не измерялось.
Пустая migration для выпуска кода без изменения схемы не создаётся.

## Поведение A

Источник истины — **content**, включая ответы API. Create и текстовый PATCH
пишут content/body одной Prisma-операцией. PATCH без content меняет только
переданные другие поля; `content: ""` допустим, null/нестроковое значение — HTTP 400
до сервиса. Старые строки могут пока иметь body NULL.

Все публичные Document-ответы и nested documents проекта явно выбирают прежние
поля без внутреннего body. Сохранены author/project, RBAC/tenant isolation,
инвалидация кеша и metadata-only search/CSV. Seed A выполняет dual-write.

R0 продолжает записывать только content. Поэтому во время R0 + A расхождение
content/body возможно и является предметом последующей отдельной reconciliation;
чтение A пока должно возвращать актуальный legacy content.

## Команды для повторения репетиции A

Приведённые команды показывают порядок повторения уже выполненной репетиции.
`<A_ROOT>`/`<R0_ROOT>` — корни соответствующих сохранённых поставок;
`<REHEARSAL_ENV>` — полный локальный путь к `.local/task7/rehearsal.env`.
Перед каждой группой команд выполнить preflight из Guide 7 §1.2, убрать
конфликтующие process-env overrides и подтвердить rehearsal targets без секретов.

Из `<A_ROOT>/backend` проверить разрешённый набор pending migrations и применить A:

```text
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate status
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate deploy
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate status
```

Generate/build каждого artifact выполняются до запуска; не менять client/files
под работающим соседом. На rehearsal не использовать migrate dev и не запускать seed.

Запуск двух API — разные терминалы/каталоги, с одним rehearsal env:

```powershell
# Windows PowerShell: из <R0_ROOT>/backend; для A выбрать <A_ROOT>/backend и PORT 3008.
$env:PORT = '3007'
node --env-file="<REHEARSAL_ENV>" dist/src/main.js
```

```bash
# macOS zsh/bash: из <R0_ROOT>/backend; для A выбрать <A_ROOT>/backend и PORT 3008.
export PORT='3007'
node --env-file="<REHEARSAL_ENV>" dist/src/main.js
```

Третий терминал, `<A_ROOT>/backend`, после того же preflight:

```text
node --env-file="<REHEARSAL_ENV>" dist/src/worker/worker.js
```

Проверить health и authenticated CRUD обоих API. Затем по Guide 7 §§3.7–3.8:
инвалидацию общего учебного кеша через соседний API, фоновый metadata CSV,
контролируемую гонку A-write → R0-write и legacy-read через A.
Сохранить fixture IDs и ожидаемые результаты без текста/JWT в отчёте.

## Verification, остановка и откат A

На выбранной учебной БД проверить target и counts, без выдачи текста:

```sql
SELECT current_database();

SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE "body" IS NULL) AS missing,
       COUNT(*) FILTER (WHERE "body" IS DISTINCT FROM "content") AS mismatch
FROM "Document";
```

На A nullable body у старых строк ожидаем; требование missing=mismatch=0
относится к будущему переходу B после переноса и drain всех legacy-only writers.
Для новых A-записей отдельно проверять равенство полей, сохранение пустого текста,
title-only update, HTTP-валидацию и workspace isolation.

DDL timeout, неожиданный migration-related 5xx, нарушение прав или потеря данных —
остановить следующий шаг. При failed migration проверить фактическую схему/history;
resolve --rolled-back допустим только после подтверждённого rollback SQL.
Не переписывать применённую migration и не делать reset общей БД.

До первого C допустим A → R0 с сохранённой expanded schema. Перед сменой остановить
новый трафик A и дождаться его запросов/транзакций. Возвращение R0/старого seed
возобновляет legacy-only writes: перед B снова требуется drain и полная сверка.
Сам rollback не является разрешением запустить backfill.

## Результаты первоначальной репетиции A

- Expand применён ко всем трём целевым учебным БД; `content` остаётся NOT NULL,
  `body` nullable, прежний GIN-индекс сохранён. Старые 3600 строк не переносились.
- Сборки рабочего backend и отдельного A, строгие app/test typechecks прошли.
  ESLint/Prettier изменённых TS-файлов и проверка diff прошли.
- Целевые suites: 21/21 PASS. Новый suite использует реальные HTTP/Prisma/AccessPolicy
  на `task7_release_a_test`, изолируя аутентификацию и кеш. Он проверяет dual-write,
  конкурентные записи, title-only race, API без body, 400 без записи и tenant/RBAC.
- Seed A отдельно выполнен на свежей тестовой БД: 3600 документов,
  missing=0, mismatch=0. Это не backfill исходной dev/rehearsal БД.
- Реальные R0/A проверены на 36 HTTP-запросах, максимум 478,02 мс, новых 5xx нет.
  JWT каждой версии принят соседней. Проверены инвалидация Redis между версиями,
  пустой/Unicode текст, title-only update и отклонение null без изменения строки.
- A создал fixture с content/body=a; R0 изменил только content на b. A читает b,
  а title-only update сохраняет это расхождение. Отдельный R0-create оставил body NULL.
  Оба fixture сохранены для следующего этапа, их ID находятся в локальном учёте.
- Настоящий worker A выполнил экспорт через RabbitMQ в S3: COMPLETED/progress=100,
  CSV скачан и содержит прежние metadata-поля и известные fixture IDs.
  Ready/unacked/DLQ после проверки равны 0; у main queue один consumer A.
- После drain R0 остановлен. В rehearsal 3602 документа, missing=3601,
  mismatch=3602: это ожидаемо до переноса. Нулевые counts пока не являются гейтом A.
- Локальные доказательства без публичной выдачи credentials: `release-a-results.local`,
  `processes.local`, `resources.local` внутри `.local/task7/`. Файл
  `rehearsal-fixtures.local` содержит закрытые данные учебной учётной записи и ID;
  его содержимое не выводить в отчёт и не добавлять в Git.
- Следующий раздел фиксирует последующий перенос и разрешённый откат A → R0.
  Эти результаты не относятся к будущим B/C/D.

## Перенос данных до B

Реализация — `backend/scripts/backfill-document-body.ts`, alias из `backend`:
`npm run backfill:document-body -- --dry-run`. Alias сам не выбирает учебную БД:
до запуска обязательны preflight и явно загруженное окружение нужной фазы A.

В репетиции CLI выполнялся из `.local/task7/artifacts/A-backfill/backend`.
Перед командами убрать конфликтующие process-env overrides по Guide 7 §1.2 и
подтвердить `task7_rehearsal`/учебные targets без вывода credentials.
`<REHEARSAL_ENV>` — полный путь к закрытому rehearsal env:

```text
node --env-file="<REHEARSAL_ENV>" -r ts-node/register scripts/backfill-document-body.ts --dry-run
node --env-file="<REHEARSAL_ENV>" -r ts-node/register scripts/backfill-document-body.ts --batch-size=500 --max-batches=100
node --env-file="<REHEARSAL_ENV>" -r ts-node/register scripts/backfill-document-body.ts --mode=reconcile --dry-run
node --env-file="<REHEARSAL_ENV>" -r ts-node/register scripts/backfill-document-body.ts --mode=reconcile --batch-size=500 --max-batches=100
```

`missing` меняет только NULL; `reconcile` исправляет заполненные расхождения из
актуального `d.content` в SQL. Page содержит все просмотренные ID, текст из JS
не копируется. Каждая партия коммитится отдельно; progress и пауза 100 мс идут
после commit. Lock/statement timeout — 1s/5s. Cursor при restart снова NULL.
Counts считаются по всей таблице, а не только по последней странице.

Dry-run возвращает 0 и не пишет; реальный остаток даёт exit 2, ошибка — 1.
Нулевой remaining одного режима не заменяет проверку второго. После ограниченных
запусков повторены полные missing/reconcile с начала до `exhausted=true`, затем
SQL counts и проверка известных fixtures. Этот CLI допустим только в A после
drain legacy writers и до B; в C/D и после C → B его не запускать.

Фактические результаты:

- 33/33 новых теста: 23 parser и 10 real SQL на отдельной пустой
  `task7_backfill_test`, с opt-in/explicit target и уборкой собственных fixtures.
  Строгий test/CLI typecheck, ESLint/Prettier прошли.
- Проверены dry-run без записей, разные batches, неизвестные/повторные flags,
  `--max-batches=1` с exit 2, остановка настоящего процесса после committed progress
  и restart. Уже записанный batch сохранился.
- Тест с настоящим row lock увидел ожидающий UPDATE в `pg_stat_activity`:
  commit A до 1s сохранил свежую пару content/body. Отдельный lock timeout 55P03
  откатил текущую партию и сохранил ранее закоммиченную.
- До переноса rehearsal: total=3602, missing=3601, mismatch=3602.
  После missing: total=3615, missing=0, mismatch=1. Сохранённая гонка a → b
  осталась body=a, что подтвердило ограниченность NULL-only режима.
  Reconcile исправил её на body=b; counts стали нулевыми.
- В runtime-репетиции создан dual-write fixture с управляемым ID позади cursor.
  Новый проход с начала его охватил. В отдельном SQL-тесте нарушение writer-контракта
  позади cursor обнаружилось глобальным remaining и исправилось при restart.
- A параллельно делал create/text PATCH/title-only PATCH: 58 циклов нагрузки.
  Настоящий worker завершил RabbitMQ → S3 CSV во время CLI; metadata-контракт и
  известные ID сохранились. Всего скрипт переноса выполнил 203 HTTP-запроса,
  максимум 298,53 мс, неожиданных 5xx нет.
- До B проверен A → R0 → A без отката схемы, с drain API и worker перед сменой.
  R0 сделал legacy PATCH/create; total=3616, missing=1, mismatch=2.
  A после возврата прочитал актуальный content. API и worker R0 снова выведены;
  missing/reconcile и полные контрольные проходы повторены. Откат включил 6 HTTP.
- Итог rehearsal: total=3616, missing=0, mismatch=0, nullLegacy=0.
  Для 16 известных fixtures проверены ожидаемый текст, длины и MD5 обоих полей,
  включая пустой/Unicode/длинный текст. Полная SQL-сверка дополнительно равна нулю.
- На выделенной `task7_dev` отдельно выполнены dry-run, missing/reconcile и
  контрольный проход: 3600 документов, missing=mismatch=0; число строк сохранилось.
- Итоговые writers — только A/API и worker A. R0 и копирующие CLI остановлены;
  обычные рабочие `.env`, Dockerfile и Compose не менялись.

Безопасные локальные результаты: `.local/task7/backfill-results.local`,
`backfill-rollback-results.local`, `backfill-dev-results.local`. Закрытые ID/данные
synthetic fixtures — `backfill-fixtures.local`; их не добавлять в Git.
Результаты этого раздела относятся к переносу до B; самостоятельный rollout B описан ниже.

## Release B: nullable legacy и переключение чтения

Источник реализации: `backend/src/documents/document-response.mapper.ts`,
`document-response.select.ts`, `DocumentsService` и `ProjectsService.get`.
B атомарно пишет content/body, читает `body ?? content` и явно возвращает JSON
content без внутреннего body. Пустая строка сохраняется; два NULL дают ошибку
целостности, fallback и ошибки учитываются структурированными событиями без текста.
API/worker пишут release/instance ID при старте.

Поставка `.local/task7/artifacts/B/backend` содержит собственные исходники,
dependencies, Prisma Client B и build. SHA-256 всех 96 production-файлов сверены
с рабочими исходниками; список — `.local/task7/artifacts/B/source-manifest.json`.
Generated DMMF подтверждает nullable content и body; клиент A остался отдельным
и по-прежнему ожидает обязательный content. Файлы работающих A/R0 не подменялись.

История B — девять migrations: исходные семь, expand A и новая
`20261112173951_document_content_nullable`. Contract в поставку не входит.
Prisma B: `content String?`, `body String?`. SQL девятой migration:

```sql
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE "Document" ALTER COLUMN "content" DROP NOT NULL;

COMMIT;
```

### Команды и условия B

`<B_ROOT>` — `.local/task7/artifacts/B`, `<DEV_ENV>` — закрытый
`.local/task7/postgres.env`, `<REHEARSAL_ENV>` — закрытый rehearsal env.
Рабочий каталог — `<B_ROOT>/backend`. Перед командами убрать конфликтующие process-env
overrides по Guide 7 §1.2 и подтвердить выбранные dev/shadow или rehearsal targets.
Сначала подготовить B с собственным клиентом и build, без применения схемы при generate:

```text
node --env-file="<DEV_ENV>" node_modules/prisma/build/index.js generate
node --env-file="<DEV_ENV>" node_modules/@nestjs/cli/bin/nest.js build
```

После нулевой сверки A и готовности B проверить pending history и применить
только подготовленную историю B к rehearsal:

```text
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate status
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate deploy
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate status
```

Для API B использовать отдельные терминалы. Первый — PORT 3009/instance B-1;
второй — PORT 3010/instance B-2, из того же неизменяемого B artifact:

```powershell
# Windows PowerShell, первый API; во втором терминале выбрать 3010 и B-2.
$env:PORT = '3009'
$env:TASK7_INSTANCE_ID = 'B-1'
node --env-file="<REHEARSAL_ENV>" dist/src/main.js
```

```bash
# macOS zsh/bash, первый API; во втором терминале выбрать 3010 и B-2.
export PORT='3009'
export TASK7_INSTANCE_ID='B-1'
node --env-file="<REHEARSAL_ENV>" dist/src/main.js
```

Worker B — отдельный процесс из `<B_ROOT>/backend` после того же preflight:

```text
node --env-file="<REHEARSAL_ENV>" dist/src/worker/worker.js
```

До первого C допустим B → сохранённый A без отката nullable-схемы: B ещё
dual-write. Перед заменой процессов прекращать новый трафик и дожидаться drain.
После возврата к полному B убрать все A/required-content clients и заново пройти
гейт B. CLI content → body относится только к завершённой фазе A до B.

### Фактические результаты rollout B

- 17/17 новых B-тестов с реальными SQL/HTTP прошли, включая fresh seed из 3600
  документов. Четыре ожидания прежнего A-suite узко адаптированы к nullable-типам B;
  сохранённый artifact A не менялся. Строгие app/test typechecks, lint B и build B прошли.
- В управляемом lock-тесте server-side lock timeout подтверждён; SQL откатился,
  прежнее NOT NULL сохранилось до успешного повторения. В явной failed transaction
  Prisma показал вторичную ошибку `current transaction is aborted`, а logs могли
  остаться NULL. Её не выдаём за первоначальный PostgreSQL SQLSTATE.
- Только после подтверждения фактического rollback выполнен
  `migrate resolve --rolled-back` с точным именем B migration, затем повторён deploy. В migration history
  сохранены три rolled-back попытки и одна успешная. Две ранние проверки harness
  не приняли вторичную ошибку Prisma; SQL migration при этом не менялся.
  Failed history не скрывалась и не очищалась; согласованное состояние восстановлено.
- Успешная запись B migration history заняла 8,473 мс от started_at до finished_at.
  Это время миграционной обвязки, а не отдельно измеренная длительность lock.
  Во время DDL A выполнил 69 циклов нагрузки; всего rollout включил 187 HTTP,
  максимум 988,31 мс, новых неожиданных 5xx нет.
- Проверены общие JWT, инвалидация Redis между A/B и внутри полного B, чтение/запись
  соседними версиями и разрешённый откат B → A → B до C.
- После drain worker A API A поставил экспорт. Перед запуском worker B настоящие
  счётчики RabbitMQ через `rabbitmqctl` дали ready=1, unacked=0, consumers=0.
  Worker B обработал прежнее сообщение до COMPLETED; CSV скачан и проверен.
  Management statistics могут запаздывать и не заменяют эти точные счётчики.
- Перед rollout rehearsal содержала 3616 документов, missing=mismatch=nullLegacy=0.
  В конце rollout — 3619 документов с теми же нулевыми counts. На тот момент активны
  были только два API B на 3009/3010 и worker B; A/R0 выведены, C ещё не запускался.

Источник результатов — `.local/task7/release-b-rollout-results.local`.

### Завершённое окно полного B

- Окно длилось 602,464 с по монотонному времени. Выполнены 172 Document GET и
  43 текстовые записи: 9 create и 34 update; 15 с пустым текстом, 28 с Unicode.
  Все четыре сочетания B instance/workspace получили чтения и записи:
  по 43 чтения, 10–11 записей на сочетание.
- Всего observer выполнил 225 ожидаемых HTTP-ответов: 210 × 200, 9 × 201,
  по два ожидаемых 400/403/404. Timeout/network errors/неожиданных ответов нет;
  максимальная задержка 239,65 мс. Отрицательные проверки подтвердили VIEWER,
  foreign workspace и неизменность строки после запрещённого/null PATCH.
- Safe startup events подтверждены для B-1/B-2/worker-B. Во всех их текущих
  логах fallback=0 и integrity_error=0. A/R0 отсутствуют; на Windows проверены
  PID вместе со временем создания, а не только kill(pid,0).
- SQL в начале и конце: missing=mismatch=nullLegacy=0. Финальная rehearsal
  содержит 3628 документов; все 12 известных B fixtures совпали с ожидаемым текстом
  в обеих колонках. Активных export jobs и unresolved migrations нет.
- Отдельно во время окна проверены инвалидация Redis B-1 ↔ B-2 и новый экспорт
  B API → worker B → S3 CSV: ещё 23 HTTP, новых 5xx нет, собственный временный
  search probe удалён. Объект экспорта учтён в resources.local.
- В main/retry/lease/DLQ ready/unacked=0; у main один consumer B.
  Текущий root backend и artifact B собраны; Prisma validate/format пройдены.

Итог **PASS**: `.local/task7/release-b-window-results.local`,
`release-b-extra-checks.local` и `release-b-final-verification.local`.
Release B завершён; этим закрыт гейт перед C.

## Release C: только body без изменения схемы

C читает и пишет только body, сохраняя внешний JSON/DTO content. Явные
Document-проекции используются в list/get/create/update/archive/delete, nested
documents проекта, проверке доступа и seed. Body NULL до contract даёт безопасную
ошибку целостности; legacy не используется как fallback. Title-only PATCH текст
не меняет, пустая строка допустима, null/нестроковое значение отклоняется до записи.
Metadata-only поиск, кеш и CSV сохраняют прежний контракт.

Поставка `.local/task7/artifacts/C/backend` содержит самостоятельные dependencies,
nullable Prisma Client C и build. Schema по-прежнему `content String?`, `body String?`;
история содержит девять migrations, нового DDL в C нет. В package этой поставки
удалён alias `backfill:document-body`, сам копирующий script не поставляется.
Manifest `.local/task7/artifacts/C/source-manifest.json` фиксирует 95 production-файлов,
18 client-файлов и 223 build-файла. До и после D все эти хеши совпали; generate или
подмена клиента под работающим C не выполнялись.

### Репетиция и окно C

- До C повторно подтверждены B-only writers, завершённые копирующие CLI и нулевые
  counts. B прочитал и обновил созданный C документ с NULL legacy; C body-only
  create/PATCH не исправляли старое content. После первого C mismatch/nullLegacy
  ожидаемы: дальнейший гейт проверяет missing body и известные body, а не равенство
  legacy с новым источником истины.
- Проверены общий JWT, инвалидация Redis B ↔ C, сообщение API B → worker C и
  разрешённый откат C → тот же сохранённый B → C. Перед worker C RabbitMQ показал
  ready=1, unacked=0, consumers=0. Возврат к A/R0 и content → body после C запрещён.
- Rollout: 51 HTTP, максимум 419,12 мс, новых неожиданных 5xx нет. Total изменился
  с 3628 до 3632; missing=0, mismatch=3, nullLegacy=1 соответствуют body-only writes.
  Результат — `.local/task7/release-c-rollout-results.local`.
- Полный C работал 602,448 с: 172 GET и 43 текстовые записи (9 create/34 update,
  15 пустых/28 Unicode). Оба API C на 3011/3012 и два workspace получили операции;
  worker C работал отдельно. Observer получил 225 ожидаемых HTTP, максимум 239,40 мс,
  timeout/network/unexpected ответов нет. VIEWER/foreign/null проверки сохранили строки.
- На старте и в конце missing body=0; проверены 13 известных fixtures. Во всех логах
  C-1/C-2/worker-C fallback/integrity_error=0. Окно **PASS**:
  `.local/task7/release-c-window-results.local`.

На отдельной C/D test DB тот же замороженный C artifact/client прошёл 11 проверок
до D и ещё 11 после D. Наблюдение SQL без parameters подтвердило отсутствие legacy
в SELECT/RETURNING/INSERT/UPDATE/условиях прикладных путей; публичный JSON content
при этом сохранился. Снимок тестов учтён в
`.local/task7/artifacts/C.tests.metadata.local`, production-поставка C не изменялась.

## Release D: contract и сохранённый C client

Финальная Prisma schema содержит `body String`, без физического content; прежний
GIN `Document_title_trgm_idx` сохранён. Поставка `.local/task7/artifacts/D/backend`
имеет собственные dependencies/client/build, 99 production-файлов и 13 migrations.
В `.local/task7/artifacts/D/source-manifest.json` записаны исходники, 18 файлов
клиента D и 223 файла build; клиент подтверждает required body и отсутствие content.
Как и в C, legacy backfill alias/script в D artifact отсутствуют.

`migrate dev --create-only` в неинтерактивной среде остановился на предупреждении
о destructive change. Эквивалентный черновик получен официальным `migrate diff`
через собственную shadow БД: только SET body NOT NULL и DROP content. После review
contract разделён на четыре versioned SQL-файла, без изменения опубликованной истории:

1. `20261112191141_document_body_check`: добавить `document_body_nn`
   CHECK (body IS NOT NULL) NOT VALID.
2. `20261112191142_document_body_check_validate`: VALIDATE тот же CHECK.
3. `20261112191143_document_body_not_null`: SET body NOT NULL, сохраняя valid CHECK.
4. `20261112191144_document_content_drop`: DROP content.

Каждый файл содержит собственные BEGIN/COMMIT, `SET LOCAL lock_timeout = '1s'`,
`SET LOCAL statement_timeout = '5s'` и ровно одну ALTER TABLE. CHECK остаётся в финальной
БД и хранится в custom SQL; отдельного поля Prisma для него нет. Проверка старых строк
идёт отдельной VALIDATE-командой, до короткого SET NOT NULL.

### Порядок поставки и фактические результаты D

Generate/build подготовлены отдельно от применения схемы. После закрытого окна C,
проверки missing=0/известных body и drain несовместимых writers сохранены отдельные
backups dev/rehearsal перед D, затем выполнен deploy. Команды из `<D_ROOT>/backend`
используют тот же preflight и явно выбранный env:

```text
node --env-file="<DEV_ENV>" node_modules/prisma/build/index.js generate
node --env-file="<DEV_ENV>" node_modules/@nestjs/cli/bin/nest.js build
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate status
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate deploy
node --env-file="<REHEARSAL_ENV>" node_modules/prisma/build/index.js migrate status
```

Generate/build сами схему БД не меняют. Во время contract сначала продолжал работать
сохранённый C; D API/worker запускались из своего artifact только после применения
всей истории. Для повторного rehearsal сначала нужен восстановленный отдельный
учебный контур подходящей фазы; исторические команды не являются текущим запуском.

- Управляемый D1 lock-test наблюдал ожидающий ACCESS EXCLUSIVE. Первичный lock timeout
  подтверждён сервером; Prisma в failed transaction показал вторичную ошибку aborted
  transaction. Сначала проверены фактическая схема, rollback и migration history,
  только затем выполнен `migrate resolve --rolled-back` для точного имени D1 и retry.
  Failed attempt сохранён в истории; его не выдаём за успешную DDL-команду.
- Успешные migration history интервалы D1–D4: 62,205 / 21,855 / 23,571 / 25,675 мс.
  Это started_at → finished_at с обвязкой, не отдельно измеренное время удержания lock.
  Все четыре DDL уложились в бюджеты; 90 HTTP-чтений выполнены во время contract.
- До D total=3641/missing=0; после total=3642/missing=0. Проверены 14 известных body.
  SQL подтвердил body NOT NULL, отсутствие content и validated `document_body_nn`.
- Тот же C API прошёл все прикладные пути на contracted schema. Реальные C API/worker
  выполнили S3 upload 4 байт, download/delete и RabbitMQ → S3 CSV после удаления legacy.
  Это дополняет 11 + 11 тестов сохранённого C, а не заменяет их сборкой D.
- D API/worker также проверены на contracted schema, выполнен откат D → тот же C → D.
  Очередь перед worker D: ready=1, unacked=0, consumers=0. Совместимость с B/A/R0
  после удаления content не предполагается.
- Итог D rehearsal **PASS**: 205 HTTP, максимум 991,71 мс, новых неожиданных 5xx нет;
  frozen C source/client/build не изменились. Источник — `.local/task7/release-d-results.local`.

### Финальные проверки D

- На выделенной `task7_dev` применены все 13 migrations; deploy/status **PASS**.
  Корневой backend D прошёл строгий app typecheck и build. Frontend прошёл tsc и
  Vite build; обычное предупреждение Vite о deprecated CJS API не стало ошибкой сборки.
- Полная регрессия D на выделенной БД: **273 PASS, 46 SKIP**, 17 активных suites,
  42,352 с (округлённо 42,4 с). Строгий typecheck всех тестов и lint/format затронутых
  tests/helpers прошли. Пропуски opt-in исторических/внешних контуров не считаются
  пройденными проверками соответствующей фазы. Безопасный агрегат фактов —
  `.local/task7/final-regression-results.local`. Отдельный Jest log не сохранялся:
  `actualLog: null`; исходный stdout/stderr остался в результате выполнения инструмента.
- Тот же C после D повторно дал **11 PASS**. Неизменность 95 production-исходников,
  18 client-файлов и четырёх файлов снимка тестов подтверждена; отдельная проверка
  frozen build ранее подтвердила 223 файла. C client не перегенерировался под D.
- Metadata fixtures шести прежних suites переведены с физического content на body.
  Исторические A/B fixtures используют typed SQL helper. Исправлены только тестовые
  ожидания готовности outbox/commit heartbeat; production-логика этих механизмов
  не менялась. Подробнее — в сводке файлов ниже.
- Финальная сверка dev и rehearsal подтвердила по 3600 документов и совпадение body
  **каждой строки** с исходным seed-текстом, а не только counts. В обеих БД body NOT NULL,
  content отсутствует, CHECK valid, GIN сохранён, migrations applied=13/unresolved=0.
  Источник — `.local/task7/final-data-verification.local`.

## Обычный запуск финального D и завершение стенда

Обычный Compose-контур проверен отдельно от rehearsal: новый project `task7-final`,
собственные свежие volumes, исходные `.env`, Compose и Dockerfiles. Их хеши совпали
до/после; учебные env не подставлялись в обычную конфигурацию. Запуск из корня проекта:

```text
docker compose -p task7-final up -d postgres redis rabbitmq db-init backend worker frontend
```

Это семь конкретных services, service workspace не запускается. PostgreSQL, backend,
worker, Redis и RabbitMQ прошли healthchecks; db-init завершился с exit 0, frontend
ответил на обычном порту 5173, API — на 3000. Обычные порты PostgreSQL/RabbitMQ
используются по исходной Compose-конфигурации. При повторном запуске сохраняются
уже созданные volumes; смена схемы обратно в R0 не требуется.

- Build и up завершились с exit 0. Fresh database прошла все 13 migrations и seed D:
  3600 документов, missing body=0, content отсутствует, body NOT NULL, GIN сохранён,
  unresolved migrations=0. Поведение seed при непустой БД осталось прежним.
- Smoke **PASS**: 37 ожидаемых HTTP, максимум 274,37 мс; frontend, Document CRUD и
  прежний content-контракт, HTTP negative checks, snapshots body, Redis warm/TTL и
  инвалидация, sync CSV, настоящий RabbitMQ worker → S3 CSV проверены.
- Собственные fixtures и объект этого Compose smoke удалены. В его БД jobs/outbox
  пусты; в семи очередях ready/unacked=0 и один consumer. Это не означает очистку
  ранее созданных rehearsal export objects.
- Доказательства: `.local/task7/final-compose-build-results.local`,
  `final-compose-up-results.local`, `final-compose-health.local`,
  `final-compose-results.local` и `final-compose-verification.local`.

### Выполненная уборка и остановка

- Rehearsal worker-D и API D-1/D-2 остановлены после drain. Перед уборкой сохранён
  финальный D backup размером 107030 байт:
  `.local/task7/backups/task7-final-D-before-cleanup-2026-11-12T19-31-12-777Z.dump`.
- Удалены семь собственных S3 exports; HEAD подтвердил 404 для девяти известных
  собственных объектов: ещё два файла ранее удалены через API. Удалены только
  два собственных workspace, два пользователя, их outbox и два своих cache keys.
- Rehearsal после cleanup: users=4, workspaces=3, projects=120, documents=3600,
  files/jobs/outbox=0, missing body=0. Схема осталась финальной D. Bucket и volumes
  сохранены. Источник — `.local/task7/rehearsal-cleanup-results.local`.
- Выделенный regression Redis DB 1 очищен от двух своих keys: before=2/after=0,
  `.local/task7/regression-cache-cleanup.local`. C/D test DB не содержит строк
  fixtures; собственных тестовых S3 objects/multipart uploads и queues осталось 0.
- Обычный `task7-final` остановлен после smoke: все семь services в exited,
  running=0; три volumes, четыре images и подготовленная D БД с 3600 документами
  сохранены. Проверены project labels, другие Compose projects не затронуты.
  Три исходных env совпали по хешам; Compose/Dockerfiles не менялись.
  Источник — `.local/task7/final-compose-stop-results.local`.

После финальной read-only сверки остановлены и учебные контейнеры `task7-pg`,
`task7-redis`, `task7-rabbitmq`: все exited/running=false. Volumes и backups сохранены,
исходные проекты не затронуты. Результат **PASS** —
`.local/task7/rehearsal-containers-stop-results.local`. Оба стенда завершены без
удаления сохранённых данных или отката D.

Для следующего обычного запуска убрать только учебные process-env overrides
DB/Redis/RabbitMQ/S3/PORT/instance и проверить, какой env загружен, без печати значений.
Неизменённые рабочие `.env` не перезаписывать. Использовать приведённую выше команду
с семью services. Общие volumes/bucket не удаляются; backup, результаты, manifest
и runbook сохранены. Обычная рабочая схема, Prisma Client и код остаются D;
cleanup не запускает старые версии и не восстанавливает legacy-схему.

## Сводка изменений кода и порядок чтения

Ниже перечислены изменения всей Task 7; рабочий checkout содержит финальное D,
а промежуточное поведение A/B/C сохранено в самостоятельных локальных поставках.

1. **HTTP-контракт и модель.** Начать с
   `backend/src/documents/dto/update-document.dto.ts`: отсутствие content пропускается,
   пустой текст проходит, null/нестроковое значение даёт 400 до вызова сервиса.
   Этот guard и девять validation-тестов уже входят в starter commit `c3198ed`;
   это подготовка до реализации Task 7, title-валидация сохранена.
   Далее `backend/prisma/schema.prisma`: A добавил nullable body, B сделал legacy
   nullable, C не менял schema, D оставил обязательный body без content и сохранил GIN.
   Сначала читать SQL expand A и nullable B, затем четыре отдельных contract SQL D
   в `backend/prisma/migrations/`; исходные семь migrations не переписывались.
2. **Публичные ответы и записи.**
   `backend/src/documents/document-response.select.ts` и
   `document-response.mapper.ts` задают явную проекцию/прежний JSON content.
   A читал legacy и делал dual-write, B читал body ?? content и делал dual-write,
   C/D читают и пишут только body. Mapper учитывает допустимую пустую строку,
   сохраняет публичные поля и безопасно сообщает о нарушении целостности.
   `backend/src/documents/documents.service.ts` использует эту проекцию на всех
   Document-путях; `backend/src/projects/projects.service.ts` — на nested documents.
   Title-only PATCH не меняет текст, инвалидация кеша сохранена.
3. **Доступ и наблюдение.**
   `backend/src/access/access-policy.service.ts` выбирает только необходимые поля
   Document и workspaceId, исключая неявное чтение legacy до D.
   `backend/src/main.ts` и `backend/src/worker/worker.ts` пишут release_started с
   release/instance; mapper B учитывал fallback, C/D учитывают integrity_error.
   В событиях нет текста документов, credentials или JWT. Controller → Service →
   PrismaService, DI, RBAC и workspace isolation сохранены.
4. **Перенос до B.** `backend/scripts/backfill-document-body.ts` и alias в
   `backend/package.json`: строгие flags, missing/reconcile, dry-run, keyset ID,
   SQL из текущего d.content, отдельный commit каждой партии, budgets, progress
   после commit, restart с начала, глобальный remaining и exit 0/1/2.
   Guard требует именно client A до подключения к БД; текущая ROOT npm-команда
   с D client возвращает фазовую ошибку `BACKFILL_REQUIRES_RELEASE_A_CLIENT`
   до подключения к БД. Фактический запуск current D с `--dry-run` подтвердил exit 1
   и эту фазовую ошибку без обращения к БД.
   Alias/script сохранены в ROOT как исторический инструмент и исключены из C/D
   artifact. После начала C перенос content → body не запускается.
5. **Seed.** `backend/prisma/seed.ts`: A/B создавали одинаковые content/body одной
   операцией из одной переменной; C/D создают body-only с явным select id.
   Fixed seed IDs, skip непустой базы и прежняя user/password-логика сохранены.
   Seed не использовался как backfill существующих документов.
6. **Проверки Task 7.** Сначала читать
   `backend/test/update-document-validation.e2e-spec.ts`, затем
   `document-body-release-a.e2e-spec.ts`, три `backfill-document-body*.e2e-spec.ts`,
   `document-body-release-b.e2e-spec.ts` и `document-body-release-cd.e2e-spec.ts`.
   A/B suites исторические: opt-in и строго выделенные БД; legacy fixtures вынесены
   в typed parameterized SQL `backend/test/document-legacy-sql.ts`, чтобы они
   компилировались с финальным Client D. Это не делает старые suites проверкой
   текущего D или разрешением запускать их на финальной БД. C/D suite проверяет SQL
   без parameters, все ответы/записи, отсутствие legacy, negative/RBAC/file paths;
   тот же frozen C suite/client повторён после contract.
7. **Совместимость прежних suites.** Прямое Prisma поле content заменено на body
   в fixtures шести файлов: `backend/test/rbac.e2e-spec.ts`,
   `backend/test/search.e2e-spec.ts`, `backend/test/cache.e2e-spec.ts`,
   `backend/test/object-storage.e2e-spec.ts`, `backend/test/background-exports.e2e-spec.ts`
   и `backend/test/background-export-yandex.e2e-spec.ts`. Контракты metadata-only
   поиска, кеша и CSV сохранены.
   В `background-exports.e2e-spec.ts` heartbeat-проверка теперь ждёт фактического
   commit записи, поскольку spy видит вызов раньше commit; проверка throttle сохранена.
   Для outbox доказано опережение Docker PostgreSQL clock относительно host примерно
   на 164 мс (устойчивые границы 163–164 мс; полный диапазон с RTT 160–167 мс).
   Тестовые already-ready events получают `availableAt: new Date(0)`, а assertions
   ждут реальной публикации/lease invocation вместо предположения о готовности за 100 мс.
   Это правки детерминированности тестов; production heartbeat/outbox, системные часы
   и настройки Docker не менялись.
