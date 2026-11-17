import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiWithStatus } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';

export function ProjectsPage() {
	const [projects, setProjects] = useState<any[]>([]);
	const [error, setError] = useState('');
	const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
	const [workspaceError, setWorkspaceError] = useState('');

	useEffect(() => {
		api('/projects')
			.then(setProjects)
			.catch((err) => setError(err.message));
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void apiWithStatus<{ id: string; name: string }[]>('/workspaces', {
			signal: controller.signal,
		})
			.then((response) => {
				if (!controller.signal.aborted) setWorkspaces(response.data);
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) {
					setWorkspaceError(
						failure instanceof Error ? failure.message : 'Не удалось загрузить workspace',
					);
				}
			});
		return () => controller.abort();
	}, []);

	return (
		<Layout>
			<h1>Проекты</h1>
			<section className="workspace-section">
				<h2>Workspace</h2>
				<p className="muted">Тестовая оплата и история платежей ваших рабочих пространств.</p>
				{workspaceError && <p className="error">{workspaceError}</p>}
				<div className="grid">
					{workspaces.map((workspace) => (
						<article className="card workspace-card" key={workspace.id}>
							<h3>{workspace.name}</h3>
							<p className="muted">
								Демонстрационная покупка — 100 ₽. Доступна владельцу workspace.
							</p>
							<Link className="button-link" to={`/workspaces/${workspace.id}`}>
								Тестовые платежи
							</Link>
						</article>
					))}
				</div>
			</section>
			<h2>Список проектов</h2>
			{error && <p className="error">{error}</p>}
			<div className="grid">
				{projects.map((project) => (
					<Link className="card" to={`/projects/${project.id}`} key={project.id}>
						<h2>{project.name}</h2>
						<p>{project.description}</p>
						<span>
							{project.status} · {project._count.documents} документов
						</span>
					</Link>
				))}
			</div>
		</Layout>
	);
}
