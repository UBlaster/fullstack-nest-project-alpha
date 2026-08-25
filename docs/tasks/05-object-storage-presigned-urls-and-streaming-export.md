# Задача 5. Object Storage, presigned URLs и потоковый CSV export

> [!summary] Результат
> Файлы документов хранятся в MinIO/S3, загружаются по короткоживущим presigned URLs с RBAC-проверкой, а большой CSV export передаётся потоком без накопления всего набора в памяти.

## Предусловие и стек

Задача №2 завершена. Для разработки использовать MinIO в Docker Compose, AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) и интерфейс `ObjectStorageService` с реализацией `S3ObjectStorageService`.

## Модель данных

Добавить `DocumentFile`: `id`, `documentId`, `objectKey` unique, `originalName`, `mimeType`, `size`, `etag?`, `status` (`PENDING`, `READY`, `DELETING`, `FAILED`), timestamps. Один document может иметь несколько файлов. Бинарные данные и presigned URL в PostgreSQL не хранить.

Изменение выполнить expand migration: новая таблица не меняет существующий `Document.content` и не ломает старые записи.

## API файлов

- `POST /documents/:documentId/files/upload-url` с DTO `fileName`, `mimeType`, `size` создаёт metadata `PENDING` и URL для `PUT` на 10 минут.
- `POST /documents/:documentId/files/:fileId/complete` проверяет object через `HeadObject`, сверяет размер/type и переводит metadata в `READY`.
- `GET /documents/:documentId/files/:fileId/download-url` выдаёт URL на 5 минут только для `READY`.
- `DELETE /documents/:documentId/files/:fileId` идемпотентно удаляет object и metadata; повторный запрос возвращает `204`.

Каждый endpoint проходит relation path document -> project -> workspace и permission задачи №2. Upload/complete/delete считаются update document, download — view document.

## Ограничения безопасности

- максимум 25 MiB;
- разрешены `text/plain`, `text/markdown`, `application/pdf`, `text/csv`;
- extension должна соответствовать MIME allowlist;
- object key генерирует backend: `workspaces/{workspaceId}/documents/{documentId}/{uuid}`;
- исходное имя очищается и используется только как metadata/download filename;
- bucket private, public listing запрещён;
- access key, secret, URL с подписью и содержимое файлов не логировать.

`CDN_PUBLIC_BASE_URL` добавить как optional configuration для будущей раздачи только публичных assets. Приватные document files продолжают скачиваться через presigned URL; нельзя превращать их в публичные CDN URL.

## Потоковый export

Добавить `GET /workspaces/:workspaceId/documents/export.csv`. После view permission endpoint отдаёт UTF-8 CSV с header `id,projectId,title,status,authorName,updatedAt`.

- читать БД страницами по 500 строк через keyset `id`;
- формировать CSV через Node.js `Readable`/`Transform` и учитывать backpressure;
- корректно экранировать запятые, кавычки и переносы;
- content не экспортировать;
- при disconnect клиента прекратить чтение следующих страниц;
- не собирать весь CSV или все rows в массив.

## Надёжность удаления

Сначала установить `DELETING`, затем удалить object, затем metadata. Ошибку оставить повторяемой; отсутствующий object считать уже удалённым. Добавить команду очистки `PENDING` старше 24 часов и orphan-check в dry-run режиме.

## Тесты

- RBAC для upload/download/delete и outsider `404`;
- invalid MIME, extension, size и чужой file/document relation;
- URL имеет ограниченный expiry и не содержит secrets в API logs;
- complete отклоняет отсутствующий object или неверный size;
- повторный delete безопасен, ошибка storage повторяется;
- CSV корректно экранируется, не содержит content/чужие workspace;
- export 50 000 строк сохраняет ограниченное потребление памяти;
- disconnect останавливает pagination;
- недоступный MinIO возвращает контролируемый `503`, не повреждая metadata.

## Документация и критерии приёмки

Создать `docs/infrastructure/05-object-storage-and-export.md` с env, локальной проверкой, lifecycle и orphan cleanup. Migration, MinIO healthcheck, тесты и Docker-запуск обязательны. Полный dataset CSV и file bodies не загружаются в память backend.

