import { PrismaClient, WorkspaceRole, ProjectStatus, DocumentStatus } from '@prisma/client';
const p = new PrismaClient();
async function main() {
	const existingUsers = await p.user.count();
	if (existingUsers > 0) {
		console.log(`Seed skipped: database already contains ${existingUsers} user(s)`);
		return;
	}

	const password = 'password123';
	const users = [];
	for (const [email, name] of [
		['admin@example.com', 'Admin User'],
		['member@example.com', 'Member User'],
		['viewer@example.com', 'Viewer User'],
		['other@example.com', 'Other User'],
	])
		users.push(
			await p.user.upsert({
				where: { email },
				update: { password },
				create: { email, name, password },
			}),
		);
	const roles = [
		WorkspaceRole.OWNER,
		WorkspaceRole.ADMIN,
		WorkspaceRole.MEMBER,
		WorkspaceRole.VIEWER,
	];
	for (let w = 0; w < 3; w++) {
		const ws = await p.workspace.upsert({
			where: { id: `seed-workspace-${w + 1}` },
			update: {},
			create: { id: `seed-workspace-${w + 1}`, name: `Workspace ${String.fromCharCode(65 + w)}` },
		});
		for (let i = 0; i < users.length; i++)
			await p.workspaceMember.upsert({
				where: { userId_workspaceId: { userId: users[i].id, workspaceId: ws.id } },
				update: { role: roles[(i + w) % roles.length] },
				create: { userId: users[i].id, workspaceId: ws.id, role: roles[(i + w) % roles.length] },
			});
		for (let j = 0; j < 40; j++) {
			const project = await p.project.upsert({
				where: { id: `seed-project-${w}-${j}` },
				update: {},
				create: {
					id: `seed-project-${w}-${j}`,
					workspaceId: ws.id,
					name: `${['Backend Platform', 'Product Knowledge', 'Internal Documentation'][j % 3]} ${j + 1}`,
					description: 'Учебный production-like проект',
					status: j % 9 === 0 ? ProjectStatus.ARCHIVED : ProjectStatus.ACTIVE,
					createdById: users[(j + w) % users.length].id,
				},
			});
			for (let k = 0; k < 30; k++)
				await p.document.upsert({
					where: { id: `seed-document-${w}-${j}-${k}` },
					update: {},
					create: {
						id: `seed-document-${w}-${j}-${k}`,
						projectId: project.id,
						authorId: users[(k + j) % users.length].id,
						title: `Document ${k + 1}: API and architecture`,
						content:
							`Учебный документ ${k + 1}. Архитектура, API, database migrations and deployment notes. `.repeat(
								(k % 4) + 1,
							),
						status: [DocumentStatus.DRAFT, DocumentStatus.ACTIVE, DocumentStatus.ARCHIVED][k % 3],
					},
				});
		}
	}
	console.log('Seed completed');
}
main().finally(() => p.$disconnect());
