import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { AuthController } from './controllers/auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { RegistrationService } from './registration.service';

@Module({
	imports: [
		JwtModule.registerAsync({
			useFactory: (configService: ConfigService) => ({
				secret: configService.getOrThrow<string>('JWT_SECRET') || 'dev-secret',
				signOptions: {
					expiresIn: configService.getOrThrow<string>('JWT_EXPIRES_IN') || '1d',
				},
				verifyOptions: {
					algorithms: ['HS256'],
					ignoreExpiration: false,
				},
			}),
			inject: [ConfigService],
		}),
	],
	controllers: [AuthController],
	providers: [AuthService, RegistrationService, AccountService, JwtStrategy],
	exports: [AuthService],
})
export class AuthModule {}
