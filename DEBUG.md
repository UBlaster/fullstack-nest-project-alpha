# Локальный дебаг NestJS и Task 5 / S3

API — `http://localhost:3000`, frontend — `http://localhost:5173`, Node Inspector —
`127.0.0.1:9229`. Порт 9229 не является HTTP API. Source maps уже включены в
`backend/tsconfig.json`; debugger ищет JavaScript в `backend/dist/**/*.js`.
Это покрывает как `dist/main.js`, так и `dist/src/main.js` в разных учебных ветках.

Общие настройки дебага не требуют реализации S3. S3 endpoints и адаптер появляются
после реализации Task 5; в `feature/task-5-start` они ещё не реализованы.
Коллекция ниже рассчитана на завершённую Task 5 или TT6, без фонового экспорта Task 6.

## Запуск debugger

**Существующий Docker Compose, редактор на хосте:** при уже работающих зависимостях
из корня проекта выполните:

```powershell
docker compose -f docker-compose.yml -f docker-compose.debug.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d --no-deps backend
```

В Run and Debug выберите `NestJS: attach Docker from host (9229)` и нажмите F5.
Override меняет только запуск backend, добавляет `127.0.0.1:9229:9229` и монтирует
`backend/dist` для source maps. Внутри контейнера Inspector слушает `0.0.0.0:9229`,
иначе Docker port mapping не сможет подключиться к нему. HTTP остаётся на 3000.
Не запускайте второй backend одновременно на тех же портах.

В Dev Container используйте `NestJS: attach Docker from Dev Container (9229)`:
он подключается напрямую к сервису `backend:9229`, а не к localhost контейнера workspace.

**Backend как локальный Node-процесс:** сначала настройте переменные процесса для
своей локальной среды и доступных PostgreSQL/Redis/S3, затем из `backend`:

```powershell
npm run start:debug
```

Выберите `NestJS: attach local (9229)`. Скрипт запускает
`nest start --debug 127.0.0.1:9229 --watch`. Корневой `.env` Compose сам по себе
не настраивает локальный Node-процесс; контейнерные DNS-имена `postgres`/`redis`
на хосте не заменяются на localhost автоматически. AWS-настройки менять не требуется.

При `--watch` debugger переподключается после перезапуска. Если breakpoint серый,
проверьте выбранный профиль, сообщение `Debugger listening`, сборку и mapping
`${workspaceFolder}/backend` → `/app`. F10 — выполнить строку, F11 — войти в вызов,
F5 — продолжить до следующей точки. Остановка может привести к истечению presigned URL:
после долгого разбора запросите новую ссылку.

Вернуть обычный Docker-запуск, сохранив сервисы и данные:

```powershell
docker compose up -d --no-deps backend
```

## Куда ставить breakpoints

- Frontend: `frontend/src/pages/document/ui/DocumentPage.tsx`, перед
  `uploadToPresignedUrl`, затем перед `POST .../complete` и перед `loadFiles()`.
  В DevTools → Network сопоставьте запросы и ответы. Пауза frontend не останавливает backend.
- Backend Task 5: `DocumentFilesController.createUploadUrl`,
  `DocumentFilesService.createUploadUrl` до/после `prisma.documentFile.create`,
  `complete` до/после `storage.head`, `createDownloadUrl` и `remove`.
- S3 adapter: `backend/src/storage/s3-object-storage.service.ts`, методы
  `createUploadUrl`, `head`, `createDownloadUrl`, `remove` и `list`.
  В ветках до Task 5 начинайте с имеющегося controller/service и `main.ts`.

HTTP передаёт `X-Request-ID`: допустимый UUID из запроса сохраняется, иначе сервер
генерирует новый. Этот ID доступен в ответе и в асинхронном контексте backend.
В браузере смотрите заголовок в Network; JavaScript-доступ к cross-origin заголовку
отдельно не настраивался. Сохраняйте только ID и безопасные поля диагностики,
не копируйте JWT, credentials и полные подписанные URL в логи/отчёты.

## Postman: воспроизвести загрузку по шагам

Используйте отдельную тестовую БД, тестовый документ и собственный тестовый объект.
Импортируйте `postman/task-5-s3-debug.postman_collection.json` и
`postman/local.postman_environment.json`. В окружении локально заполните `documentId`
и `accessToken` тестового OWNER/MEMBER. AWS credentials в Postman не нужны.
Working directory Postman укажите на папку `postman` либо выберите fixture вручную.

1. `00 Health`: API отвечает 200 на порту 3000.
2. `01 Reserve upload URL`: отправляет только имя, MIME и размер, ожидает 201/PENDING.
   Для незавершённой загрузки остановитесь здесь. Сравните `file.id` из ответа с
   `DocumentFile` в DBeaver и проверьте точный `objectKey` в S3.
