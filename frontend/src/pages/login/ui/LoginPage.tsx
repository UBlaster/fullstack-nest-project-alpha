import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../../shared/api';

export function LoginPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const [email, setEmail] = useState('admin@example.com');
	const [password, setPassword] = useState('password123');
	const [error, setError] = useState('');

	return (
		<div className="card login">
			<h1>Вход</h1>
			<input placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
			<input
				placeholder="Пароль"
				type="password"
				value={password}
				onChange={(event) => setPassword(event.target.value)}
			/>
			<button
				onClick={async () => {
					try {
						const response = await api('/auth/login', {
							method: 'POST',
							body: JSON.stringify({
								email,
								password,
							}),
						});
						localStorage.setItem('token', response.accessToken);
						const returnTo = searchParams.get('returnTo');
						navigate(
							returnTo &&
								/^\/(projects|documents|workspaces|payments)(\/|\?|#|$)/.test(returnTo) &&
								!returnTo.includes('\\')
								? returnTo
								: '/projects',
						);
					} catch (err: any) {
						setError(err.message);
					}
				}}
			>
				Войти
			</button>
			{error && <p className="error">{error}</p>}
			<small>admin@example.com / password123</small>
		</div>
	);
}
