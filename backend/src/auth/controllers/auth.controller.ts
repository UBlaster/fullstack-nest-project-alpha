import { Body, Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { AccountService } from '../account.service';
import { AuthenticatedRequest } from '../authenticated-request';
import { AuthService } from '../auth.service';
import { JwtAuth } from '../decorators/jwt-auth.decorator';
import { DeleteAccountDto } from '../dto/delete-account.dto';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { RegistrationService } from '../registration.service';

@Controller('auth')
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly registrationService: RegistrationService,
		private readonly accountService: AccountService,
	) {}

	@Post('register')
	register(@Body() dto: RegisterDto) {
		return this.registrationService.register(dto);
	}

	@Post('login')
	@HttpCode(200)
	login(@Body() dto: LoginDto) {
		return this.authService.login(dto);
	}

	@JwtAuth()
	@Get('me')
	me(@Req() request: AuthenticatedRequest) {
		return this.authService.me(request.user.sub);
	}

	@JwtAuth()
	@Delete('me')
	deleteAccount(@Req() request: AuthenticatedRequest, @Body() dto: DeleteAccountDto) {
		return this.accountService.deleteAccount(request.user.sub, dto);
	}
}
