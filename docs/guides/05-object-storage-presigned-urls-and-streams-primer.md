# Памятка к задаче 5: object storage, presigned URLs и streams

> [!tip] В двух словах
> **Большие данные отдельно.** База хранит связи и metadata, object storage — bytes, а stream не даёт большому файлу занять всю память процесса.

## Почему файл не кладут в PostgreSQL/API process

Большие binary rows раздувают backup/WAL и конкурируют с обычными запросами. Проксирование каждой загрузки через backend тратит его network/memory. Типичная схема:

```text
client -> API: request permission
API -> client: short presigned PUT URL
client -> S3: upload bytes
client -> API: complete
API -> S3: HEAD and verify
```

Presigned URL — временное полномочие выполнить одну операцию над одним object. Поэтому bucket остаётся private.

## Зачем статус PENDING/READY

Metadata может создаться, а upload — не завершиться. Без статуса API будет показывать несуществующий файл. `complete` подтверждает размер/тип через storage и только потом делает файл доступным.

Удаление тоже распределённая операция: PostgreSQL и S3 не имеют общей транзакции. Промежуточный `DELETING` делает ошибку видимой и повторяемой.

## Object key не равен имени файла

Пользовательское имя может содержать `../`, Unicode tricks или совпасть с другим именем. Backend генерирует непрозрачный key, а original name хранит отдельно для интерфейса.

MIME от клиента нельзя считать доказанным. Его сверяют с allowlist, extension и, при необходимости, сигнатурой файла/антивирусной обработкой.

## Как stream ограничивает память

Без stream код сначала строит миллион строк в массиве и один огромный `Buffer`. Со stream очередная порция проходит дальше, а backpressure останавливает producer, если network/storage не успевает.

```text
DB cursor/page -> CSV transform -> HTTP response
```

Важны корректное CSV escaping, обработка disconnect и отсутствие неограниченного промежуточного массива.

## CDN и приватные файлы

CDN полезен для публичных immutable assets. Приватный документ нельзя сделать публичным только ради CDN. Для него используют signed CDN URL/cookie или по-прежнему signed S3 download после authorization.

## Переиспользуемый S3-рецепт

```ts
async createUploadUrl(key: string, mimeType: string): Promise<string> {
	const command = new PutObjectCommand({
		Bucket: this.bucket,
		Key: key,
		ContentType: mimeType,
	});
	return getSignedUrl(this.s3, command, { expiresIn: 600 });
}

async verifyUpload(key: string, expectedSize: number) {
	const object = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
	if (object.ContentLength !== expectedSize) throw new UnprocessableEntityException();
}
```

Потоковый export можно построить через async generator:

```ts
async function* readRows(prisma: PrismaClient, teamId: string) {
	let cursor: string | undefined;
	while (true) {
		const rows = await prisma.note.findMany({
			where: { board: { teamId } },
			take: 500,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			orderBy: { id: 'asc' },
		});
		if (rows.length === 0) return;
		yield* rows;
		cursor = rows.at(-1)!.id;
	}
}
```

Controller пишет строку, ждёт `drain` при backpressure и прекращает generator при client disconnect.

## Частые ошибки

- хранить presigned URL в БД как постоянный;
- доверять object key из body;
- выдать URL до RBAC;
- считать metadata созданного upload готовым файлом;
- забыть orphan cleanup;
- назвать streaming endpoint потоковым, но заранее вызвать `findMany` без limit.
