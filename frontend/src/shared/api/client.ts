const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function authenticatedFetch(path: string, options: RequestInit = {}) {
	const token = localStorage.getItem('token');
	const response = await fetch(API + path, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(token
				? {
						Authorization: `Bearer ${token}`,
					}
				: {}),
			...(options.headers || {}),
		},
	});
	if (!response.ok) {
		throw new Error(
			(
				await response.json().catch(() => ({
					message: response.statusText,
				}))
			).message,
		);
	}
	return response;
}

export const api = async (path: string, options: RequestInit = {}) => {
	const response = await authenticatedFetch(path, options);
	return response.status === 204 ? null : response.json();
};

export async function downloadAuthenticated(path: string, fileName: string): Promise<void> {
	const response = await authenticatedFetch(path, {
		headers: { Accept: 'text/csv' },
	});
	const url = URL.createObjectURL(await response.blob());
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	link.click();
	URL.revokeObjectURL(url);
}

export function downloadPresignedUrl(url: string): void {
	const link = document.createElement('a');
	link.href = url;
	link.rel = 'noopener';
	link.click();
}

export function uploadToPresignedUrl(
	url: string,
	file: File,
	mimeType: string,
	onProgress: (percent: number) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open('PUT', url);
		request.setRequestHeader('Content-Type', mimeType);
		request.upload.addEventListener('progress', (event) => {
			if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
		});
		request.addEventListener('load', () => {
			if (request.status >= 200 && request.status < 300) resolve();
			else reject(new Error(`Object Storage вернул HTTP ${request.status}`));
		});
		request.addEventListener('error', () => reject(new Error('Не удалось загрузить файл')));
		request.addEventListener('abort', () => reject(new Error('Загрузка отменена')));
		request.send(file);
	});
}
