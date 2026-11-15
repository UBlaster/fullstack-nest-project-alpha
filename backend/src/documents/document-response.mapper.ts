import { InternalServerErrorException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { documentResponseSelect } from './document-response.select';

export type DocumentResponseRow = Prisma.DocumentGetPayload<{
	select: typeof documentResponseSelect;
}>;

const logger = new Logger('DocumentResponse');
let integrityErrorCount = 0;

export function toDocumentResponse(row: DocumentResponseRow) {
	const content = row.body;
	if (content === null) {
		logger.error(
			JSON.stringify({
				event: 'document.text.integrity_error',
				release: 'D',
				instance: process.env.TASK7_INSTANCE_ID ?? String(process.pid),
				count: ++integrityErrorCount,
			}),
		);
		throw new InternalServerErrorException('Document text is unavailable');
	}
	return {
		id: row.id,
		projectId: row.projectId,
		authorId: row.authorId,
		title: row.title,
		content,
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
