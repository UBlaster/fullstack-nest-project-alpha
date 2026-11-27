import { BadRequestException, Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import * as request from 'supertest';
import { configureObservability } from '../src/observability/http';
import { logEvent } from '../src/observability/logger';
import { serviceName } from '../src/observability/resource';

const mockLines: string[] = [];
jest.mock('pino', () => ({
	__esModule: true,
	default: (options: object) =>
		jest.requireActual('pino')(options, {
			write: (line: string) => mockLines.push(line),
		}),
}));

const marker = 'private-test-content';
@Controller('fixture')
class TestController {
	@Get('invalid/:id')
	invalid() {
		throw new BadRequestException({ code: 'EXPECTED', message: 'Invalid input' });
	}

	@Get('failure/:id')
	fail() {
		logEvent('info', 'test.event', {
			password: marker,
			url: marker,
			body: marker,
			arbitrary: marker,
		});
		throw new Error(marker);
	}
}

describe('HTTP telemetry boundary (isolated Nest application)', () => {
	const exporter = new tracing.InMemorySpanExporter();
	const logExporter = new InMemoryLogRecordExporter();
	const logProcessor = new BatchLogRecordProcessor(logExporter);
	const sdk = new NodeSDK({
		autoDetectResources: false,
		resource: resourceFromAttributes({ 'service.name': serviceName }),
		spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
		logRecordProcessors: [logProcessor],
		metricReaders: [],
	});
	let app: INestApplication;

	beforeAll(async () => {
		sdk.start();
		const module = await Test.createTestingModule({ controllers: [TestController] }).compile();
		app = module.createNestApplication();
		configureObservability(app);
		await app.init();
	});

	afterAll(async () => {
		await app.close();
		await sdk.shutdown();
	});

	it('keeps the public 4xx contract, bounded route and successful server span', async () => {
		const response = await request(app.getHttpServer())
			.get('/fixture/invalid/dynamic-42')
			.set('X-Request-ID', 'task9-expected')
			.expect(400);
		expect(response.body).toMatchObject({ code: 'EXPECTED', requestId: 'task9-expected' });
		const span = exporter
			.getFinishedSpans()
			.find((item) => item.attributes['request.id'] === 'task9-expected');
		expect(span?.name).toBe('GET /fixture/invalid/:id');
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
		expect(span?.events.length).toBe(0);
	});

	it('correlates W3C trace, logs the failure once and excludes request/exception payloads', async () => {
		mockLines.length = 0;
		const traceId = 'f'.repeat(32);
		const response = await request(app.getHttpServer())
			.get('/fixture/failure/' + marker + '?token=' + marker)
			.set('X-Request-ID', 'task9-unexpected')
			.set('Authorization', 'Bearer ' + marker)
			.set('Cookie', 'session=' + marker)
			.set('traceparent', '00-' + traceId + '-aaaaaaaaaaaaaaaa-01')
			.expect(500);
		expect(response.body.requestId).toBe(response.headers['x-request-id']);
		expect(response.body.requestId).toBe('task9-unexpected');
		const span = exporter.getFinishedSpans().find((item) => item.spanContext().traceId === traceId);
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.events.map((event) => event.name)).toEqual(['exception']);
		const errors = mockLines
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.level === 'error');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			traceId,
			requestId: 'task9-unexpected',
			statusCode: 500,
			route: '/fixture/failure/:id',
		});
		expect(errors[0].spanId).toBe(span?.spanContext().spanId);
		await logProcessor.forceFlush();
		const records = logExporter
			.getFinishedLogRecords()
			.filter((record) => record.spanContext?.traceId === traceId);
		expect(records.map((record) => record.body)).toEqual(mockLines.map((line) => line.trimEnd()));
		const errorRecord = records.find((record) => record.severityNumber === SeverityNumber.ERROR);
		expect(errorRecord?.severityText).toBe('ERROR');
		expect(errorRecord?.spanContext?.spanId).toBe(errors[0].spanId);
		expect(errorRecord?.resource.attributes['service.name']).toBe(serviceName);
		expect(errorRecord?.attributes).toEqual({});
		expect(
			JSON.stringify([
				mockLines,
				records.map(({ body, attributes }) => ({ body, attributes })),
				response.body,
				span?.attributes,
				span?.events,
				span?.status,
			]).includes(marker),
		).toBe(false);
	});

	it('exports the same worker-style stdout event without a span and respects the Pino level', async () => {
		await logProcessor.forceFlush();
		logExporter.reset();
		mockLines.length = 0;
		logEvent('debug', 'test.filtered');
		logEvent('warn', 'test.worker');
		await logProcessor.forceFlush();
		const records = logExporter.getFinishedLogRecords();
		expect(mockLines).toHaveLength(1);
		expect(records).toHaveLength(1);
		expect(records[0].body).toBe(mockLines[0].trimEnd());
		expect(records[0].severityNumber).toBe(SeverityNumber.WARN);
		expect(records[0].spanContext).toBeUndefined();
	});

	it('preserves stdout when a log processor fails', () => {
		const failure = jest.spyOn(logProcessor, 'onEmit').mockImplementationOnce(() => {
			throw new Error('processor unavailable');
		});
		try {
			mockLines.length = 0;
			logEvent('info', 'test.stdout');
			expect(failure).toHaveBeenCalledTimes(1);
			expect(mockLines).toHaveLength(1);
			expect(JSON.parse(mockLines[0]).operation).toBe('test.stdout');
		} finally {
			failure.mockRestore();
		}
	});

	it('returns safe router/parser responses while preserving middleware status codes', async () => {
		const server = app.getHttpServer();
		const responses = [
			await request(server)
				.get('/' + marker + '?token=' + marker)
				.expect(404),
			await request(server)
				.post('/fixture')
				.type('json')
				.send('{"' + marker + '":}')
				.expect(400),
			await request(server)
				.post('/fixture')
				.type('json')
				.send({ payload: marker.repeat(10000) })
				.expect(413),
			await request(server)
				.post('/fixture')
				.set('Content-Type', 'application/json; charset=unsupported')
				.send(marker)
				.expect(415),
		];
		expect(
			responses.every(
				({ body }) => !JSON.stringify(body).includes(marker) && Boolean(body.requestId),
			),
		).toBe(true);
	});

	it.each(['sk_test_', 'sk_live_', 'whsec_', 'cs_test_'])(
		'replaces credential-shaped request IDs (%s)',
		async (prefix) => {
			const response = await request(app.getHttpServer())
				.get('/fixture/invalid/example')
				.set('X-Request-ID', prefix + marker)
				.expect(400);
			expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
		},
	);
});
