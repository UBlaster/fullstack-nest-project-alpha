import { useEffect, useState } from 'react';
import { apiWithStatus } from '../../../shared/api';

interface DocumentVersion {
	id: string;
	sourceFileId: string;
	version: number;
	status:
		'UPLOADED' | 'EXTRACTING' | 'NORMALIZING' | 'CHUNKING' | 'EMBEDDING' | 'INDEXED' | 'FAILED';
	isCurrent: boolean;
	stages: { stage: string; status: string; errorCode: string | null }[];
}

export function useDocumentVersions(documentId: string) {
	const [versions, setVersions] = useState<DocumentVersion[]>([]);
	const [revision, setRevision] = useState(0);
	const [loadError, setLoadError] = useState('');
	const [actionError, setActionError] = useState('');
	const [notice, setNotice] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		let timer: number | undefined;
		async function refresh() {
			try {
				const { data } = await apiWithStatus<DocumentVersion[]>(
					`/documents/${documentId}/versions`,
					{
						signal: controller.signal,
					},
				);
				if (controller.signal.aborted) return;
				setVersions(data);
				setLoadError('');
				if (
					data.some(
						(version) =>
							version.status !== 'FAILED' &&
							!version.stages.some((run) => run.stage === 'ACTIVATE' && run.status === 'COMPLETED'),
					)
				) {
					timer = window.setTimeout(refresh, 1500);
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					setLoadError(error instanceof Error ? error.message : 'Не удалось получить версии');
				}
			}
		}
		void refresh();
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [documentId, revision]);

	async function submit(path: string, sourceFileId?: string) {
		setActionError('');
		setNotice('');
		setBusy(true);
		try {
			const { data } = await apiWithStatus<DocumentVersion>(path, {
				method: 'POST',
				body: sourceFileId ? JSON.stringify({ sourceFileId }) : undefined,
			});
			if (sourceFileId && data.sourceFileId !== sourceFileId) {
				setNotice(`Файл совпадает по содержимому с версией ${data.version}.`);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'Ошибка запроса';
			setActionError(
				sourceFileId
					? `Файл сохранён. Не удалось запустить индексацию. ${reason}`
					: `Не удалось повторить обработку. ${reason}`,
			);
		} finally {
			setRevision((previous) => previous + 1);
			setBusy(false);
		}
	}

	return {
		versions,
		busy,
		actionError,
		loadError,
		notice,
		refresh: () => setRevision((previous) => previous + 1),
		index: (fileId: string) => submit(`/documents/${documentId}/versions`, fileId),
		retry: (versionId: string) => submit(`/document-versions/${versionId}/retry`),
	};
}
