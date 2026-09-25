import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateProjectDto {
	@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
	@IsString()
	@Length(1, 120)
	declare name: string;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	description?: string;
}
