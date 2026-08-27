import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWorkspaceDto {
	@IsString()
	@IsNotEmpty()
	name!: string;
}

export class UpdateWorkspaceDto {
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	name?: string;
}
