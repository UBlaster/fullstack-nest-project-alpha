import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, uploadToPresignedUrl } from '../../../shared/api';
import { Layout } from '../../../widgets/layout';

interface DocumentFile {
	id: string;
	originalName: string;
	mimeType: string;
	size: number;
	status: 'PENDING' | 'READY' | 'DELETING' | 'FAILED';
}

interface UploadResponse {
	file: DocumentFile;
	uploadUrl: string;
}

interface DocumentCapabilities {
	canUpdateDocument: boolean;
	canDeleteDocument: boolean;
	canManageFiles: boolean;
}

const readOnlyCapabilities: DocumentCapabilities = {
	canUpdateDocument: false,
	canDeleteDocument: false,
	canManageFiles: false,
};

const mimeByExtension: Record<string, string> = {
	'.txt': 'text/plain',
	'.md': 'text/markdown',
	'.markdown': 'text/markdown',
	'.pdf': 'application/pdf',
	'.csv': 'text/csv',
};

function uploadMimeType(file: File): string | undefined {
	const dot = file.name.lastIndexOf('.');
	return mimeByExtension[dot >= 0 ? file.name.slice(dot).toLowerCase() : ''];
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} Б`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
	return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export function DocumentPage() {
	const { id } = useParams();
	const [doc, setDoc] = useState<any>();
	const [title, setTitle] = useState('');
	const [content, setContent] = useState('');
	const [error, setError] = useState('');
	const [fileState, setFileState] = useState<{ documentId: string; files: DocumentFile[] }>({
		documentId: '',
		files: [],
	});
	const [fileError, setFileError] = useState('');
	const [isUploading, setIsUploading] = useState(false);
	const [uploadProgress, setUploadProgress] = useState(0);
	const [capabilityState, setCapabilityState] = useState<{
		documentId: string;
		value: DocumentCapabilities;
	}>({ documentId: '', value: readOnlyCapabilities });
	const files = fileState.documentId === id ? fileState.files : [];
	const capabilities =
		capabilityState.documentId === id ? capabilityState.value : readOnlyCapabilities;

	const loadFiles = useCallback(
		() =>
			api(`/documents/${id}/files`)
				.then((files) => setFileState({ documentId: id ?? '', files }))
				.catch((error) => setFileError(error.message)),
		[id],
	);

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

	useEffect(() => {
		loadFiles();
	}, [loadFiles]);

	useEffect(() => {
		api(`/documents/${id}/files/capabilities`)
			.then((value) => setCapabilityState({ documentId: id ?? '', value }))
			.catch((error) => setFileError(error.message));
	}, [id]);

	if (error) {
		return (
			<Layout>
				<p>{error}</p>
			</Layout>
		);
	}

	if (!doc || doc.id !== id) {
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
			<input
				value={title}
				disabled={!capabilities.canUpdateDocument}
				onChange={(event) => setTitle(event.target.value)}
			/>
			<textarea
				value={content}
				disabled={!capabilities.canUpdateDocument}
				onChange={(event) => setContent(event.target.value)}
			/>
			{capabilities.canUpdateDocument && (
				<button
					onClick={async () => {
						await api('/documents/' + id, {
							method: 'PATCH',
							body: JSON.stringify({ title, content }),
						});
						alert('Сохранено');
					}}
				>
					Сохранить
				</button>
			)}
			{capabilities.canDeleteDocument && (
				<button
					className="danger"
					onClick={async () => {
						await api('/documents/' + id, { method: 'DELETE' });
						location.href = `/projects/${doc.projectId}`;
					}}
				>
					Удалить
				</button>
			)}

			<section className="card files-section">
				<h2>Файлы документа</h2>
				<p className="muted">TXT, Markdown, PDF или CSV — максимум 25 МБ.</p>
				{capabilities.canManageFiles && (
					<input
						type="file"
						accept=".txt,.md,.markdown,.pdf,.csv"
						disabled={isUploading}
						onChange={async (event) => {
							const file = event.target.files?.[0];
							if (!file) return;
							const mimeType = uploadMimeType(file);
							if (!mimeType) {
								setFileError('Разрешены только TXT, Markdown, PDF и CSV');
								event.target.value = '';
								return;
							}
							setFileError('');
							setIsUploading(true);
							setUploadProgress(0);
							try {
								const upload = (await api(`/documents/${id}/files/upload-url`, {
									method: 'POST',
									body: JSON.stringify({ fileName: file.name, mimeType, size: file.size }),
								})) as UploadResponse;
								await uploadToPresignedUrl(upload.uploadUrl, file, mimeType, setUploadProgress);
								await api(`/documents/${id}/files/${upload.file.id}/complete`, {
									method: 'POST',
								});
								await loadFiles();
								event.target.value = '';
							} catch (error) {
								setFileError(error instanceof Error ? error.message : 'Ошибка загрузки');
								await loadFiles();
							} finally {
								setIsUploading(false);
							}
						}}
					/>
				)}
				{isUploading && (
					<div className="upload-progress" aria-live="polite">
						<progress max="100" value={uploadProgress} />
						<span>{uploadProgress}%</span>
					</div>
				)}
				{fileError && <p className="error">{fileError}</p>}
				{files.length === 0 && <p className="muted">Файлов пока нет.</p>}
				<div className="file-list">
					{files.map((file) => (
						<div className="file-row" key={file.id}>
							<div>
								<strong>{file.originalName}</strong>
								<span>
									{formatBytes(file.size)} · {file.status}
								</span>
							</div>
							<div className="file-actions">
								{file.status === 'READY' && (
									<button
										type="button"
										onClick={async () => {
											setFileError('');
											try {
												const result = await api(`/documents/${id}/files/${file.id}/download-url`);
												window.location.assign(result.downloadUrl);
											} catch (error) {
												setFileError(error instanceof Error ? error.message : 'Ошибка скачивания');
											}
										}}
									>
										Скачать
									</button>
								)}
								{capabilities.canManageFiles && (
									<button
										type="button"
										className="danger"
										onClick={async () => {
											setFileError('');
											try {
												await api(`/documents/${id}/files/${file.id}`, { method: 'DELETE' });
												await loadFiles();
											} catch (error) {
												setFileError(error instanceof Error ? error.message : 'Ошибка удаления');
											}
										}}
									>
										Удалить
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			</section>
		</Layout>
	);
}
