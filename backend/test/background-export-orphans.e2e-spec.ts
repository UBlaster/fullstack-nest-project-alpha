import { ConfigService } from '@nestjs/config';
import { AccessPolicyService } from '../src/access/access-policy.service';
import { DocumentFilesService } from '../src/document-files/document-files.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStorageService } from '../src/storage/storage.tokens';

describe('Task 6 export objects and Task 5 orphan cleanup', () => {
	it.each([false, true])(
		'preserves export objects during orphan cleanup (apply=%s)',
		async (apply) => {
			const knownFile = 'workspaces/workspace/documents/document/known-file';
			const orphanFile = 'workspaces/workspace/documents/document/orphan-file';
			const completedExport = 'workspaces/workspace/exports/export-id/attempt-token.csv';
			const legacyExport = 'workspaces/workspace/exports/export-id.csv';
			const prisma = {
				documentFile: { findMany: jest.fn().mockResolvedValue([{ objectKey: knownFile }]) },
			} as unknown as PrismaService;
			const remove = jest.fn().mockResolvedValue(undefined);
			const storage = {
				async *list() {
					yield knownFile;
					yield orphanFile;
					yield completedExport;
					yield legacyExport;
				},
				remove,
			} as unknown as ObjectStorageService;
			const files = new DocumentFilesService(
				prisma,
				new AccessPolicyService(prisma),
				storage,
				{ bucket: 'test-bucket', uploadTtlSeconds: 600, downloadTtlSeconds: 300 },
				new ConfigService(),
			);

			await expect(files.checkOrphans({ apply, prefix: 'workspaces/workspace/' })).resolves.toEqual(
				{
					scanned: 4,
					orphans: 1,
					removed: apply ? 1 : 0,
				},
			);
			if (apply) expect(remove.mock.calls).toEqual([[orphanFile]]);
			else expect(remove).not.toHaveBeenCalled();
		},
	);
});
