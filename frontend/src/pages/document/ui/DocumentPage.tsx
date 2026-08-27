import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';

export function DocumentPage() {
	const { id } = useParams();
	const [doc, setDoc] = useState<any>();
	const [title, setTitle] = useState('');
	const [content, setContent] = useState('');
	const [error, setError] = useState('');

	useEffect(() => {
		api('/documents/' + id)
			.then((data) => {
				setDoc(data);
				setTitle(data.title);
				setContent(data.content);
			})
			.catch((error) => {
				setError(error.message);
			});
	}, [id]);

	if (error) {
		return (
			<Layout>
				<p>{error}</p>
			</Layout>
		);
	}

	if (!doc) {
		return (
			<Layout>
				<p>Загрузка...</p>
			</Layout>
		);
	}

	return (
		<Layout>
			<Link to={`/projects/${doc.projectId}`}>← Проект</Link>
			<h1>Редактирование документа</h1>
			<input value={title} onChange={(event) => setTitle(event.target.value)} />
			<textarea value={content} onChange={(event) => setContent(event.target.value)} />
			<button
				onClick={async () => {
					await api('/documents/' + id, {
						method: 'PATCH',
						body: JSON.stringify({
							title,
							content,
						}),
					});
					alert('Сохранено');
				}}
			>
				Сохранить
			</button>
			<button
				className="danger"
				onClick={async () => {
					await api('/documents/' + id, {
						method: 'DELETE',
					});
					location.href = `/projects/${doc.projectId}`;
				}}
			>
				Удалить
			</button>
		</Layout>
	);
}
