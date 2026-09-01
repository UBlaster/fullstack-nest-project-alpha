# RBAC и изоляция данных в NestJS

> [!tip] Главная идея
> Authentication отвечает на вопрос «кто отправил запрос», а authorization — «что этому пользователю разрешено делать». В multi-tenant API обе проверки обязательны на каждом пути чтения и изменения данных.

Этот материал показывает полную реализацию ролевой модели доступа на самостоятельном примере:

```text
Team -> Board -> Note
```

Команда является tenant: пользователь видит данные команды только при наличии TeamMember. Роль membership определяет разрешённые действия.

## 1. Модель предметной области

В примере используются три роли:

- LEAD полностью управляет командой и её ресурсами;
- EDITOR читает команду, создаёт, изменяет и архивирует boards и notes;
- READER только читает доступные данные.

Создать новую команду может любой аутентифицированный пользователь. Создатель сразу становится LEAD.

| Ресурс и действие  | LEAD | EDITOR | READER |
| ------------------ | :--: | :----: | :----: |
| Просмотреть team   |  да  |   да   |   да   |
| Изменить team      |  да  |  нет   |  нет   |
| Архивировать team  |  да  |  нет   |  нет   |
| Удалить team       |  да  |  нет   |  нет   |
| Просмотреть board  |  да  |   да   |   да   |
| Создать board      |  да  |   да   |  нет   |
| Изменить board     |  да  |   да   |  нет   |
| Архивировать board |  да  |   да   |  нет   |
| Удалить board      |  да  |  нет   |  нет   |
| Просмотреть note   |  да  |   да   |   да   |
| Создать note       |  да  |   да   |  нет   |
| Изменить note      |  да  |   да   |  нет   |
| Архивировать note  |  да  |   да   |  нет   |
| Удалить note       |  да  |  нет   |  нет   |

Авторство board или note хранится для аудита, но не даёт дополнительных прав. Правило «редактировать только собственную запись» относится к ownership-based access и не является частью этой RBAC-модели.

## 2. Ключевые термины

- **Authentication** подтверждает личность пользователя. Обычно это делает JWT guard.
- **Authorization** проверяет разрешение на конкретное действие.
- **RBAC** связывает разрешения с ролью пользователя.
- **Tenant** — изолированная область данных одной организации или команды.
- **Membership** связывает пользователя, tenant и роль.
- **Policy** централизует правила доступа, но не выполняет бизнес-операцию.
- **Scope** — tenant, внутри которого действует membership.
- **Relation path** — путь от дочернего ресурса к tenant, например Note -> Board -> Team.
- **Outsider** — аутентифицированный пользователь без membership в проверяемом tenant.

JWT не должен содержать роль конкретной команды: один пользователь может иметь разные роли в разных teams, а membership может измениться после выдачи токена.

### Authentication и policy отвечают на разные вопросы

Policy не проверяет JWT и не определяет личность пользователя. К моменту вызова policy это уже сделал authentication guard.

```text
JWT guard: «Токен настоящий? Кто этот пользователь?»
Policy:    «Может ли этот пользователь выполнить это действие над этим ресурсом?»
```

Например, READER с валидным JWT успешно аутентифицирован. Но при попытке изменить note policy отклонит действие: пользователь известен, однако его роль не имеет permission update.

Поэтому policy получает готовый userId. Ему не нужны Request, заголовок Authorization или строка JWT.

## 3. Что такое provider в NestJS

Provider — объект, жизненным циклом которого управляет NestJS container. Чаще всего provider является service с декоратором Injectable.

```ts
@Injectable()
export class AccessPolicyService {}
```

Когда класс указан в providers модуля, Nest:

1. читает зависимости constructor;
2. создаёт или находит экземпляры этих зависимостей;
3. создаёт AccessPolicyService;
4. передаёт управляемый экземпляр потребителям.

```ts
@Module({
  providers: [AccessPolicyService],
})
export class AccessModule {}
```

Provider принадлежит модулю, который объявил его в providers. Если он нужен другому модулю, модуль-владелец экспортирует provider, а модуль-потребитель импортирует модуль-владелец.

