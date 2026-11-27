import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from './authenticated-request';
import { setAuthenticatedContext } from '../diagnostics/request-context';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(configService: ConfigService) {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
			algorithms: ['HS256'],
			ignoreExpiration: false,
		});
	}

	validate(payload: AuthenticatedUser): AuthenticatedUser {
		setAuthenticatedContext({ userId: payload.sub });
		return payload;
	}
}
