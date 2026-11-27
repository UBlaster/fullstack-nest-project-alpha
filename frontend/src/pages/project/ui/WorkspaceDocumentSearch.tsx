import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiWithStatus } from '../../../shared/api';

export interface DocumentSummary {
	id: string;
	title: string;
	status: string;
	author: { name: string };
}

interface HybridHit {
	documentId: string;
	title: string;
	snippet: string;
}

interface SearchRow {
	id: string;
	title: string;
	detail: string;
}

function summaryRow(doc: DocumentSummary): SearchRow {
	return { id: doc.id, title: doc.title, detail: `${doc.status} · ${doc.author.name}` };
}

export function WorkspaceDocumentSearch({
	workspaceId,
	documents,
}: {
	workspaceId: string;
	documents: DocumentSummary[];
}) {
	const [input, setInput] = useState('');
	const [mode, setMode] = useState('hybrid');
	const [result, setResult] = useState<{ url: string; rows: SearchRow[]; error?: string }>();
	const query = input.trim();
	const endpoint = mode === 'hybrid' ? 'search' : 'documents/search';
	const url =
		query.length < 2 ? '' : `/workspaces/${workspaceId}/${endpoint}?q=${encodeURIComponent(query)}`;

	useEffect(() => {
		if (!url) return;
		const controller = new AbortController();
		const options = { signal: controller.signal };
		const timer = window.setTimeout(async () => {
			try {
				let rows: SearchRow[];
				if (mode === 'hybrid') {
					const { data } = await apiWithStatus<{ items: HybridHit[] }>(url, options);
					rows = data.items.map(({ documentId, title, snippet }) => ({
						id: documentId,
						title,
						detail: snippet,
					}));
				} else {
					const { data } = await apiWithStatus<DocumentSummary[]>(url, options);
					rows = data.map(summaryRow);
				}
				if (!controller.signal.aborted) setResult({ url, rows });
			} catch (error) {
				if (!controller.signal.aborted) {
					setResult({
						url,
						rows: [],
						error: error instanceof Error ? error.message : 'Ошибка поиска',
					});
				}
			}
		}, 300);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [mode, url]);

	const current = result?.url === url ? result : undefined;
	const rows = query.length === 0 ? documents.map(summaryRow) : current?.rows;
	return (
		<section aria-label="Поиск документов">
			<label htmlFor="workspace-document-query">Поиск в рабочем пространстве</label>
			<input
				id="workspace-document-query"
				type="search"
				placeholder="Название или фраза для поиска"
				maxLength={100}
				value={input}
				onChange={(event) => setInput(event.target.value)}
			/>
			<label htmlFor="workspace-search-mode">Искать </label>
			<select
				id="workspace-search-mode"
				value={mode}
				onChange={(event) => setMode(event.target.value)}
			>
				<option value="hybrid">По заголовку и содержимому индексированных версий</option>
				<option value="title">По заголовкам всех документов</option>
			</select>
			<div aria-live="polite">
				{query.length === 1 && <p>Введите минимум два символа.</p>}
				{url && !current && <p>Поиск…</p>}
				{current?.error && <p className="error">{current.error}</p>}
				{url && current && !current.error && <p>Найдено документов: {current.rows.length}</p>}
			</div>
			{rows?.map((row) => (
				<Link className="doc document-search-result" to={`/documents/${row.id}`} key={row.id}>
					<b>{row.title}</b>
					<span>{row.detail}</span>
				</Link>
			))}
		</section>
	);
}
