import { randomUUID } from 'node:crypto';
import http from 'node:http';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';

// Isolated browser-test API. Never imported by the app or ordinary Compose.
const workspaces = [
	{ id: 'ui-missing', name: 'UI smoke · интеграция не настроена' },
	{ id: 'ui-retry', name: 'UI smoke · потерянный ответ и 202' },
	{ id: 'ui-success', name: 'UI smoke · успешный результат' },
	{ id: 'ui-member', name: 'UI smoke · MEMBER' },
	{ id: 'ui-review', name: 'UI smoke · ручная сверка' },
];
const payments = new Map();
const attempts = new Map();
const createRequests = [];
let droppedResponse = false;
const browserUserId = `ui-smoke-${randomUUID()}`;

function payment(workspaceId, status, needsReview = false) {
	return {
		id: randomUUID(),
		workspaceId,
		purpose: 'WORKSPACE_DEMO',
		amountMinor: 10_000,
		currency: 'RUB',
		status,
		confirmationUrl: null,
		needsReview,
		lastErrorCode: needsReview ? 'TERMINAL_CONFLICT' : null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}
for (const row of [payment('ui-success', 'SUCCEEDED'), payment('ui-review', 'SUCCEEDED', true)]) {
	payments.set(row.id, row);
}

function respond(response, status, value) {
	response.writeHead(status, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
	response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:13173');
	response.setHeader(
		'Access-Control-Allow-Headers',
		'Content-Type, Authorization, Idempotency-Key',
	);
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	if (request.method === 'OPTIONS') {
		response.writeHead(204);
		return response.end();
	}
	const url = new URL(request.url, 'http://127.0.0.1:13008');
	if (url.pathname === '/__ui/report') {
		return respond(response, 200, {
			createRequests: createRequests.length,
			uniqueAttemptKeys: new Set(createRequests.map((row) => row.key)).size,
			logicalPayments: attempts.size,
			rows: [...payments.values()],
		});
	}
	if (url.pathname === '/__ui/settle' && request.method === 'POST') {
		for (const row of payments.values()) {
			if (row.workspaceId !== 'ui-retry') continue;
			row.status = 'SUCCEEDED';
			row.updatedAt = new Date().toISOString();
		}
		return respond(response, 200, { ok: true });
	}
	if (url.pathname === '/auth/me') return respond(response, 200, { id: browserUserId });
	if (url.pathname === '/projects') return respond(response, 200, []);
	if (url.pathname === '/workspaces') return respond(response, 200, workspaces);
	const workspaceRoute = url.pathname.match(
		/^\/workspaces\/([^/]+)(\/payments(?:\/capabilities)?)?$/,
	);
	if (workspaceRoute) {
		const workspace = workspaces.find((row) => row.id === workspaceRoute[1]);
		if (!workspace) return respond(response, 404, { message: 'Not found' });
		if (!workspaceRoute[2]) return respond(response, 200, workspace);
		if (workspace.id === 'ui-member') {
			return respond(response, 403, { message: 'Forbidden' });
		}
		if (workspaceRoute[2] === '/payments/capabilities') {
			return respond(response, 200, { enabled: workspace.id !== 'ui-missing' });
		}
		if (request.method === 'GET') {
			return respond(
				response,
				200,
				[...payments.values()].filter((row) => row.workspaceId === workspace.id),
			);
		}
		if (request.method === 'POST') {
			if (workspace.id === 'ui-missing') {
				return respond(response, 503, { message: 'Платёжная интеграция не настроена' });
			}
			const key = request.headers['idempotency-key'];
			if (typeof key !== 'string')
				return respond(response, 400, { message: 'Missing attempt key' });
			let body = '';
			for await (const chunk of request) {
				body += chunk;
				if (body.length > 1024) return respond(response, 413, { message: 'Too large' });
			}
			if (JSON.parse(body).purpose !== 'WORKSPACE_DEMO')
				return respond(response, 400, { message: 'Invalid purpose' });
			createRequests.push({ key, workspaceId: workspace.id });
			let row = attempts.get(key);
			if (!row) {
				row = payment(workspace.id, 'CREATED');
				attempts.set(key, row);
				payments.set(row.id, row);
			}
			if (!droppedResponse && workspace.id === 'ui-retry') {
				droppedResponse = true;
				return respond(response, 503, {
					message: 'Результат создания пока неизвестен. Повторите эту попытку.',
				});
			}
			return respond(response, 202, row);
		}
	}
	const paymentRoute = url.pathname.match(/^\/payments\/([^/]+)(\/reconcile)?$/);
	if (paymentRoute) {
		const row = payments.get(paymentRoute[1]);
		if (!row) return respond(response, 404, { message: 'Not found' });
		if (request.method === 'POST' && paymentRoute[2]) {
			row.needsReview = false;
			row.lastErrorCode = null;
			row.updatedAt = new Date().toISOString();
		}
		return respond(response, 200, row);
	}
	respond(response, 404, { message: 'Not found' });
});

server.listen(13008, '127.0.0.1', () => {
	console.log(`UI_SMOKE_API_READY pid=${process.pid} port=13008`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => server.close(() => process.exit(0)));
}
