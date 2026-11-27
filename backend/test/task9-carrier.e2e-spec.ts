import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { trace, isSpanContextValid } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getRequestId } from '../src/diagnostics/request-context';
import { addS3Propagation } from '../src/diagnostics/s3-operation';
import { messageHeaders, withMessageContext } from '../src/observability/carrier';
import { withSpan } from '../src/observability/telemetry';
import { S3ObjectStorageService } from '../src/storage/s3-object-storage.service';

const parent = {
	traceparent: '00-00000000000000000000000000000001-0000000000000002-01',
	tracestate: 'test=active',
	'x-request-id': 'task9-carrier-test',
	baggage: 'unrelated=value',
};

describe('Task 9 durable and outbound propagation (in memory)', () => {
	const exporter = new InMemorySpanExporter();
	const sdk = new NodeSDK({
		autoDetectResources: false,
		metricReaders: [],
		logRecordProcessors: [],
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	beforeAll(() => sdk.start());
	afterAll(() => sdk.shutdown());
	afterEach(() => jest.restoreAllMocks());

	it('restores only W3C and request ID after JSON persistence and producer/consumer boundaries', async () => {
		const durable = await withMessageContext(parent, () =>
			withSpan('create', async () => messageHeaders()),
		);
		const published = await withMessageContext(JSON.parse(JSON.stringify(durable)), () =>
			withSpan('publish', async () => messageHeaders()),
		);
		await withMessageContext(published, () =>
			withSpan('consume', async () => {
				expect(getRequestId()).toBe(parent['x-request-id']);
			}),
		);
		expect(Object.keys(published).sort()).toEqual(['traceparent', 'tracestate', 'x-request-id']);
		const [create, publish, consume] = exporter.getFinishedSpans();
		expect(publish.parentSpanContext?.spanId).toBe(create.spanContext().spanId);
		expect(consume.parentSpanContext?.spanId).toBe(publish.spanContext().spanId);
		expect(consume.spanContext().traceId).toBe(parent.traceparent.split('-')[1]);
	});

	it('starts a fresh request for legacy or malformed carriers, even inside an unrelated span', async () => {
		await withMessageContext(parent, () =>
			withSpan('outer', async (outer) => {
				for (const source of [
					null,
					{ 'x-request-id': 'invalid\nrequest', traceparent: 'invalid' },
				]) {
					await withMessageContext(source, () =>
						withSpan('fresh', async (span) => {
							expect(getRequestId()).toMatch(/^[0-9a-f-]{36}$/);
							expect(isSpanContextValid(span.spanContext())).toBe(true);
							expect(span.spanContext().traceId).not.toBe(outer.spanContext().traceId);
						}),
					);
				}
			}),
		);
	});

	it('signs W3C headers on a real SDK request and keeps browser presigning independent', async () => {
		jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		let networkCalls = 0;
		const client = addS3Propagation(
			new S3Client({
				region: 'test',
				endpoint: 'http://example.invalid',
				forcePathStyle: true,
				credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
				requestHandler: {
					handle: async (request: { headers: Record<string, string> }) => {
						networkCalls += 1;
						const active = trace.getActiveSpan()!.spanContext();
						// Assert booleans: a failed assertion must not print authentication headers.
						expect(request.headers.traceparent?.includes(active.spanId)).toBe(true);
						expect(request.headers.tracestate).toBe('test=active');
						expect(request.headers.authorization?.includes('traceparent;tracestate')).toBe(true);
						expect(Object.prototype.hasOwnProperty.call(request.headers, 'baggage')).toBe(false);
						return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
					},
				},
			}),
		);
		const storage = new S3ObjectStorageService(client, {
			bucket: 'test',
			uploadTtlSeconds: 60,
			downloadTtlSeconds: 60,
		});
		try {
			await withMessageContext(parent, async () => {
				await storage.head('object');
				const url = await storage.createDownloadUrl({
					objectKey: 'object',
					downloadName: 'object',
					expiresInSeconds: 60,
				});
				expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')?.includes('trace')).toBe(false);
				expect(networkCalls).toBe(1);
			});
		} finally {
			client.destroy();
		}
	});
});