3. `02 PUT binary`: выберите `postman/fixtures/debug-upload.txt` (ровно 3 байта `abc`,
   без BOM/переноса строки). Body должен быть **binary**, не form-data. Content-Type
   совпадает с `mimeType`; для S3 явно выбран **No Auth**, отключены cookies/redirects.
4. `03 Complete`: существующий API делает HEAD и проверяет наличие, размер и MIME;
   ожидаются 200/READY. `04 List` проверяет появление готового вложения.
5. `05 Get download URL`, затем `06 GET bytes`: скачивание тоже с **No Auth**;
   проверяются 200 и совпадение bytes с fixture. `07 Cleanup` удаляет только этот fileId.

Перед новым reserve коллекция сбрасывает старый fileId и подписанные ссылки.
При неожиданном статусе Runner останавливается: устраните причину или выполните
`07 Cleanup` вручную для уже созданной записи. После выполнения очистите runtime
variables и accessToken перед экспортом/публикацией коллекции или окружения.

**Выдача ссылки не подтверждает загрузку.** Presign лишь подписывает разрешённую
операцию. Статус готовности устанавливается отдельным `complete` после HEAD.
**Postman Desktop не проверяет браузерный CORS**: успешный PUT в Postman ещё не
доказывает, что загрузка работает со страницы frontend.

## Как читать S3-диагностику

В реализованном адаптере операции обёрнуты в `observeS3` из `backend/src/diagnostics/`.
JSON-событие `s3.operation` содержит `requestId`, `operation`, `kind`, `outcome`,
`durationMs`, `httpStatusCode`, `errorCode`, `awsRequestId`, `attempts`.
Для страниц list и частей multipart сохраняется общий ID соответствующего вызова.
В CLI без HTTP-контекста генерируется UUID. Неизвестные SDK metadata остаются `null`.

`kind=presign` — локальное подписание: HTTP/AWS request ID равны `null`, attempts=0.
Прямые PUT/GET выполняет клиент, поэтому их HTTP-статус и `x-amz-request-id` смотрите
в Postman/Network, а не в backend presign-логе. Ошибка SDK пробрасывается тем же
объектом; логируются только разрешённые metadata, без message/stack/input/output.
Логирование не добавляет retries и не включает сырой AWS logger.

## Если S3 вернул ошибку

- **403 AccessDenied:** проверьте право нужной операции у service account и bucket policy.
  Частный bucket не нужно делать публичным. Сравните, отказал API по RBAC или сам S3.
- **SignatureDoesNotMatch:** сохраните URL целиком без изменений host/path/query;
  используйте подписанный метод PUT/GET, нужный Content-Type и No Auth. Не добавляйте
  API Bearer token или AWS auth поверх query-подписи; не переключайте addressing style
  после выдачи ссылки. Сверьте часы компьютера и срок ссылки.
- **Срок ссылки:** получите новую через API; старый URL после паузы debugger мог истечь.
  Ориентируйтесь на `expiresInSeconds` и параметры подписи, не сохраняйте URL как постоянный.
- **Неверный key / missing object:** сравните точный `DocumentFile.objectKey`, documentId
  и текущий bucket/endpoint. Имя `originalName` не является S3 key. HEAD может скрывать
  отсутствие объекта за 403 при недостаточных правах; не делайте вывод только по коду.
- **Complete 422:** отдельно проверьте успешность PUT, количество bytes и MIME через HEAD.
  `text/plain` для трёх bytes не совпадёт с другим размером или другим типом.
- **CORS только в браузере:** проверьте OPTIONS в Network, точный origin
  `http://localhost:5173`, разрешённые PUT/GET/HEAD, Content-Type и exposed ETag.
  CORS не выдаёт права IAM и не заменяет подпись. Эта настройка дебага CORS/AWS не меняет.

## Проверки без записи в БД

Из `backend`: `npm run format:check`, `npm run lint`, `npm run build`,
`npm run test:e2e -- --runInBand diagnostics.e2e-spec.ts`.
Эти diagnostic tests не обращаются к PostgreSQL или S3. В TT6 отдельно доступен
`background-export-storage.e2e-spec.ts` с реальным AWS Upload и подменённым transport.
Полный E2E и Postman запускайте только на выделенных тестовых ресурсах.

Справки: [VS Code Node debugger](https://code.visualstudio.com/docs/nodejs/nodejs-debugging),
[Nest CLI](https://docs.nestjs.com/cli/usages),
[Postman No Auth](https://learning.postman.com/docs/use/send-requests/authorization/authorization-types/).
