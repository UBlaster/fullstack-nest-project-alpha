import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class RegistrationService {
	private readonly bcryptRounds: number;

	constructor(
		private readonly prisma: PrismaService,
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
}
