import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticatedRequest } from './authenticated-request';
import { AuthService } from './auth.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
	constructor(private readonly authService: AuthService) {}

	@Post('register')
	register(@Body() dto: RegisterDto) {
		return this.authService.register(dto);
	}

	@Post('login')
	@HttpCode(200)
	login(@Body() dto: LoginDto) {
		return this.authService.login(dto);
	}

	@UseGuards(AuthGuard('jwt'))
	@Get('me')
	me(@Req() request: AuthenticatedRequest) {
		return this.authService.me(request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete('me')
	deleteAccount(@Req() request: AuthenticatedRequest, @Body() dto: DeleteAccountDto) {
		return this.authService.deleteAccount(request.user.sub, dto);
	}
}
