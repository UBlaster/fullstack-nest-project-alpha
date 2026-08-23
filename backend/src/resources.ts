import {
	Body,
	Controller,
	Delete,
	Get,
	Injectable,
	Param,
	Patch,
	Post,
	Req,
	UseGuards,
	NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from './prisma.service';

@Injectable()
export class ProjectsService {
	constructor(private prisma: PrismaService) {}
	private async ensureProjectAccess(id: string, userId: string) {
		const project = await this.prisma.project.findUnique({ where: { id } });
		if (!project) throw new NotFoundException();
		const membership = await this.prisma.workspaceMember.findUnique({
			where: { userId_workspaceId: { userId, workspaceId: project.workspaceId } },
		});
		if (!membership) throw new NotFoundException();
		return project;
	}

	async list(userId: string) {
		return this.prisma.project.findMany({
			where: { workspace: { members: { some: { userId } } } },
			include: { _count: { select: { documents: true } }, createdBy: { select: { name: true } } },
			orderBy: { updatedAt: 'desc' },
		});
	}

	async get(id: string, userId: string) {
		const project = await this.ensureProjectAccess(id, userId);
		return this.prisma.project.findUnique({
			where: { id: project.id },
			include: {
				documents: {
					include: { author: { select: { name: true } } },
					orderBy: { updatedAt: 'desc' },
				},
			},
		});
	}

	async create(userId: string, data: any) {
		const membership = await this.prisma.workspaceMember.findFirst({ where: { userId } });
		if (!membership) throw new NotFoundException();
		return this.prisma.project.create({
			data: { ...data, workspaceId: membership.workspaceId, createdById: userId },
		});
	}

	async update(id: string, userId: string, data: any) {
		await this.ensureProjectAccess(id, userId);
		return this.prisma.project.update({ where: { id }, data });
	}

	async remove(id: string, userId: string) {
		await this.ensureProjectAccess(id, userId);
		return this.prisma.project.delete({ where: { id } });
	}
}

@Controller('projects')
export class ProjectsController {
	constructor(private projectsService: ProjectsService) {}
	@UseGuards(AuthGuard('jwt'))
	@Get()
	list(@Req() request: any) {
		return this.projectsService.list(request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Get(':id')
	get(@Param('id') id: string, @Req() request: any) {
		return this.projectsService.get(id, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Post()
	create(@Body() data: any, @Req() request: any) {
		return this.projectsService.create(request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch(':id')
	update(@Param('id') id: string, @Body() data: any, @Req() request: any) {
		return this.projectsService.update(id, request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete(':id')
	remove(@Param('id') id: string, @Req() request: any) {
		return this.projectsService.remove(id, request.user.sub);
	}
}

@Injectable()
export class DocumentsService {
	constructor(private prisma: PrismaService) {}

	private async ensureDocumentAccess(id: string, userId: string) {
		const document = await this.prisma.document.findUnique({
			where: { id },
			include: { project: true },
		});

		if (!document) throw new NotFoundException();

		const membership = await this.prisma.workspaceMember.findUnique({
			where: {
				userId_workspaceId: { userId, workspaceId: document.project.workspaceId },
			},
		});

		if (!membership) throw new NotFoundException();

		return document;
	}

	async list(projectId: string, userId: string) {
		const project = await this.prisma.project.findUnique({ where: { id: projectId } });

		if (!project) throw new NotFoundException();

		await new ProjectsService(this.prisma)['ensureProjectAccess'](projectId, userId);
		return this.prisma.document.findMany({
			where: { projectId },
			include: { author: { select: { name: true } } },
			orderBy: { updatedAt: 'desc' },
		});
	}

	async get(id: string, userId: string) {
		await this.ensureDocumentAccess(id, userId);
		return this.prisma.document.findUnique({
			where: { id },
			include: { author: { select: { name: true } }, project: true },
		});
	}

	async create(projectId: string, userId: string, data: any) {
		await new ProjectsService(this.prisma)['ensureProjectAccess'](projectId, userId);
		return this.prisma.document.create({ data: { ...data, projectId, authorId: userId } });
	}

	async update(id: string, userId: string, data: any) {
		await this.ensureDocumentAccess(id, userId);
		return this.prisma.document.update({ where: { id }, data });
	}

	async remove(id: string, userId: string) {
		await this.ensureDocumentAccess(id, userId);
		return this.prisma.document.delete({ where: { id } });
	}
}

@Controller()
export class DocumentsController {
	constructor(private documentsService: DocumentsService) {}

	@UseGuards(AuthGuard('jwt'))
	@Get('projects/:projectId/documents')
	list(@Param('projectId') projectId: string, @Req() request: any) {
		return this.documentsService.list(projectId, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Get('documents/:id')
	get(@Param('id') id: string, @Req() request: any) {
		return this.documentsService.get(id, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Post('projects/:projectId/documents')
	create(@Param('projectId') projectId: string, @Body() data: any, @Req() request: any) {
		return this.documentsService.create(projectId, request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch('documents/:id')
	update(@Param('id') id: string, @Body() data: any, @Req() request: any) {
		return this.documentsService.update(id, request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete('documents/:id')
	remove(@Param('id') id: string, @Req() request: any) {
		return this.documentsService.remove(id, request.user.sub);
	}
}
