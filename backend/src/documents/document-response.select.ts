import { Prisma } from '@prisma/client';

export const documentResponseSelect = {
	id: true,
	projectId: true,
	authorId: true,
	title: true,
	body: true,
	status: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.DocumentSelect;
