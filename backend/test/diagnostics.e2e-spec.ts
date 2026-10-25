import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { getRequestId, requestContextMiddleware } from '../src/diagnostics/request-context';
import { observeS3 } from '../src/diagnostics/s3-operation';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

function inRequest<T>(requestId: string | string[], work: () => T): T {
	let result: T;
	requestContextMiddleware(
		{ headers: { 'x-request-id': requestId } } as unknown as Request,
		{ setHeader: jest.fn() } as unknown as Response,
		(() => {
			result = work();
		}) as NextFunction,
	);
	return result!;
}

describe('Request correlation and safe S3 diagnostics (no database/network)', () => {
	afterEach(() => jest.restoreAllMocks());

	it('echoes a validated request id and preserves it across asynchronous work', async () => {
		const setHeader = jest.fn();
		let seen: string | undefined;
		let pending: Promise<void> | undefined;
		requestContextMiddleware(
			{ headers: { 'x-request-id': firstId } } as unknown as Request,
			{ setHeader } as unknown as Response,
			(() => {
				pending = Promise.resolve().then(() => {
					seen = getRequestId();
				});
			}) as NextFunction,
		);
		await pending;
		expect(seen).toBe(firstId);
		expect(setHeader).toHaveBeenCalledWith('X-Request-ID', firstId);
		expect(getRequestId()).toBeUndefined();
	});

	it.each(['Bearer private-token', 'https://example.invalid/?X-Amz-Signature=private', [firstId]])(
		'does not copy untrusted header content into request correlation: case %#',
		(incoming) => {
			const seen = inRequest(incoming, getRequestId);
			expect(seen).toMatch(/^[0-9a-f-]{36}$/);
			expect(seen).not.toEqual(incoming);
		},
	);

	it('isolates simultaneous requests and logs SDK metadata without serializing output', async () => {
		const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		const output = {
			$metadata: { httpStatusCode: 200, requestId: 'aws-request', attempts: 2 },
			Body: 'private-file-content',
			url: 'https://example.invalid/?X-Amz-Signature=private',
		};
		const results = await Promise.all(
			[firstId, secondId].map((requestId) =>
				inRequest(requestId, () => observeS3('HeadObject', async () => output)),
			),
		);
		expect(results).toEqual([output, output]);
		const entries = logged.mock.calls.map(([value]) => JSON.parse(value));
		expect(entries.map((entry) => entry.requestId)).toEqual([firstId, secondId]);
		expect(entries[0]).toMatchObject({
			operation: 'HeadObject',
			kind: 'request',
			outcome: 'success',
			httpStatusCode: 200,
			awsRequestId: 'aws-request',
			attempts: 2,
			errorCode: null,
		});
		expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(entries)).not.toMatch(/private|Signature|Body/);
	});

	it('rethrows the identical SDK error and logs only allowlisted error metadata', async () => {
		const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		const error = Object.assign(new Error('private credentials and signed URL'), {
			name: 'AccessDenied',
			$metadata: { httpStatusCode: 403, requestId: 'aws-denied', attempts: 3 },
			credentials: { secretAccessKey: 'private' },
			Authorization: 'private',
		});
		await expect(
			inRequest(firstId, () =>
				observeS3('HeadObject', async () => {
					throw error;
				}),
			),
		).rejects.toBe(error);
		const entry = JSON.parse(logged.mock.calls[0][0]);
		expect(entry).toMatchObject({
			requestId: firstId,
			errorCode: 'AccessDenied',
			httpStatusCode: 403,
			awsRequestId: 'aws-denied',
			attempts: 3,
		});
		expect(JSON.stringify(entry)).not.toMatch(/private|credentials|Authorization|stack|message/);
	});

	it('does not pretend presigning performed an HTTP request', async () => {
		const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		await observeS3('PresignPutObject', async () => 'private-signed-url', { presign: true });
		expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
			kind: 'presign',
			httpStatusCode: null,
			awsRequestId: null,
			attempts: 0,
		});
	});

	it('does not replace a successful result when the logging sink fails', async () => {
		jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
			throw new Error('sink unavailable');
		});
		await expect(observeS3('HeadObject', async () => 'unchanged')).resolves.toBe('unchanged');
	});
});
