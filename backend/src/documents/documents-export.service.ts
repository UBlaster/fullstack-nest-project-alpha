import { Injectable, Logger } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { Request, Response } from 'express';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';

export const exportBatchSize = 500;

export interface ExportDocumentRow {
	id: string;
	projectId: string;
	title: string;
	status: DocumentStatus;
	updatedAt: Date;
	author: { name: string };
}

export function csvLine(values: Array<string | number | Date>): string {
	const fields = values.map((value) => {
		const text = value instanceof Date ? value.toISOString() : String(value);
		const escaped = text.replace(/"/g, '""');
		return /[",\r\n]/.test(text) ? `"${escaped}"` : escaped;
	});
	return `${fields.join(',')}\r\n`;
}

export async function writeCsvChunk(
	response: Response,
	chunk: string,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted || response.destroyed) return;
	if (response.write(chunk)) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			response.off('drain', finish);
			response.off('close', finish);
			response.off('error', fail);
			signal.removeEventListener('abort', finish);
		};
		const finish = () => {
			cleanup();
			resolve();
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		response.once('drain', finish);
		response.once('close', finish);
		response.once('error', fail);
		signal.addEventListener('abort', finish, { once: true });
		if (signal.aborted) finish();
	});
}

@Injectable()
export class DocumentsExportService {
	private readonly logger = new Logger(DocumentsExportService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly accessPolicy: AccessPolicyService,
	) {}

	async export(
		userId: string,
		workspaceId: string,
		request: Request,
		response: Response,
	): Promise<void> {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'view', 'document');

		const abortController = new AbortController();
		const abort = () => abortController.abort();
		const requestClosed = () => {
			if (request.aborted || !request.complete) abort();
		};
		request.once('aborted', abort);
		request.once('close', requestClosed);
		response.once('close', abort);

		response.status(200);
		response.setHeader('content-type', 'text/csv; charset=utf-8');
		response.setHeader('content-disposition', 'attachment; filename="documents.csv"');

		try {
			await writeCsvChunk(
				response,
				'\uFEFFid,projectId,title,status,authorName,updatedAt\r\n',
				abortController.signal,
			);
			for await (const row of this.iterateForExport(workspaceId, abortController.signal)) {
				if (abortController.signal.aborted) break;
				await writeCsvChunk(
					response,
					csvLine([row.id, row.projectId, row.title, row.status, row.author.name, row.updatedAt]),
					abortController.signal,
				);
			}
			if (!abortController.signal.aborted && !response.destroyed && !response.writableEnded) {
				response.end();
			}
		} catch (error) {
			if (!response.headersSent) throw error;
			const streamError =
				error instanceof Error ? error : new Error('Unknown CSV export stream error');
			this.logger.error('CSV export failed after the response started', streamError.stack);
			if (!response.destroyed) response.destroy(streamError);
		} finally {
			request.off('aborted', abort);
			request.off('close', requestClosed);
			response.off('close', abort);
		}
	}

	async *iterateForExport(
		workspaceId: string,
		signal: AbortSignal,
	): AsyncIterable<ExportDocumentRow> {
		let cursor: string | undefined;
		while (!signal.aborted) {
			const rows = await this.prisma.document.findMany({
				where: {
					project: { workspaceId },
					...(cursor ? { id: { gt: cursor } } : {}),
				},
				select: {
					id: true,
					projectId: true,
					title: true,
					status: true,
					updatedAt: true,
					author: { select: { name: true } },
				},
				orderBy: { id: 'asc' },
				take: exportBatchSize,
			});
			if (signal.aborted || rows.length === 0) return;
			for (const row of rows) {
				if (signal.aborted) return;
				yield row;
			}
			cursor = rows[rows.length - 1].id;
			if (rows.length < exportBatchSize) return;
		}
	}
}
