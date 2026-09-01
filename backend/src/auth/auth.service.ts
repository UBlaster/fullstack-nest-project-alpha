import {
	BadRequestException,
	ConflictException,
	Injectable,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
	private readonly bcryptRounds: number;

	constructor(
		private readonly prisma: PrismaService,
		private readonly jwt: JwtService,
		configService: ConfigService,
	) {
		this.bcryptRounds = Number(configService.get<string>('BCRYPT_ROUNDS') ?? 12);
		if (!Number.isInteger(this.bcryptRounds) || this.bcryptRounds < 4 || this.bcryptRounds > 31) {
			throw new Error('BCRYPT_ROUNDS must be an integer between 4 and 31');
		}
	}

	async register(dto: RegisterDto) {
		if (dto.password !== dto.passwordConfirmation) {
			throw new BadRequestException('Passwords do not match');
		}

		const email = dto.email.trim().toLowerCase();
		const existingUser = await this.prisma.user.findUnique({ where: { email } });
		if (existingUser) {
			throw new ConflictException('User already exists');
		}

		return this.prisma.user.create({
			data: {
				email,
				name: dto.name.trim(),
				password: await bcrypt.hash(dto.password, this.bcryptRounds),
			},
			select: {
				id: true,
				email: true,
				name: true,
				createdAt: true,
			},
		});
	}

	async login(dto: LoginDto) {
		const email = dto.email.trim().toLowerCase();
		const user = await this.prisma.user.findUnique({ where: { email } });
		const passwordMatches = user ? await bcrypt.compare(dto.password, user.password) : false;

		if (!user || !passwordMatches) {
			throw new UnauthorizedException('Invalid credentials');
		}

		return {
			accessToken: this.jwt.sign({ sub: user.id, email: user.email }),
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
			},
		};
	}

	async me(id: string) {
		return this.prisma.user.findUnique({
			where: { id },
			select: {
				id: true,
				email: true,
				name: true,
				createdAt: true,
			},
		});
	}

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
