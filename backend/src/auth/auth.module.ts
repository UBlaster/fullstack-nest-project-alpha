import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
	imports: [
		JwtModule.registerAsync({
			useFactory: (configService: ConfigService) => ({
				secret: configService.getOrThrow<string>('JWT_SECRET') || 'dev-secret',
				signOptions: {
					expiresIn: configService.getOrThrow<string>('JWT_EXPIRES_IN') || '1d',
				},
			}),
			inject: [ConfigService],
		}),
	],
	controllers: [AuthController],
	providers: [AuthService, JwtStrategy],
	exports: [AuthService],
})
export class AuthModule {}
