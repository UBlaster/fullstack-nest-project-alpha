import { applyDecorators, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export function JwtAuth() {
	return applyDecorators(UseGuards(AuthGuard('jwt')));
}
