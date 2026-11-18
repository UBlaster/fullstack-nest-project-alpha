import {
	CanActivate,
	ExecutionContext,
	HttpException,
	HttpStatus,
	Injectable,
	PayloadTooLargeException,
	RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 600;
const MAX_REQUESTS_PER_IP = 120;
const MAX_BODY_BYTES = 65_536;

@Injectable()
export class PaymentWebhookRateGuard implements CanActivate {
	private windowStart = 0;
	private requests = 0;
	private readonly clients = new Map<string, number>();

	canActivate(context: ExecutionContext): boolean {
		const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
		const now = Date.now();
		if (now - this.windowStart >= WINDOW_MS) {
			this.windowStart = now;
			this.requests = 0;
			this.clients.clear();
		}
		const ip = req.socket.remoteAddress ?? 'unknown';
		const clientRequests = (this.clients.get(ip) ?? 0) + 1;
		this.requests += 1;
		if (this.requests > MAX_REQUESTS_PER_WINDOW || clientRequests > MAX_REQUESTS_PER_IP) {
			throw new HttpException('Webhook rate limit', HttpStatus.TOO_MANY_REQUESTS);
		}
		this.clients.set(ip, clientRequests);
		if ((req.rawBody?.byteLength ?? 0) > MAX_BODY_BYTES) throw new PayloadTooLargeException();
		return true;
	}
}