```ts
@Module({
  providers: [AccessPolicyService],
  exports: [AccessPolicyService],
})
export class AccessModule {}

@Module({
  imports: [AccessModule],
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
```

После этого NotesService получает policy через constructor injection:

```ts
@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}
}
```

Нельзя создавать provider вручную:

```ts
const policy = new AccessPolicyService(prisma);
```

Такой объект находится вне Nest container, усложняет тестирование, может получить неправильные зависимости и обходит настройки scope и lifecycle hooks.

Короткое правило:

```text
providers: объявить владельца
exports: разрешить использовать provider снаружи
imports: подключить модуль-владелец
constructor: получить provider
```

## 4. Сначала проектируют schema и relation path

Минимальная Prisma-модель может выглядеть так:

```prisma
enum TeamRole {
  LEAD
  EDITOR
  READER
}

enum ResourceStatus {
  ACTIVE
  ARCHIVED
}

model Team {
  id        String         @id @default(cuid())
  name      String
  status    ResourceStatus @default(ACTIVE)
  members   TeamMember[]
  boards    Board[]
  createdAt DateTime       @default(now())
  updatedAt DateTime       @updatedAt
}

model TeamMember {
  id        String   @id @default(cuid())
  userId    String
  teamId    String
  role      TeamRole
  team      Team     @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@unique([userId, teamId])
}

model Board {
  id          String         @id @default(cuid())
  teamId      String
  createdById String
  name        String
  status      ResourceStatus @default(ACTIVE)
  team        Team           @relation(fields: [teamId], references: [id], onDelete: Cascade)
  notes       Note[]
}

model Note {
  id        String         @id @default(cuid())
  boardId   String
  authorId  String
  title     String
  content   String
  status    ResourceStatus @default(ACTIVE)
  board     Board          @relation(fields: [boardId], references: [id], onDelete: Cascade)
}
```

Tenant context определяется разными путями:

```text
Team:  teamId
Board: Board.teamId
Note:  Note -> Board -> teamId
```

Нельзя искать любой membership пользователя. Нужна уникальная пара userId + teamId именно проверяемого ресурса.

## 5. Миграции ролей и статусов

Добавление status с default обычно является аддитивным изменением:

```bash
npx prisma migrate dev --name add-team-status
npx prisma generate
```

Перед применением нужно прочитать migration.sql. prisma db push не заменяет versioned migration.

Удаление значения PostgreSQL enum сложнее добавления. Если старая роль MANAGER должна стать EDITOR, сначала нужно преобразовать существующие строки, а затем пересоздать enum без MANAGER. Без этого migration либо не применится, либо оставит данные, которые нельзя привести к новому типу.

Безопасный порядок:

1. определить явное соответствие MANAGER -> EDITOR;
2. создать migration в режиме create-only;
3. отредактировать SQL: переименовать старый enum, создать новый, преобразовать колонку через CASE, удалить старый enum;
4. применить migration на копии данных;
5. выполнить prisma generate.

Это изменение данных, поэтому mapping старой роли должен быть продуктовым решением, а не случайным выбором разработчика.

## 6. Матрицу прав хранят как данные

Сначала вводятся общие типы:

```ts
export type AccessAction = "view" | "create" | "update" | "archive" | "delete";
export type AccessResource = "team" | "board" | "note";
```

Затем матрица переносится в код:

```ts
import { ForbiddenException } from "@nestjs/common";
import { TeamRole } from "@prisma/client";

export const permissions: Record<
  AccessResource,
  Record<AccessAction, readonly TeamRole[]>
> = {
  team: {
    view: ["LEAD", "EDITOR", "READER"],
    create: ["LEAD", "EDITOR", "READER"],
    update: ["LEAD"],
    archive: ["LEAD"],
    delete: ["LEAD"],
  },
  board: {
    view: ["LEAD", "EDITOR", "READER"],
    create: ["LEAD", "EDITOR"],
    update: ["LEAD", "EDITOR"],
    archive: ["LEAD", "EDITOR"],
    delete: ["LEAD"],
  },
  note: {
    view: ["LEAD", "EDITOR", "READER"],
    create: ["LEAD", "EDITOR"],
    update: ["LEAD", "EDITOR"],
    archive: ["LEAD", "EDITOR"],
    delete: ["LEAD"],
  },
};

export function assertAllowed(
  role: TeamRole,
  resource: AccessResource,
  action: AccessAction,
): void {
  if (!permissions[resource][action].includes(role)) {
    throw new ForbiddenException();
  }
}
```

