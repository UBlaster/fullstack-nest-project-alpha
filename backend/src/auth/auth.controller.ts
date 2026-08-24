import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Post,
	Req,
	UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { createUserDto, LoginDto } from './dto/login.dto';

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

	@UseGuards(AuthGuard('jwt'))
	@Delete('delete')
	delete(@Param('id') id: string) {
		return this.authService.delete(id);
	}

	@Post('create')
	register(@Body() dto: createUserDto) {
		return this.authService.create(dto);
	}
}
