import { DocumentStatus, PrismaClient, ProjectStatus, WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const seedPassword = 'password123';
const seedUsers = [
	['admin@example.com', 'Admin User'],
	['member@example.com', 'Member User'],
	['viewer@example.com', 'Viewer User'],
	['other@example.com', 'Other User'],
] as const;

export async function seedDatabase(prisma: PrismaClient) {
	const existingUsers = await prisma.user.count();
	const bcryptRounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
	if (!Number.isInteger(bcryptRounds) || bcryptRounds < 4 || bcryptRounds > 31) {
		throw new Error('BCRYPT_ROUNDS must be an integer between 4 and 31');
	}

	const existingSeedUsers = await prisma.user.findMany({
		where: { email: { in: seedUsers.map(([email]) => email) } },
		select: { id: true, password: true },
	});
	const usersWithInvalidPasswords = (
		await Promise.all(
			existingSeedUsers.map(async (user) => ({
				id: user.id,
				passwordMatches: await bcrypt.compare(seedPassword, user.password).catch(() => false),
			})),
		)
	).filter((user) => !user.passwordMatches);

	if (usersWithInvalidPasswords.length > 0) {
		const passwordHash = await bcrypt.hash(seedPassword, bcryptRounds);
		await prisma.user.updateMany({
			where: { id: { in: usersWithInvalidPasswords.map(({ id }) => id) } },
			data: { password: passwordHash },
		});
		console.log(`Seed repaired ${usersWithInvalidPasswords.length} demo user password(s)`);
	}

	if (existingUsers > 0) {
		console.log(`Seed skipped: database already contains ${existingUsers} user(s)`);
		return;
	}

	const passwordHash = await bcrypt.hash(seedPassword, bcryptRounds);
	const users = [];

	for (const [email, name] of seedUsers) {
		users.push(
			await prisma.user.upsert({
				where: {
					email,
				},
				update: {
					password: passwordHash,
				},
				create: {
					email,
					name,
					password: passwordHash,
				},
			}),
		);
	}

	const roles = [
		WorkspaceRole.OWNER,
		WorkspaceRole.ADMIN,
		WorkspaceRole.MEMBER,
		WorkspaceRole.VIEWER,
	];

	for (let workspaceIndex = 0; workspaceIndex < 3; workspaceIndex++) {
		const workspace = await prisma.workspace.upsert({
			where: {
				id: `seed-workspace-${workspaceIndex + 1}`,
			},
			update: {},
			create: {
				id: `seed-workspace-${workspaceIndex + 1}`,
				name: `Workspace ${String.fromCharCode(65 + workspaceIndex)}`,
			},
		});

		for (let userIndex = 0; userIndex < users.length; userIndex++) {
			await prisma.workspaceMember.upsert({
				where: {
					userId_workspaceId: {
						userId: users[userIndex].id,
						workspaceId: workspace.id,
					},
				},
				update: {
					role: roles[(userIndex + workspaceIndex) % roles.length],
				},
				create: {
					userId: users[userIndex].id,
					workspaceId: workspace.id,
					role: roles[(userIndex + workspaceIndex) % roles.length],
				},
			});
		}

		for (let projectIndex = 0; projectIndex < 40; projectIndex++) {
			const project = await prisma.project.upsert({
				where: {
					id: `seed-project-${workspaceIndex}-${projectIndex}`,
				},
				update: {},
				create: {
					id: `seed-project-${workspaceIndex}-${projectIndex}`,
					workspaceId: workspace.id,
					name: `${['Backend Platform', 'Product Knowledge', 'Internal Documentation'][projectIndex % 3]} ${projectIndex + 1}`,
					description: 'Учебный production-like проект',
					status: projectIndex % 9 === 0 ? ProjectStatus.ARCHIVED : ProjectStatus.ACTIVE,
					createdById: users[(projectIndex + workspaceIndex) % users.length].id,
				},
			});

			for (let documentIndex = 0; documentIndex < 30; documentIndex++) {
				await prisma.document.upsert({
					where: {
						id: `seed-document-${workspaceIndex}-${projectIndex}-${documentIndex}`,
					},
					update: {},
					create: {
						id: `seed-document-${workspaceIndex}-${projectIndex}-${documentIndex}`,
						projectId: project.id,
						authorId: users[(documentIndex + projectIndex) % users.length].id,
						title: `Document ${documentIndex + 1}: API and architecture`,
						content:
							`Учебный документ ${documentIndex + 1}. Архитектура, API, database migrations and deployment notes. `.repeat(
								(documentIndex % 4) + 1,
							),
						status: [DocumentStatus.DRAFT, DocumentStatus.ACTIVE, DocumentStatus.ARCHIVED][
							documentIndex % 3
						],
					},
				});
			}
		}
	}

	console.log('Seed completed');
}

async function main() {
	const prisma = new PrismaClient();
	try {
		await seedDatabase(prisma);
	} finally {
		await prisma.$disconnect();
	}
}

if (require.main === module) {
	void main();
}
