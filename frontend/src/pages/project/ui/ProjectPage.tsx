import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';

export function ProjectPage() {
	const { id } = useParams();
	const [project, setProject] = useState<any>();
	const [title, setTitle] = useState('');
	const [content, setContent] = useState('');
	const [error, setError] = useState<string | null>(null);
	const load = () =>
		api('/projects/' + id)
			.then(setProject)
			.catch((error) => setError(error.message));

	useEffect(() => {
		load();
	}, [id]);

	if (error) {
		return (
			<Layout>
				<p>!Ошибка: {error}</p>
			</Layout>
		);
	}

	if (!project) {
		return (
			<Layout>
				<p>Загрузка...</p>
			</Layout>
		);
	}

	return (
		<Layout>
			<Link to="/projects">← Проекты</Link>
			<h1>{project.name}</h1>
			<p>{project.description}</p>
			<h2>Документы</h2>
			{project.documents.map((doc: any) => (
				<Link className="doc" to={`/documents/${doc.id}`} key={doc.id}>
					<b>{doc.title}</b>
					<span>
						{doc.status} · {doc.author.name}
					</span>
				</Link>
			))}
			<section className="card">
				<h2>Новый документ</h2>
				<input
					placeholder="Заголовок"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
				<textarea
					placeholder="Содержание"
					value={content}
					onChange={(event) => setContent(event.target.value)}
				/>
				<button
					onClick={async () => {
						await api(`/projects/${id}/documents`, {
							method: 'POST',
							body: JSON.stringify({
								title,
								content,
								status: 'DRAFT',
							}),
						});
						setTitle('');
						setContent('');
						load();
					}}
				>
					Создать
				</button>
			</section>
		</Layout>
	);
}
