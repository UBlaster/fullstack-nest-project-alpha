import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
	BadRequestException,
	ConflictException,
	Inject,
	Injectable,
	NotFoundException,
	UnsupportedMediaTypeException,
	UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentFile, DocumentFileStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { isAllowed } from '../access/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
	OBJECT_STORAGE,
	ObjectStorageService,
	STORAGE_CONFIG,
	StorageConfig,
} from '../storage/storage.tokens';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';

const extensionsByMime = new Map<string, ReadonlySet<string>>([
	['text/plain', new Set(['.txt'])],
	['text/markdown', new Set(['.md', '.markdown'])],
	['application/pdf', new Set(['.pdf'])],
	['text/csv', new Set(['.csv'])],
]);

function publicFile(file: DocumentFile) {
	return {
		id: file.id,
		documentId: file.documentId,
		originalName: file.originalName,
		mimeType: file.mimeType,
		size: file.size,
		etag: file.etag,
		status: file.status,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
	};
}

function normalizeFileName(value: string, mimeType: string): string {
	const name = value.normalize('NFKC').trim();
	const hasControlCharacter = [...name].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
	if (/[\\/]/.test(name) || hasControlCharacter) {
		throw new BadRequestException('fileName must be a leaf name');
	}
	if (!name || name === '.' || name === '..' || name.length > 200) {
		throw new BadRequestException('Invalid fileName');
	}
	const allowed = extensionsByMime.get(mimeType);
	if (!allowed || !allowed.has(extname(name).toLowerCase())) {
		throw new UnsupportedMediaTypeException('MIME type and extension do not match');
	}
	return name;
}

function storageNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}

export function isWorkspaceScopedObjectPrefix(prefix: string | undefined): boolean {
	return typeof prefix === 'string' && /^workspaces\/[^/]+\//.test(prefix);
}

export function isObjectNamespacePrefix(prefix: string | undefined): boolean {
	return prefix === 'workspaces/' || isWorkspaceScopedObjectPrefix(prefix);
}

@Injectable()
export class DocumentFilesService {
	private readonly maxBytes: number;

