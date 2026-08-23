import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';

export function ProjectsPage() {
	const [projects, setProjects] = useState<any[]>([]);
	const [error, setError] = useState('');

	useEffect(() => {
		api('/projects')
			.then(setProjects)
			.catch((err) => setError(err.message));
	}, []);

	return (
		<Layout>
			<h1>Проекты</h1>
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
