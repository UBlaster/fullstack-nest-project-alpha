import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidSourceError } from './pipeline-state';

export const MAX_BYTES = 25 * 1024 * 1024;
const PART_BYTES = 64 * 1024;

export async function* sourceBytes(body: Readable, expectedSize: number) {
	let size = 0;
	try {
		for await (const data of body) {
			const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
			size += bytes.length;
			if (size > MAX_BYTES || size > expectedSize) throw new InvalidSourceError();
			for (let offset = 0; offset < bytes.length; offset += PART_BYTES)
				yield bytes.subarray(offset, offset + PART_BYTES);
		}
		if (!size || size !== expectedSize) throw new InvalidSourceError();
	} finally {
		body.destroy();
	}
}

async function* pdfText(input: AsyncIterable<Buffer>, signal: AbortSignal) {
	const child = spawn('pdftotext', ['-enc', 'UTF-8', '-', '-'], {
		stdio: ['pipe', 'pipe', 'ignore'],
		windowsHide: true,
		signal,
	});
	const closed = new Promise<void>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => (code === 0 ? resolve() : reject(new InvalidSourceError())));
	});
	const inputStream = Readable.from(input);
	const finished = Promise.allSettled([closed, pipeline(inputStream, child.stdin)]);
	const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
	try {
		for await (const bytes of child.stdout) yield Buffer.from(bytes);
		const [parser, writer] = await finished;
		if (writer.status === 'rejected') {
			const code = (writer.reason as NodeJS.ErrnoException | undefined)?.code;
			// Poppler can reject an invalid PDF before reading the last input bytes.
			if (
				parser.status === 'rejected' &&
				(code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE')
			) {
				throw parser.reason;
			}
			throw writer.reason;
		}
		if (parser.status === 'rejected') throw parser.reason;
	} finally {
		clearTimeout(timeout);
		inputStream.destroy();
		child.kill('SIGKILL');
		await finished;
	}
}

export async function* extractText(
	body: Readable,
	size: number,
	expectedHash: string,
	mimeType: string,
	signal: AbortSignal,
) {
	const hash = createHash('sha256');
	async function* verified() {
		for await (const bytes of sourceBytes(body, size)) {
			hash.update(bytes);
			yield bytes;
		}
		if (hash.digest('hex') !== expectedHash) throw new InvalidSourceError();
	}
	const stream = mimeType === 'application/pdf' ? pdfText(verified(), signal) : verified();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let outputBytes = 0;
	const decode = (bytes?: Buffer) => {
		try {
			const text = decoder.decode(bytes, { stream: bytes !== undefined });
			if (text.includes('\0')) throw new InvalidSourceError();
			return text;
		} catch {
			throw new InvalidSourceError();
		}
	};
	for await (const bytes of stream) {
		outputBytes += bytes.length;
		if (outputBytes > MAX_BYTES) throw new InvalidSourceError();
		const part = decode(bytes);
		if (part) yield part;
	}
	const tail = decode();
	if (tail) yield tail;
}

export async function* normalizeText(input: AsyncIterable<string>) {
	let pendingSpace = false;
	let hasText = false;
	for await (const text of input) {
		const collapsed = text.replace(/\s+/gu, ' ');
		const body = collapsed.trim();
		if (body) {
			yield (hasText && (pendingSpace || collapsed.startsWith(' ')) ? ' ' : '') + body;
			hasText = true;
		}
		if (collapsed.length) pendingSpace = collapsed.endsWith(' ');
	}
	if (!hasText) throw new InvalidSourceError();
}

// A stable estimate: each token holds at most four Unicode code points from one
// word and its preceding separator. Rejoining tokens preserves normalized text.
async function* tokens(input: AsyncIterable<string>) {
	let token = '',
		length = 0;
	for await (const part of input) {
		for (const char of part) {
			if (char === ' ' || length === 4) {
				if (length) yield token;
				token = '';
				length = 0;
			}
			token += char;
			if (char !== ' ') length++;
		}
	}
	if (length) yield token;
}

export async function* chunkText(input: AsyncIterable<string>) {
	let window: string[] = [];
	let fresh = 0;
	for await (const token of tokens(input)) {
		window.push(token);
		fresh++;
		if (window.length === 800) {
			yield { text: window.join('').trimStart(), tokenCount: window.length };
			window = window.slice(-100);
			fresh = 0;
		}
	}
	if (fresh) yield { text: window.join('').trimStart(), tokenCount: window.length };
}
