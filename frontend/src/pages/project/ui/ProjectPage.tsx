import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadPresignedUrl } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';

export function ProjectPage() {
	const { id } = useParams();
	const [project, setProject] = useState<any>();
	const [documents, setDocuments] = useState<any[]>([]);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchError, setSearchError] = useState('');
	const [isSearching, setIsSearching] = useState(false);
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
	const load = useCallback(
		() =>
			api('/projects/' + id)
				.then((data) => {
					setProject(data);
					setDocuments(data.documents);
				})
				.catch((error) => setError(error.message)),
		[id],
	);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		const query = searchQuery.trim();

		if (!project || query.length < 2) {
			return;
		}

		const controller = new AbortController();
		const timeout = window.setTimeout(() => {
			setIsSearching(true);
			setSearchError('');

			api(`/workspaces/${project.workspaceId}/documents/search?q=${encodeURIComponent(query)}`, {
				signal: controller.signal,
			})
				.then(setDocuments)
				.catch((error) => {
					if (!controller.signal.aborted) {
						setSearchError(error.message);
					}
				})
				.finally(() => {
					if (!controller.signal.aborted) {
						setIsSearching(false);
					}
				});
		}, 300);

		return () => {
			window.clearTimeout(timeout);
			controller.abort();
		};
	}, [project, searchQuery]);

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
			<div className="section-heading">
				<h2>Документы ({documents.length})</h2>
				<button
					type="button"
					disabled={
						isExporting ||
						activeExportJob?.status === 'QUEUED' ||
						activeExportJob?.status === 'PROCESSING'
					}
					onClick={async () => {
						setIsExporting(true);
						setExportError('');
						try {
							const created = await api(`/workspaces/${project.workspaceId}/exports`, {
								method: 'POST',
								body: JSON.stringify({}),
							});
							setExportJob({ ...created, projectId: id, errorCode: null, downloadUrl: null });
						} catch (error) {
							setExportError(error instanceof Error ? error.message : 'Ошибка экспорта');
						} finally {
							setIsExporting(false);
						}
					}}
				>
					{isExporting ? 'Запуск...' : 'Подготовить CSV workspace'}
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
					{activeExportJob.status === 'COMPLETED' && activeExportJob.downloadUrl && (
						<button
							type="button"
							onClick={async () => {
								try {
									setExportError('');
									// Polling stops at completion; the original signed URL may
									// already be expired when the user clicks Download.
									const current = await api(`/exports/${activeExportJob.id}`);
									if (!current.downloadUrl)
										throw new Error('Срок хранения экспорта истёк. Подготовьте новый CSV.');
									downloadPresignedUrl(current.downloadUrl);
								} catch (error) {
									setExportError(
										error instanceof Error ? error.message : 'Ошибка скачивания экспорта',
									);
								}
							}}
						>
							Скачать готовый CSV
						</button>
					)}
				</div>
			)}
			<input
				type="search"
				placeholder="Поиск документов по заголовку"
				aria-label="Поиск документов по заголовку"
				value={searchQuery}
				onChange={(event) => {
					const value = event.target.value;
					const query = value.trim();

					setSearchQuery(value);

					if (query.length < 2) {
						setDocuments(project.documents);
						setSearchError(query.length === 1 ? 'Введите минимум два символа' : '');
						setIsSearching(false);
					}
				}}
			/>
			{isSearching && <p>Поиск...</p>}
			{searchError && <p className="error">{searchError}</p>}
			{!isSearching && !searchError && searchQuery.trim().length >= 2 && documents.length === 0 && (
				<p>Документы не найдены</p>
			)}
			{documents.map((doc: any) => (
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
