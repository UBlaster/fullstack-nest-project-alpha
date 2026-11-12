import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, ValidateIf } from 'class-validator';

export class UpdateDocumentDto {
	@IsOptional()
	@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
	@IsString()
	@Length(1, 160)
	title?: string;

	@ValidateIf((_object: UpdateDocumentDto, value: unknown) => value !== undefined)
	@IsString()
	content?: string;
}
