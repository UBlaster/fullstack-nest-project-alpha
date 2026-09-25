import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length } from 'class-validator';

export class RegisterDto {
	@Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
	@IsEmail()
	declare email: string;

	@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
	@IsString()
	@Length(2, 100)
	declare name: string;

	@IsString()
	@Length(8, 72)
	declare password: string;

	@IsString()
	@Length(8, 72)
	declare passwordConfirmation: string;
}