Действие create для team не требует существующего membership. Строка нужна для полноты модели, но создание новой team проверяется JWT guard и выполняется отдельным service method.

## 7. Единая HTTP-политика

Последовательность проверок определяет ответ:

1. JWT отсутствует или невалиден — 401.
2. Ресурс не существует — 404.
3. Ресурс существует, но membership нет — скрытый 404.
4. Membership есть, но роль не разрешает действие — 403.
5. DTO не прошёл валидацию — 400.

Скрытый 404 не позволяет outsider определить, существует ли чужой ID.

Policy не должен читать HTTP request или JWT. Controller получает аутентифицированного пользователя, feature-service передаёт userId в policy, а policy работает с идентификаторами и Prisma.

```text
Controller -> FeatureService -> AccessPolicyService -> PrismaService
                         |
                         -> business operation through PrismaService
```

### Кто и когда вызывает policy

Feature controller — обычный controller конкретной области приложения: TeamsController, BoardsController или NotesController. Он не вызывает policy напрямую. Controller извлекает данные HTTP-запроса и передаёт их feature-service:

```ts
@UseGuards(AuthGuard("jwt"))
@Controller("notes")
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Patch(":noteId")
  update(
    @Param("noteId") noteId: string,
    @Body() dto: UpdateNoteDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.notesService.update(request.user.sub, noteId, dto);
  }
}
```

Feature-service сначала вызывает policy и только после успешной проверки выполняет business operation:

```ts
@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async update(userId: string, noteId: string, dto: UpdateNoteDto) {
    await this.accessPolicy.requireNote(userId, noteId, "update");

    return this.prisma.note.update({
      where: { id: noteId },
      data: {
        title: dto.title,
        content: dto.content,
      },
    });
  }
}
```

Если policy выбросил NotFoundException или ForbiddenException, выполнение метода немедленно прекращается. Prisma update после await уже не вызывается, а Nest преобразует exception в HTTP-ответ.

Технически policy можно вызвать из controller, но тогда другой вызов feature-service — например из worker, scheduler или другого service — сможет обойти authorization. Проверка внутри feature-service защищает саму бизнес-операцию независимо от способа её вызова.

## 8. Полная реализация policy provider

### Что policy делает внутри

Policy намеренно остаётся простым. По сути это один повторяемый алгоритм:

1. найти resource и его tenant context;
2. найти membership текущего пользователя;
3. взять role из membership;
4. получить разрешённые роли из permissions[resource][action];
5. проверить includes;
6. выбросить exception при запрете;
7. вернуть resource при успехе.

Упрощённое ядро проверки выглядит так:

```ts
const membership = await prisma.teamMember.findUnique(/* userId + teamId */);

if (!membership) {
  throw new NotFoundException();
}

if (!permissions[resource][action].includes(membership.role)) {
  throw new ForbiddenException();
}
```

Ценность policy не в сложном алгоритме, а в едином поведении. Без него TeamsService, BoardsService и NotesService быстро получают похожие, но не одинаковые if-проверки.

### Как читать используемые Prisma-запросы

#### findUnique и составной уникальный ключ

findUnique ищет одну запись по полю или набору полей, которые Prisma schema объявляет уникальными.

```prisma
model TeamMember {
  userId String
  teamId String

  @@unique([userId, teamId])
}
```

Из @@unique Prisma Client генерирует имя userId_teamId:

```ts
const membership = await prisma.teamMember.findUnique({
  where: {
    userId_teamId: {
      userId,
      teamId,
    },
  },
});
```

Внешний userId_teamId — имя compound unique key. Внутренний объект содержит значения обеих колонок.

Короткая запись userId означает userId: userId. Аналогично teamId означает teamId: teamId:

```ts
{
  userId_teamId: {
    userId: userId,
    teamId: teamId,
  },
}
```

Такой запрос означает: «найди membership именно этого пользователя именно в этой team». Поиск только по userId был бы ошибкой: пользователь может состоять в другой team.

