import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateProjectDto {
	@IsString()
	@IsNotEmpty()
	name!: string;

	@IsOptional()
	@IsString()
	description?: string;
}

export class UpdateProjectDto {
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	name?: string;

	@IsOptional()
	@IsString()
	description?: string;
}
