import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';

const defaultLimit = 20;
const defaultOffset = 0;

const trimString = ({ value }: { value: unknown }) =>
	typeof value === 'string' ? value.trim() : value;

const parseNumber =
	(defaultValue: number) =>
	({ value }: { value: unknown }) => {
		if (value === undefined) {
			return defaultValue;
		}

		if (
			(typeof value !== 'string' && typeof value !== 'number') ||
			(typeof value === 'string' && value.trim() === '')
		) {
			return Number.NaN;
		}

		return Number(value);
	};

export class SearchDocumentsQueryDto {
	@Transform(trimString)
	@IsString()
	@Length(2, 100)
	declare q: string;

	@Transform(parseNumber(defaultLimit))
	@IsInt()
	@Min(1)
	@Max(50)
	limit: number = defaultLimit;

	@Transform(parseNumber(defaultOffset))
	@IsInt()
	@Min(0)
	@Max(5000)
	offset: number = defaultOffset;
}
