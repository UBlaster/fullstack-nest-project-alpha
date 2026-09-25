import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateUploadUrlDto {
	@IsString()
	@MinLength(1)
	@MaxLength(200)
	declare fileName: string;

	@IsString()
	@MinLength(1)
	@MaxLength(100)
	declare mimeType: string;

	@IsInt()
	@Min(1)
	declare size: number;
}
