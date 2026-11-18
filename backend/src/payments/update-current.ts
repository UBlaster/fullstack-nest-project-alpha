import { Prisma } from '@prisma/client';

export async function updateCurrent<T>(update: Promise<T>): Promise<T | null> {
	try {
		return await update;
	} catch (error: unknown) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
			return null;
		}
		throw error;
	}
}
