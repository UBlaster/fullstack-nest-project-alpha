import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
	@IsEmail()
	@IsNotEmpty()
	email!: string;

	@IsString()
	@IsNotEmpty()
	password!: string;
}

export class createUserDto {
	@IsString()
	@IsNotEmpty()
	name!: string;

	@IsEmail()
	@IsNotEmpty()
	email!: string;

	@IsString()
	@IsNotEmpty()
	password!: string;

	@IsString()
	@IsNotEmpty()
	confirmPassword!: string;
}
