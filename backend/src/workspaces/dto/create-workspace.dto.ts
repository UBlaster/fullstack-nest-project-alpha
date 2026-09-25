import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class CreateWorkspaceDto {
	@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
	@IsString()
	@Length(1, 120)
	declare name: string;
}
