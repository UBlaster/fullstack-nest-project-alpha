import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDocumentDto {
	@IsString()
	@IsNotEmpty()
	title!: string;

	@IsString()
	content!: string;
}

export class UpdateDocumentDto {
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	title?: string;

	@IsOptional()
	@IsString()
	content?: string;
}
