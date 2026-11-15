import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

// Исторические A/B fixtures проверяют старые физические колонки независимо от текущего Client D.
type LegacySqlClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface LegacyDocumentFixture {
	id: string;
	projectId: string;
	authorId: string;
	title: string;
	content: string | null;
	body: string | null;
	createdAt: Date;
	updatedAt: Date;
}

interface LegacyDocumentInput {
	id?: string;
	projectId: string;
	authorId: string;
	title: string;
	content: string | null;
	body: string | null;
}

interface LegacyDocumentPatch {
	title?: string;
	content?: string | null;
	body?: string | null;
	updatedAt?: Date;
}

export async function createLegacyDocument(
	client: LegacySqlClient,
	data: LegacyDocumentInput,
): Promise<LegacyDocumentFixture> {
	const [row] = await client.$queryRaw<LegacyDocumentFixture[]>`
		INSERT INTO "Document" ("id", "projectId", "authorId", "title", "content", "body", "updatedAt")
		VALUES (${data.id ?? randomUUID()}, ${data.projectId}, ${data.authorId}, ${data.title},
			${data.content}, ${data.body}, CURRENT_TIMESTAMP)
		RETURNING "id", "projectId", "authorId", "title", "content", "body", "createdAt", "updatedAt"
	`;
	return row;
}

export async function readLegacyDocument(
	client: LegacySqlClient,
	id: string,
): Promise<LegacyDocumentFixture> {
	const [row] = await client.$queryRaw<LegacyDocumentFixture[]>`
		SELECT "id", "projectId", "authorId", "title", "content", "body", "createdAt", "updatedAt"
		FROM "Document" WHERE "id" = ${id}
	`;
	if (!row) throw new Error('Legacy fixture document was not found');
	return row;
}

export function readLegacyDocumentsByProject(
	client: LegacySqlClient,
	projectId: string,
): Promise<LegacyDocumentFixture[]> {
	return client.$queryRaw<LegacyDocumentFixture[]>`
		SELECT "id", "projectId", "authorId", "title", "content", "body", "createdAt", "updatedAt"
		FROM "Document" WHERE "projectId" = ${projectId} ORDER BY "id"
	`;
}

export async function updateLegacyDocument(
	client: LegacySqlClient,
	id: string,
	patch: LegacyDocumentPatch,
): Promise<LegacyDocumentFixture> {
	const changes: Prisma.Sql[] = [];
	if (patch.title !== undefined) changes.push(Prisma.sql`"title" = ${patch.title}`);
	if (patch.content !== undefined) changes.push(Prisma.sql`"content" = ${patch.content}`);
	if (patch.body !== undefined) changes.push(Prisma.sql`"body" = ${patch.body}`);
	if (changes.length === 0) throw new Error('A legacy fixture patch needs a changed field');
	changes.push(
		patch.updatedAt === undefined
			? Prisma.sql`"updatedAt" = CURRENT_TIMESTAMP`
			: Prisma.sql`"updatedAt" = ${patch.updatedAt}`,
	);
	const [row] = await client.$queryRaw<LegacyDocumentFixture[]>`
		UPDATE "Document" SET ${Prisma.join(changes)} WHERE "id" = ${id}
		RETURNING "id", "projectId", "authorId", "title", "content", "body", "createdAt", "updatedAt"
	`;
	if (!row) throw new Error('Legacy fixture document was not found');
	return row;
}
