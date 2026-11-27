import { spawnSync } from 'node:child_process';
import process from 'node:process';

const database = 'task9_observability_test';
const project = [
	'compose',
	'-p',
	'nest-fullstack-project',
	'-f',
	'docker-compose.yml',
	'-f',
	'observability/compose.test.yml',
];

function compose(args, input) {
	const result = spawnSync('docker', [...project, ...args], {
		input,
		stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

compose(['up', '-d', '--wait', 'postgres']);
compose(
	[
		'exec',
		'-T',
		'postgres',
		'sh',
		'-ec',
		'exec psql -X -q -v ON_ERROR_STOP=1 -v test_db="$1" -U "$POSTGRES_USER" -d postgres',
		'stand-up',
		database,
	],
	[
		'SELECT pg_advisory_lock(413592, 11);',
		"SELECT format('CREATE DATABASE %I', :'test_db')",
		"WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'test_db')",
		'\\gexec',
		'',
	].join('\n'),
);
compose([
	'up',
	'-d',
	'--build',
	'--wait',
	'--wait-timeout',
	'240',
	'backend',
	'worker',
	'frontend',
	'redis',
	'otel-collector',
	'jaeger',
	'prometheus',
	'grafana',
]);
