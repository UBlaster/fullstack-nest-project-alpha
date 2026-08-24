import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

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
