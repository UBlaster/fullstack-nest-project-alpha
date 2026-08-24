import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(configService: ConfigService) {
		super({
			jwtFromRequest: (request: any) =>
				request?.headers?.authorization?.replace('Bearer ', '') || null,
			secretOrKey: configService.getOrThrow<string>('JWT_SECRET') || 'dev-secret',
		});
	}

	validate(payload: any) {
		return payload;
	}
}
