import { applyDecorators, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export const JwtAuthGuard = AuthGuard('jwt');

export function JwtAuth() {
	return applyDecorators(UseGuards(JwtAuthGuard));
}
