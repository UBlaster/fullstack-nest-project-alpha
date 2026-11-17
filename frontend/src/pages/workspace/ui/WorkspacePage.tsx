import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PaymentsSection } from '../../../features/payments';
import { apiWithStatus } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';

interface Workspace {
	id: string;
	name: string;
}

interface User {
	id: string;
}

export function WorkspacePage() {
	const { workspaceId } = useParams();
	const [loaded, setLoaded] = useState<{ workspace: Workspace; user: User } | null>(null);
	const [error, setError] = useState('');

	useEffect(() => {
		const controller = new AbortController();
		void Promise.all([
			apiWithStatus<Workspace>(`/workspaces/${encodeURIComponent(workspaceId ?? '')}`, {
				signal: controller.signal,
			}),
			apiWithStatus<User>('/auth/me', { signal: controller.signal }),
		])
			.then(([workspace, user]) => {
				if (!controller.signal.aborted) {
					setError('');
					setLoaded({ workspace: workspace.data, user: user.data });
				}
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) {
					setError(failure instanceof Error ? failure.message : 'Не удалось открыть workspace');
				}
			});
		return () => controller.abort();
	}, [workspaceId]);

	return (
		<Layout>
			<nav className="page-navigation" aria-label="Навигация workspace">
				<Link className="button-link button-secondary" to="/projects">
					← Проекты и workspace
				</Link>
			</nav>
			{error ? (
				<p className="error" role="alert">
					{error}
				</p>
			) : loaded && workspaceId && loaded.workspace.id === workspaceId ? (
				<>
					<div className="page-heading">
						<h1>{loaded.workspace.name}</h1>
						<p className="muted">Тестовая оплата и история платежей рабочего пространства.</p>
					</div>
					<PaymentsSection
						key={`${loaded.user.id}:${workspaceId}`}
						workspaceId={workspaceId}
						userId={loaded.user.id}
					/>
				</>
			) : (
				<p>Загрузка workspace…</p>
			)}
		</Layout>
	);
}