#### select выбирает конкретные поля

select сообщает Prisma, какие поля вернуть:

```ts
select: {
  teamId: true,
}
```

Результат будет содержать teamId, но не остальные поля модели. Это уменьшает объём данных и явно показывает, что для authorization нужен только tenant ID.

Нельзя одновременно использовать select и include на одном уровне query. Но select можно вложить внутрь include для relation.

#### include загружает relation

По умолчанию Prisma возвращает scalar fields текущей модели, но не загружает связанные модели. include просит добавить relation к результату:

```ts
include: {
  board: {
    select: {
      teamId: true,
    },
  },
}
```

Здесь Prisma:

1. находит Note;
2. загружает связанную Board;
3. из Board возвращает только teamId.

После запроса доступен путь:

```ts
note.board.teamId;
```

Это и есть реализация relation path Note -> Board -> Team context. Загружать всю Board не требуется, потому что policy нужен только teamId.

#### Вложенный where фильтрует через relations

Такой фильтр:

```ts
where: {
  team: {
    members: {
      some: {
        userId,
      },
    },
  },
}
```

читается изнутри наружу:

```text
существует member с этим userId
-> в связанной team
-> значит board входит в доступный scope
```

team — relation Board -> Team. members — relation Team -> TeamMember[].

some означает «существует хотя бы одна связанная запись, подходящая условию». На уровне SQL это близко к EXISTS.

У relation list также бывают:

- none — ни одна связанная запись не подходит;
- every — каждая связанная запись подходит.

Для изоляции list обычно нужен some: вернуть только resources тех teams, где существует membership текущего пользователя.

Prisma выполняет фильтрацию в базе данных. Не нужно сначала загружать все boards, а затем отбрасывать чужие через Array.filter в JavaScript.

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AccessAction, AccessResource, assertAllowed } from "./permissions";

@Injectable()
export class AccessPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireMembership(
    userId: string,
    teamId: string,
    resource: AccessResource,
    action: AccessAction,
  ) {
    const membership = await this.prisma.teamMember.findUnique({
      where: {
        userId_teamId: { userId, teamId },
      },
    });

    if (!membership) {
      throw new NotFoundException();
    }

    assertAllowed(membership.role, resource, action);
    return membership;
  }

  async requireTeam(
    userId: string,
    teamId: string,
    action: AccessAction,
    resource: AccessResource = "team",
  ) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundException();
    }

    await this.requireMembership(userId, team.id, resource, action);
    return team;
  }

  async requireBoard(
    userId: string,
    boardId: string,
    action: AccessAction,
    resource: AccessResource = "board",
  ) {
    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
    });

    if (!board) {
      throw new NotFoundException();
    }

    await this.requireMembership(userId, board.teamId, resource, action);
    return board;
  }

  async requireNote(userId: string, noteId: string, action: AccessAction) {
    const note = await this.prisma.note.findUnique({
      where: { id: noteId },
      include: {
        board: {
          select: { teamId: true },
        },
      },
    });

    if (!note) {
      throw new NotFoundException();
    }

    await this.requireMembership(userId, note.board.teamId, "note", action);
    return note;
  }
}
```

Параметр resource у requireTeam и requireBoard позволяет проверить действие дочернего ресурса, когда известен только parent ID. Например, создание note через board проверяет note/create, а не board/create.

AccessModule становится владельцем provider:

```ts
@Module({
  providers: [AccessPolicyService],
  exports: [AccessPolicyService],
})
export class AccessModule {}
```

## 9. Team: корневой vertical slice

Создание team не вызывает membership policy, потому что проверяемого membership ещё нет. JWT guard уже подтвердил пользователя, а nested write создаёт tenant и LEAD membership атомарно.

```ts
async create(userId: string, dto: CreateTeamDto) {
  return this.prisma.team.create({
    data: {
      name: dto.name,
      members: {
        create: {
          userId,
          role: 'LEAD',
        },
      },
    },
  });
}
```

Список сразу ограничивается доступным scope:

```ts
async list(userId: string) {
  return this.prisma.team.findMany({
    where: {
      members: { some: { userId } },
    },
    orderBy: { updatedAt: 'desc' },
  });
}
```

Операции по ID используют policy:

```ts
async update(userId: string, teamId: string, dto: UpdateTeamDto) {
  await this.accessPolicy.requireTeam(userId, teamId, 'update');
  return this.prisma.team.update({
    where: { id: teamId },
    data: { name: dto.name },
  });
}

