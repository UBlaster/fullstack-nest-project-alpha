import {
	CanActivate,
	ExecutionContext,
	HttpException,
	Injectable,
	PayloadTooLargeException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class PaymentWebhookRateGuard implements CanActivate {
	private windowStart = 0;
	private requests = 0;
	private readonly clients = new Map<string, number>();

	canActivate(context: ExecutionContext): boolean {
		const req = context.switchToHttp().getRequest<Request>();
		if (Date.now() - this.windowStart >= 60_000) {
			this.windowStart = Date.now();
			this.requests = 0;
			this.clients.clear();
		}
		// req.socket is independent of an untrusted X-Forwarded-For header.
		const ip = req.socket.remoteAddress ?? 'unknown';
		const count = (this.clients.get(ip) ?? 0) + 1;
		if (++this.requests > 600 || count > 120) throw new HttpException('Webhook rate limit', 429);
		this.clients.set(ip, count);
		if (Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8') > 16_384)
			throw new PayloadTooLargeException();
		return true;
	}
}
