/* global AbortSignal, Buffer, URL, fetch */
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { check, CheckFailure, until, rememberObjectKey } from './task10-telemetry.mjs';

export const db = new PrismaClient();
export const traces = () => randomBytes(16).toString('hex');
export function headers(id) {
	return { traceparent: '00-' + id + '-' + randomBytes(8).toString('hex') + '-01' };
}
export async function api(path, status, { token, body, id = traces(), method } = {}) {
	const r = await fetch('http://127.0.0.1:3000' + path, {
		method: method ?? (body ? 'POST' : 'GET'),
		headers: {
			...headers(id),
			'content-type': 'application/json',
			...(token && { authorization: 'Bearer ' + token }),
		},
		body: body && JSON.stringify(body),
		signal: AbortSignal.timeout(35_000),
	});
	if (r.status !== status) {
		const verb = method ?? (body ? 'POST' : 'GET');
		throw Object.assign(
			new CheckFailure(`${verb} ${path.split('?')[0]} returned ${r.status}, expected ${status}`),
			{
				status: r.status,
			},
		);
	}
	return r.json();
}
export async function owner() {
	const email = randomUUID() + '@example.test';
	const password = randomUUID() + 'A1a!';
	await api('/auth/register', 201, {
		body: { email, password, passwordConfirmation: password, name: 'Pipeline tester' },
	});
	const { accessToken: token } = await api('/auth/login', 200, { body: { email, password } });
	const { id: workspace } = await api('/workspaces', 201, {
		token,
		body: { name: 'Pipeline acceptance' },
	});
	const { id: project } = await api('/workspaces/' + workspace + '/projects', 201, {
		token,
		body: { name: 'Fixtures' },
	});
	return { token, workspace, project };
}
export async function document(user, title) {
	const { id } = await api('/projects/' + user.project + '/documents', 201, {
		token: user.token,
		body: { title, content: '' },
	});
	return id;
}
export async function upload(user, doc, body, mimeType = 'text/plain') {
	const base = '/documents/' + doc + '/files';
	const fileName = mimeType === 'application/pdf' ? 'fixture.pdf' : 'fixture.txt';
	const { file, uploadUrl } = await api(base + '/upload-url', 201, {
		token: user.token,
		body: { mimeType, size: Buffer.byteLength(body), fileName },
	});
	check(
		new URL(uploadUrl).origin === 'https://storage.yandexcloud.net',
		'Unexpected object storage destination',
	);
	const uploaded = await fetch(uploadUrl, {
		method: 'PUT',
		headers: { 'content-type': mimeType },
		body,
		signal: AbortSignal.timeout(30000),
	});
	check(uploaded.ok, 'Yandex fixture PUT returned ' + uploaded.status);
	check(
		(await api(base + '/' + file.id + '/complete', 200, { token: user.token, method: 'POST' }))
			.status === 'READY',
		'File was not READY',
	);
	const fixture = await db.documentFile.findUniqueOrThrow({
		where: { id: file.id },
		select: { objectKey: true },
	});
	rememberObjectKey(fixture.objectKey);
	return file.id;
}
export async function version(user, doc, file, id = traces()) {
	const record = await api('/documents/' + doc + '/versions', 202, {
		token: user.token,
		body: { sourceFileId: file },
		id,
	});
	return { versionId: record.id, id };
}
export function state(user, v) {
	return api('/document-versions/' + v.versionId, 200, { token: user.token });
}
export async function indexed(user, v, timeout) {
	return until(
		async () => {
			const row = await state(user, v);
			check(
				row.status !== 'FAILED',
				'Version failed: ' + row.stages.find((s) => s.status === 'FAILED')?.errorCode,
			);
			return row.status === 'INDEXED' && row.isCurrent && row;
		},
		'activation ' + v.versionId,
		timeout,
	);
}