async archive(userId: string, teamId: string) {
  await this.accessPolicy.requireTeam(userId, teamId, 'archive');
  return this.prisma.team.update({
    where: { id: teamId },
    data: { status: 'ARCHIVED' },
  });
}
```

## 10. Board: доступ через parent tenant

Для вложенного create teamId берётся из URL, а createdById — из JWT:

```ts
async create(userId: string, teamId: string, dto: CreateBoardDto) {
  await this.accessPolicy.requireTeam(userId, teamId, 'create', 'board');

  return this.prisma.board.create({
    data: {
      name: dto.name,
      teamId,
      createdById: userId,
    },
  });
}
```

Get, update, archive и delete board используют requireBoard с соответствующим action.

Глобальный список boards сразу ограничивается memberships:

```ts
return this.prisma.board.findMany({
  where: {
    team: {
      members: { some: { userId } },
    },
  },
});
```

Список конкретной team проверяет board/view через team context, затем выполняет findMany по teamId. Так проверяется permission запрашиваемого resource, даже если parent ID принадлежит другому типу.

## 11. Note: relation path и mass assignment

DTO перечисляет только клиентские поля:

```ts
export class CreateNoteDto {
  @IsString()
  @Length(1, 160)
  title!: string;

  @IsString()
  content!: string;
}

