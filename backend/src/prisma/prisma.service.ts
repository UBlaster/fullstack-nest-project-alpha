import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Prisma, PrismaClient } from '@prisma/client';
import { meter } from '../observability/telemetry';

const queryDuration = meter.createHistogram('workspace.db.duration', { unit: 'ms' });
const queryErrors = meter.createCounter('workspace.db.errors');

@Injectable()
export class PrismaService
	extends PrismaClient<Prisma.PrismaClientOptions, 'query' | 'error'>
	implements OnModuleInit, OnModuleDestroy
{
	constructor(
		@Optional() @Inject('PRISMA_CLIENT_OPTIONS') options: Prisma.PrismaClientOptions = {},
	) {
		super({
			...options,
			log: [
				{ emit: 'event', level: 'query' },
				{ emit: 'event', level: 'error' },
			],
		});
		this.$on('query', ({ duration }) => {
			queryDuration.record(duration, { db_operation: 'query' });
		});
		this.$on('error', () => {
			queryErrors.add(1, { db_operation: 'query' });
			// Prisma emits client errors inside the operation span before ending it.
			// Engine events outside an operation must not mark an unrelated parent.
			const span = trace.getActiveSpan();
			if (span && 'name' in span && span.name === 'prisma:client:operation') {
				span.recordException({ name: 'PrismaQueryError', message: 'Database operation failed' });
				span.setAttribute('error.type', 'PrismaQueryError');
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
		});
	}

	async onModuleInit() {
		await this.$connect();
	}

	async onModuleDestroy() {
		await this.$disconnect();
	}
}
