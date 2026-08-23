import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

export function Layout({ children }: { children: React.ReactNode }) {
	const navigate = useNavigate();

	return (
		<>
			<header>
				<Link to="/projects">
					<b>Workspace Docs</b>
				</Link>
				<button
					onClick={() => {
						localStorage.clear();
						navigate('/login');
					}}
				>
					Выйти
				</button>
			</header>
			<main>{children}</main>
		</>
	);
}
