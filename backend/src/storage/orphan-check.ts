import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
	DocumentFilesService,
	isObjectNamespacePrefix,
	isWorkspaceScopedObjectPrefix,
} from '../document-files/document-files.service';

async function run() {
	const args = new Set(process.argv.slice(2));
	const apply = args.has('--apply');
	const prefixArgument = [...args].find((argument) => argument.startsWith('--prefix='));
	const prefix =
		prefixArgument === undefined ? 'workspaces/' : prefixArgument.slice('--prefix='.length);
	if (!isObjectNamespacePrefix(prefix)) {
		process.stderr.write('Refusing orphan check: prefix must stay inside workspaces/\n');
		process.exitCode = 1;
		return;
	}
	if (apply && (!prefixArgument || !isWorkspaceScopedObjectPrefix(prefix))) {
		process.stderr.write(
			'Refusing orphan deletion: --apply requires --prefix=workspaces/<workspaceId>/...\n',
		);
		process.exitCode = 1;
		return;
	}
	const application = await NestFactory.createApplicationContext(AppModule, {
		logger: ['error', 'warn'],
	});
	try {
		const result = await application.get(DocumentFilesService).checkOrphans({ apply, prefix });
		process.stdout.write(
			`Orphan check mode=${apply ? 'apply' : 'dry-run'} scanned=${result.scanned} orphans=${result.orphans} removed=${result.removed}\n`,
		);
	} finally {
		await application.close();
	}
}

void run().catch((error: unknown) => {
	const name = error instanceof Error ? error.name : 'UnknownError';
	process.stderr.write(`Orphan check failed: ${name}\n`);
	process.exitCode = 1;
});
