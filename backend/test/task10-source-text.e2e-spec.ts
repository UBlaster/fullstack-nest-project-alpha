import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
	chunkText,
	extractText,
	normalizeText,
	sourceBytes,
} from '../src/document-pipeline/source-text';
import { InvalidSourceError } from '../src/document-pipeline/pipeline-state';

async function collect<T>(source: AsyncIterable<T>) {
	const parts: T[] = [];
	for await (const part of source) parts.push(part);
	return parts;
}

async function* parts<T>(...values: T[]) {
	yield* values;
}

describe('Task 10 streaming checkpoints', () => {
	it('keeps split UTF-8 code points and collapses whitespace across checkpoint boundaries', async () => {
		const data = Buffer.from('  Пример\r\n\t текста  ');
		const split = Readable.from(Array.from(data, (byte) => Buffer.from([byte])));
		const hash = createHash('sha256').update(data).digest('hex');
		const decoded = extractText(
			split,
			data.length,
			hash,
			'text/plain',
			new AbortController().signal,
		);
		expect((await collect(normalizeText(decoded))).join('')).toBe('Пример текста');
	});
	it('rejects changed bytes and invalid UTF-8 before a checkpoint can complete', async () => {
		const signal = new AbortController().signal;
		for (const bytes of [Buffer.from('changed'), Buffer.from([0xff])]) {
			await expect(
				collect(
					extractText(Readable.from([bytes]), bytes.length, '0'.repeat(64), 'text/plain', signal),
				),
			).rejects.toBeInstanceOf(InvalidSourceError);
		}
		await expect(collect(sourceBytes(Readable.from([Buffer.alloc(6)]), 5))).rejects.toBeInstanceOf(
			InvalidSourceError,
		);
		await expect(collect(normalizeText(parts(' ', '\n', '\t')))).rejects.toBeInstanceOf(
			InvalidSourceError,
		);
	});
	it('uses 800 estimated tokens and exactly 100 tokens of overlap without an empty tail', async () => {
		const words = Array.from({ length: 801 }, (_, i) => String(i));
		const chunks = await collect(
			chunkText(parts(words.slice(0, 402).join(' '), ' ' + words.slice(402).join(' '))),
		);
		expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([800, 101]);
		expect(chunks[1].text).toBe(words.slice(700).join(' '));
		expect(await collect(chunkText(parts(words.slice(0, 800).join(' '))))).toHaveLength(1);
	});
});