	constructor(
		private readonly prisma: PrismaService,
		private readonly accessPolicy: AccessPolicyService,
		@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageService,
		@Inject(STORAGE_CONFIG) private readonly storageConfig: StorageConfig,
		config: ConfigService,
	) {
		this.maxBytes = Number(config.get<string>('DOCUMENT_FILE_MAX_BYTES') ?? 26_214_400);
		if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 26_214_400) {
			throw new Error('DOCUMENT_FILE_MAX_BYTES must be an integer between 1 and 26214400');
		}
	}

	async list(userId: string, documentId: string) {
		await this.accessPolicy.requireDocument(userId, documentId, 'view');
		const files = await this.prisma.documentFile.findMany({
			where: { documentId },
			orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
		});
		return files.map(publicFile);
	}

	async capabilities(userId: string, documentId: string) {
		const context = await this.accessPolicy.requireDocument(userId, documentId, 'view');
		return {
			canUpdateDocument: isAllowed(context.workspaceRole, 'document', 'update'),
			canDeleteDocument: isAllowed(context.workspaceRole, 'document', 'delete'),
			canManageFiles: isAllowed(context.workspaceRole, 'document', 'update'),
		};
	}

	async createUploadUrl(userId: string, documentId: string, dto: CreateUploadUrlDto) {
		const context = await this.accessPolicy.requireDocument(userId, documentId, 'update');
		if (dto.size > this.maxBytes) {
			throw new BadRequestException(`File size must not exceed ${this.maxBytes} bytes`);
		}
		const originalName = normalizeFileName(dto.fileName, dto.mimeType);
		const objectKey = `workspaces/${context.project.workspaceId}/documents/${documentId}/${randomUUID()}`;
		const file = await this.prisma.documentFile.create({
			data: {
				documentId,
				objectKey,
				originalName,
				mimeType: dto.mimeType,
				size: dto.size,
			},
		});
		const uploadUrl = await this.storage.createUploadUrl({
			objectKey,
			mimeType: file.mimeType,
			expiresInSeconds: this.storageConfig.uploadTtlSeconds,
		});
		return {
			file: publicFile(file),
			uploadUrl,
			expiresInSeconds: this.storageConfig.uploadTtlSeconds,
		};
	}

	async complete(userId: string, documentId: string, fileId: string) {
		await this.accessPolicy.requireDocument(userId, documentId, 'update');
		const file = await this.requireFile(documentId, fileId);
		if (file.status === DocumentFileStatus.READY) return publicFile(file);
		if (file.status !== DocumentFileStatus.PENDING) {
			throw new ConflictException('File is not pending');
		}

		let head;
		try {
			head = await this.storage.head(file.objectKey);
		} catch (error) {
			if (storageNotFound(error)) {
				throw new UnprocessableEntityException('Uploaded object does not exist');
			}
			throw error;
		}
		const contentType = head.contentType?.split(';', 1)[0].trim().toLowerCase();
		if (head.size !== file.size || contentType !== file.mimeType.toLowerCase()) {
			throw new UnprocessableEntityException('Uploaded object metadata does not match');
		}
		await this.prisma.documentFile.updateMany({
			where: {
				id: file.id,
				documentId,
				objectKey: file.objectKey,
				status: DocumentFileStatus.PENDING,
			},
			data: {
				status: DocumentFileStatus.READY,
				etag: head.etag,
			},
		});
		const current = await this.requireFile(documentId, fileId);
		if (current.status === DocumentFileStatus.READY) {
			return publicFile(current);
		}
		throw new ConflictException('File is no longer pending');
	}

	async createDownloadUrl(userId: string, documentId: string, fileId: string) {
		await this.accessPolicy.requireDocument(userId, documentId, 'view');
		const file = await this.requireFile(documentId, fileId);
		if (file.status !== DocumentFileStatus.READY) {
			throw new ConflictException('File is not ready');
		}
		const downloadUrl = await this.storage.createDownloadUrl({
			objectKey: file.objectKey,
			downloadName: file.originalName,
			expiresInSeconds: this.storageConfig.downloadTtlSeconds,
		});
		return {
			downloadUrl,
			expiresInSeconds: this.storageConfig.downloadTtlSeconds,
		};
	}

	async remove(userId: string, documentId: string, fileId: string): Promise<void> {
		await this.accessPolicy.requireDocument(userId, documentId, 'update');
		let file = await this.prisma.documentFile.findFirst({
			where: { id: fileId, documentId },
		});
		if (!file) {
			const belongsToAnotherDocument = await this.prisma.documentFile.findUnique({
				where: { id: fileId },
				select: { id: true },
			});
			if (belongsToAnotherDocument) throw new NotFoundException();
			return;
		}
		while (file.status !== DocumentFileStatus.DELETING) {
			const transition = await this.prisma.documentFile.updateMany({
				where: {
					id: file.id,
					documentId,
					objectKey: file.objectKey,
					status: file.status,
				},
				data: { status: DocumentFileStatus.DELETING },
			});
			if (transition.count === 1) break;
			const current = await this.prisma.documentFile.findFirst({
				where: { id: fileId, documentId },
			});
			if (!current) return;
			file = current;
		}
		await this.storage.remove(file.objectKey);
		await this.prisma.documentFile.deleteMany({
			where: { id: file.id, documentId, objectKey: file.objectKey },
		});
	}

	async cleanupStalePending(cutoff: Date, fileIds?: string[]): Promise<{ removed: number }> {
		let removed = 0;
		while (true) {
			const files = await this.prisma.documentFile.findMany({
				where: {
					OR: [
						{
							status: DocumentFileStatus.PENDING,
							createdAt: { lt: cutoff },
						},
						{ status: DocumentFileStatus.DELETING },
					],
					...(fileIds ? { id: { in: fileIds } } : {}),
				},
				orderBy: { id: 'asc' },
				take: 100,
			});
			if (files.length === 0) return { removed };
			for (const file of files) {
				if (file.status === DocumentFileStatus.PENDING) {
					const transition = await this.prisma.documentFile.updateMany({
						where: {
							id: file.id,
							objectKey: file.objectKey,
							status: DocumentFileStatus.PENDING,
							createdAt: { lt: cutoff },
						},
						data: { status: DocumentFileStatus.DELETING },
					});
					if (transition.count === 0) continue;
				}
				await this.storage.remove(file.objectKey);
				const deleted = await this.prisma.documentFile.deleteMany({
					where: {
						id: file.id,
						objectKey: file.objectKey,
						status: DocumentFileStatus.DELETING,
					},
				});
				removed += deleted.count;
			}
		}
	}

	async checkOrphans(options: {
		apply: boolean;
		prefix?: string;
	}): Promise<{ scanned: number; orphans: number; removed: number }> {
		const prefix = options.prefix ?? 'workspaces/';
		if (!isObjectNamespacePrefix(prefix)) {
			throw new Error('Orphan check requires an object namespace prefix');
		}
		if (options.apply && !isWorkspaceScopedObjectPrefix(options.prefix)) {
			throw new Error('Orphan apply requires a workspace-scoped prefix');
		}
		let scanned = 0;
		let orphans = 0;
		let removed = 0;
		let keys: string[] = [];
		const inspectBatch = async () => {
			if (keys.length === 0) return;
			const known = await this.prisma.documentFile.findMany({
				where: { objectKey: { in: keys } },
				select: { objectKey: true },
			});
			const knownKeys = new Set(known.map((file) => file.objectKey));
			for (const key of keys) {
				if (knownKeys.has(key)) continue;
				orphans += 1;
				if (options.apply) {
					await this.storage.remove(key);
					removed += 1;
				}
			}
			keys = [];
		};
		for await (const key of this.storage.list(prefix)) {
			scanned += 1;
			keys.push(key);
			if (keys.length === 500) await inspectBatch();
		}
		await inspectBatch();
		return { scanned, orphans, removed };
	}

	private async requireFile(documentId: string, fileId: string): Promise<DocumentFile> {
		const file = await this.prisma.documentFile.findFirst({
			where: { id: fileId, documentId },
		});
		if (!file) throw new NotFoundException();
		return file;
	}
}
