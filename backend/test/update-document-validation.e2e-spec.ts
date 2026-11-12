import { HttpStatus } from '@nestjs/common';
import { UpdateDocumentDto } from '../src/documents/dto/update-document.dto';
import { createAppValidationPipe } from '../src/validation.pipe';

function validateUpdate(body: unknown): Promise<UpdateDocumentDto> {
	return createAppValidationPipe().transform(body, {
		type: 'body',
		metatype: UpdateDocumentDto,
	});
}

describe('Document PATCH validation (no database/network)', () => {
	it('allows a title-only update without content', async () => {
		const update = await validateUpdate({ title: 'Renamed document' });
		expect(update).toBeInstanceOf(UpdateDocumentDto);
		expect(update.title).toBe('Renamed document');
		expect(update.content).toBeUndefined();
	});

	it.each(['', 'Updated text', 'Текст\nс новой строкой'])(
		'preserves valid content: %j',
		async (content) => {
			await expect(validateUpdate({ content })).resolves.toMatchObject({ content });
		},
	);

	it.each([
		{ label: 'null', content: null },
		{ label: 'a number', content: 42 },
		{ label: 'a boolean', content: false },
		{ label: 'an array', content: [] },
		{ label: 'an object', content: {} },
	])('rejects $label content with HTTP 400', async ({ content }) => {
		await expect(validateUpdate({ content })).rejects.toMatchObject({
			response: {
				statusCode: HttpStatus.BAD_REQUEST,
				message: expect.arrayContaining(['content must be a string']),
			},
		});
	});
});
