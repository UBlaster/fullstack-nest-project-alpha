import { useEffect } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { DocumentPage } from '../pages/document';
import { LoginPage } from '../pages/login';
import { ProjectPage } from '../pages/project';
import { ProjectsPage } from '../pages/projects';
import { WorkspacePage } from '../pages/workspace';
import { PaymentResultPage } from '../pages/payment-result';

function RootRedirect() {
	const navigate = useNavigate();

	useEffect(() => {
		navigate(localStorage.getItem('token') ? '/projects' : '/login');
	}, [navigate]);

	return null;
}

export function App() {
	return (
		<Routes>
			<Route path="/login" element={<LoginPage />} />
			<Route path="/projects" element={<ProjectsPage />} />
			<Route path="/projects/:id" element={<ProjectPage />} />
			<Route path="/documents/:id" element={<DocumentPage />} />
			<Route path="/workspaces/:workspaceId" element={<WorkspacePage />} />
			<Route path="/payments/:id/result" element={<PaymentResultPage />} />
			<Route path="*" element={<RootRedirect />} />
		</Routes>
	);
}
