import { ValidationPipe } from '@nestjs/common';

export const createAppValidationPipe = () =>
	new ValidationPipe({
		whitelist: true,
		transform: true,
	});
