import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadPresignedUrl } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';
import { WorkspaceDocumentSearch, type DocumentSummary } from './WorkspaceDocumentSearch';

interface Project {
	id: string;
	workspaceId: string;
	name: string;
	description: string;
	documents: DocumentSummary[];
}

export function ProjectPage() {
	const { id } = useParams();
	const [project, setProject] = useState<Project>();
	const [title, setTitle] = useState('');
	const [content, setContent] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [exportError, setExportError] = useState('');
	const [isExporting, setIsExporting] = useState(false);
	const [exportJob, setExportJob] = useState<{
		id: string;
		projectId: string | undefined;
		status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
		progress: number;
		errorCode: string | null;
		downloadUrl: string | null;
	} | null>(null);
	const activeExportJob = exportJob?.projectId === id ? exportJob : null;
	const exportJobId = activeExportJob?.id;
	const exportJobStatus = activeExportJob?.status;
	const isExportReady = exportJobStatus === 'COMPLETED' && !!activeExportJob?.downloadUrl;
	const isExportPreparing = exportJobStatus === 'QUEUED' || exportJobStatus === 'PROCESSING';
	const load = useCallback(
		() =>
			api('/projects/' + id)
				.then(setProject)
				.catch((error) => setError(error.message)),
		[id],
	);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		if (!exportJobId || !exportJobStatus || !['QUEUED', 'PROCESSING'].includes(exportJobStatus)) {
			return;
		}
		const controller = new AbortController();
		let timer: number | undefined;
		let stopped = false;
		const poll = async () => {
			try {
				const current = await api(`/exports/${exportJobId}`, { signal: controller.signal });
				if (stopped) return;
				setExportJob((previous) =>
					previous?.id === exportJobId && ['QUEUED', 'PROCESSING'].includes(previous.status)
						? { ...current, projectId: previous.projectId }
						: previous,
				);
			} catch (error) {
				if (!controller.signal.aborted) {
					setExportError(error instanceof Error ? error.message : 'Ошибка статуса экспорта');
				}
			} finally {
				if (!stopped) timer = window.setTimeout(poll, 1_000);
			}
		};
		timer = window.setTimeout(poll, 1_000);
		return () => {
			stopped = true;
			if (timer !== undefined) window.clearTimeout(timer);
			controller.abort();
		};
	}, [exportJobId, exportJobStatus]);

	if (error) {
		return (
			<Layout>
				<p>!Ошибка: {error}</p>
			</Layout>
		);
	}

	if (!project || project.id !== id) {
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
			<section className="card workspace-payment-entry">
				<div>
					<h2>Платежи workspace</h2>
					<p className="muted">Тестовая покупка и история оплат рабочего пространства.</p>
				</div>
				<Link className="button-link" to={`/workspaces/${project.workspaceId}`}>
					Открыть платежи
				</Link>
			</section>
			<div className="section-heading">
				<h2>Документы проекта ({project.documents.length})</h2>
				<button
					type="button"
					disabled={isExporting || isExportPreparing}
					onClick={async () => {
						setIsExporting(true);
						setExportError('');
						try {
							if (activeExportJob?.status === 'COMPLETED' && activeExportJob.downloadUrl) {
								const current = await api(`/exports/${activeExportJob.id}`);
								setExportJob((previous) =>
									previous?.id === activeExportJob.id ? { ...current, projectId: id } : previous,
								);
								if (!current.downloadUrl)
									throw new Error('Срок хранения экспорта истёк. Подготовьте новый CSV.');
								downloadPresignedUrl(current.downloadUrl);
							} else {
								const created = await api(`/workspaces/${project.workspaceId}/exports`, {
									method: 'POST',
									body: JSON.stringify({}),
								});
								setExportJob({ ...created, projectId: id, errorCode: null, downloadUrl: null });
							}
						} catch (error) {
							setExportError(error instanceof Error ? error.message : 'Ошибка экспорта');
						} finally {
							setIsExporting(false);
						}
					}}
				>
					{isExporting
						? isExportReady
							? 'Скачивание...'
							: 'Запуск...'
						: isExportReady
							? 'Скачать готовый CSV'
							: isExportPreparing
								? 'Подготовка CSV...'
								: 'Подготовить CSV workspace'}
				</button>
			</div>
			{exportError && <p className="error">{exportError}</p>}
			{activeExportJob && (
				<div className="export-status" aria-live="polite">
					<span>
						Экспорт: {activeExportJob.status} · {activeExportJob.progress}%
					</span>
					{activeExportJob.errorCode && (
						<span className="error">Код: {activeExportJob.errorCode}</span>
					)}
					{['QUEUED', 'PROCESSING'].includes(activeExportJob.status) && (
						<button
							type="button"
							onClick={async () => {
								try {
									setExportError('');
									const cancelled = await api(`/exports/${activeExportJob.id}`, {
										method: 'DELETE',
									});
									setExportJob((previous) =>
										previous?.id === activeExportJob.id
											? { ...cancelled, projectId: id }
											: previous,
									);
								} catch (error) {
									setExportError(error instanceof Error ? error.message : 'Ошибка отмены экспорта');
								}
							}}
						>
							Отменить
						</button>
					)}
				</div>
			)}
			<WorkspaceDocumentSearch
				key={project.id}
				workspaceId={project.workspaceId}
				documents={project.documents}
			/>
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
