import {
	Body,
	Controller,
	Get,
	HttpCode,
	Injectable,
	Module,
	Post,
	Req,
	UnauthorizedException,
	UseGuards,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { PrismaService } from './prisma.service';

class LoginDto {
	@IsEmail()
	@IsNotEmpty()
	email!: string;

	@IsString()
	@IsNotEmpty()
	password!: string;
}

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

@Injectable()
export class AuthService {
	constructor(
		private prisma: PrismaService,
		private jwt: JwtService,
	) {}

	async login(dto: LoginDto) {
		const user = await this.prisma.user.findUnique({
			where: {
				email: dto.email,
			},
		});
		if (!user || user.password !== dto.password) {
			throw new UnauthorizedException('Invalid credentials');
		}

		return {
			accessToken: this.jwt.sign({
				sub: user.id,
				email: user.email,
			}),
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
			},
		};
	}

	async me(id: string) {
		return this.prisma.user.findUnique({
			where: {
				id,
			},
			select: {
				id: true,
				email: true,
				name: true,
				createdAt: true,
			},
		});
	}
}

@Controller('auth')
export class AuthController {
	constructor(private authService: AuthService) {}

	@Post('login')
	@HttpCode(200)
	login(@Body() dto: LoginDto) {
		return this.authService.login(dto);
	}

	@UseGuards(AuthGuard('jwt'))
	@Get('me')
	me(@Req() request: any) {
		return this.authService.me(request.user.sub);
	}
}

@Module({
	imports: [
		JwtModule.register({
			secret: process.env.JWT_SECRET || 'dev-secret',
			signOptions: {
				expiresIn: process.env.JWT_EXPIRES_IN || '1d',
			},
		}),
	],
	controllers: [AuthController],
	providers: [PrismaService, AuthService, JwtStrategy],
	exports: [AuthService],
})
export class AuthModule {}
