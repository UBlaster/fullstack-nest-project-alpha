import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { hash } from 'argon2';
import { createUserDto } from './dto/login.dto';

@Injectable()
export class AuthService {
	constructor(
		private prisma: PrismaService,
		private jwt: JwtService,
	) {}

	async login(dto: LoginDto) {
		const user = await this.prisma.user.findUnique({
			where: {
				email: dto.email,
			},
		});

		if (!user || user.password !== dto.password) {
			throw new UnauthorizedException('Invalid credentials');
		}

		return {
			accessToken: this.jwt.sign({
				sub: user.id,
				email: user.email,
			}),
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
			},
		};
	}

	async me(id: string) {
		return this.prisma.user.findUnique({
			where: {
				id,
			},
			select: {
				id: true,
				email: true,
				name: true,
				createdAt: true,
			},
		});
	}

	async create(dto: createUserDto) {
		if (dto.password !== dto.confirmPassword) {
			throw new BadRequestException('Passwords do not match');
		}

		const user = await this.prisma.user.create({
			data: {
				...dto,
				password: await hash(dto.password, 10),
			}
		});
	}
}
