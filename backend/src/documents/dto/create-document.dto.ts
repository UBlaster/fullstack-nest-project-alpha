import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class CreateDocumentDto {
	@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
	@IsString()
	@Length(1, 160)
	title!: string;

	@IsString()
	content!: string;
}
