import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

@Injectable()
export class AccountService {
	constructor(private readonly prisma: PrismaService) {}

	async deleteAccount(userId: string, dto: DeleteAccountDto) {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: {
				id: true,
				password: true,
				_count: { select: { projects: true, documents: true } },
			},
		});

		if (!user || !(await bcrypt.compare(dto.currentPassword, user.password))) {
			throw new UnauthorizedException('Invalid credentials');
		}

		if (user._count.projects > 0 || user._count.documents > 0) {
			throw new ConflictException('Account owns projects or documents');
		}

		await this.prisma.$transaction([
			this.prisma.workspaceMember.deleteMany({ where: { userId } }),
			this.prisma.user.delete({ where: { id: userId } }),
		]);

		return { message: 'Account deleted successfully' };
	}
}
