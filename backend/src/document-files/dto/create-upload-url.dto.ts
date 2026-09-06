import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateUploadUrlDto {
	@IsString()
	@MinLength(1)
	@MaxLength(200)
	fileName!: string;

	@IsString()
	@MinLength(1)
	@MaxLength(100)
	mimeType!: string;

	@IsInt()
	@Min(1)
	size!: number;
}