export class UpdateNoteDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;
}
```

При create нельзя передавать весь DTO через spread вместе с relation IDs:

```ts
async create(userId: string, boardId: string, dto: CreateNoteDto) {
  await this.accessPolicy.requireBoard(userId, boardId, 'create', 'note');

  return this.prisma.note.create({
    data: {
      title: dto.title,
      content: dto.content,
      boardId,
      authorId: userId,
    },
  });
}
```

Для note по ID policy проходит полный relation path Note -> Board -> teamId. После успешной проверки feature-service выполняет get/update/archive/delete.

## 12. ValidationPipe и неизвестные поля

При такой конфигурации:

```ts
new ValidationPipe({
  whitelist: true,
  transform: true,
});
```

поля без validation decorators удаляются из DTO. Они не вызывают 400.

Опция forbidNonWhitelisted: true меняет публичный контракт: вместо удаления лишнего поля клиент получает 400. Её нельзя включать незаметно, не проверив реальные payloads всех клиентов.

Даже при whitelist feature-service должен собирать Prisma data явно. DTO определяет HTTP-контракт, а explicit input защищает persistence boundary.

Для update DTO со всеми optional-полями нужна отдельная проверка пустого изменения. Иначе PATCH с пустым body может вернуть успешный ответ, ничего не изменив.

## 13. Архивирование как отдельная операция

Обычный PATCH не принимает status. Для архивации используется отдельный endpoint и отдельное permission:

```ts
@Patch(':noteId/archive')
archive(
  @Param('noteId') noteId: string,
  @Req() request: AuthenticatedRequest,
) {
  return this.notesService.archive(request.user.sub, noteId);
}
```

Простая и предсказуемая семантика:

- archive идемпотентно выставляет ARCHIVED;
- повторный archive возвращает ресурс со статусом ARCHIVED;
- archived resources остаются видимыми;
- archive parent не меняет статусы children;
- update и delete не блокируются статусом;
- unarchive является отдельной будущей возможностью.

Если продукт требует запретить изменение archived resource или каскадно архивировать children, это state policy, которую нужно проектировать отдельно от RBAC.

## 14. Controller и типизированный пользователь

JWT guard лучше применять на уровне controller, если защищены все handlers:

```ts
@UseGuards(AuthGuard("jwt"))
@Controller("notes")
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get(":noteId")
  get(@Param("noteId") noteId: string, @Req() request: AuthenticatedRequest) {
    return this.notesService.get(request.user.sub, noteId);
  }
}
```

Controller не запрашивает TeamMember и не интерпретирует роли. Он передаёт идентификаторы в feature-service.

## 15. Seed и тестовые акторы

Для ручной проверки удобно иметь пять пользователей:

- lead@example.com — LEAD основной team;
- editor@example.com — EDITOR;
- reader@example.com — READER;
- outsider@example.com — не состоит в основной team;
- second-lead@example.com — LEAD другой team.

Outsider не должен быть автором ресурсов команды, к которой у него нет membership: это технически возможно при неаккуратном seed, но делает учебный сценарий непонятным.

E2e не должны зависеть от seed. Тест самостоятельно создаёт изолированные fixtures, получает JWT и удаляет свои данные после выполнения.

Минимальные группы тестов:

1. 401 для запроса без JWT.
2. LEAD выполняет все действия.
3. EDITOR создаёт, изменяет и архивирует child resources, но не управляет team и не удаляет children.
4. READER читает, но получает 403 на mutation.
5. Outsider получает 404 по чужим IDs.
6. Lists не содержат чужие данные.
7. Relation IDs и author IDs из body не меняют scope.
8. Обычный PATCH не меняет status.
9. Пустой PATCH возвращает 400.
10. Response проверяется по содержимому, а не только по status code.

## 16. Рекомендуемый порядок реализации

### Срез 1. Контракты

- выписать существующие routes и response shapes;
- определить tenant и relation paths;
- зафиксировать permission matrix;
- проверить реальные frontend payloads.

Checkpoint: для каждого endpoint понятно, откуда берутся userId и parent ID.

### Срез 2. Schema

- добавить или скорректировать role enum;
- добавить status;
- создать и прочитать migration;
- сгенерировать Prisma Client.

Checkpoint: schema валидируется, приложение компилируется.

### Срез 3. Access provider

- создать permissions;
- создать policy;
- объявить и экспортировать provider;
- импортировать AccessModule в один feature module.

Checkpoint: Nest успешно создаёт feature-service через DI.

### Срез 4. Корневой tenant

- реализовать create/list;
- добавить get/update/archive/delete через policy;
- проверить LEAD, READER и outsider.

Checkpoint: creator получает LEAD, outsider получает 404.

### Срез 5. Дочерние ресурсы

- подключить board;
- затем перенести тот же pattern на note;
- заменить spread на explicit Prisma input;
- проверить relation path.

Checkpoint: body не может изменить tenant, parent или автора.

### Срез 6. Доказательство

- создать изолированные e2e fixtures;
- проверить всю matrix;
- проверить list isolation и response shapes;
- обновить API documentation.

Checkpoint: полный test suite проходит независимо от seed.

## 17. Частые проблемы

- Nest не может разрешить AccessPolicyService: проверить providers, exports и imports.
- Provider объявлен сразу в нескольких feature modules: выбрать один модуль-владелец.
- Используется new AccessPolicyService: заменить ручное создание constructor injection.
- Outsider получает 403 вместо 404: membership отсутствует, поэтому hidden 404 должен формироваться до role check.
- Чужие записи видны в list: ограничить Prisma query, а не фильтровать результат в JavaScript.
- Note проверяется не в той team: загрузить board.teamId через relation.
- Create проверяет permission неправильного resource: передавать note/create, даже если scope найден через board.
- PATCH меняет foreign key или author: убрать поле из DTO и собирать Prisma data явно.
- Пустой PATCH возвращает 200: добавить проверку хотя бы одного изменяемого поля.
- После migration TypeScript не видит enum: выполнить prisma generate и перезапустить watcher.
- E2e работает только после seed: заменить seed-зависимость собственными fixtures.

## 18. Самопроверка

Перед завершением ответьте на вопросы:

- Где проходит tenant boundary?
- Какой relation path ведёт от каждого ресурса к tenant?
- Почему outsider получает 404, а READER на mutation — 403?
- Кто владеет AccessPolicyService и какие модули его импортируют?
- Почему создание tenant не проверяет membership?
- Какие IDs приходят из URL, JWT и body?
- Почему whitelist не заменяет explicit Prisma input?
- Какие response shapes уже используют клиенты?

RBAC считается реализованным не тогда, когда появился один guard, а когда все пути чтения и изменения применяют одну матрицу, сохраняют tenant isolation и подтверждены тестами.
