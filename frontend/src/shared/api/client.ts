const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const api = async (path: string, options: RequestInit = {}) => {
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

	return response.status === 204 ? null : response.json();
};
