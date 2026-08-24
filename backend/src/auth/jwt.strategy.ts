import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor() {
		super({
			jwtFromRequest: (request: any) =>
				request?.headers?.authorization?.replace('Bearer ', '') || null,
			secretOrKey: process.env.JWT_SECRET || 'dev-secret',
		});
	}

	validate(payload: any) {
		return payload;
	}
}
