# Памятка к задаче 1: пароли, DTO и границы модулей

> [!tip] В двух словах
> **Снижение ущерба.** Если база утечёт, хеши усложнят восстановление паролей; DTO и модули не дадут случайным данным расползтись по системе.

## Контекст учебного примера

В примере сервис подписок создаёт `CustomerAccount`, а модуль каталога управляет `CatalogItem`. Названия намеренно отличаются от Workspace Docs; переиспользуется сам подход NestJS -> DTO -> service -> Prisma.

## Ключевые термины

- **Hash пароля** — необратимое представление пароля, с которым bcrypt сравнивает введённое значение.
- **Salt** — случайная добавка, из-за которой одинаковые пароли получают разные hashes.
- **Cost/rounds** — параметр bcrypt, определяющий вычислительную стоимость одного hash.
- **Runtime validation** — проверка данных во время работы приложения, когда TypeScript-типы уже недоступны.
- **Dependency Injection** — механизм NestJS, который создаёт service и передаёт его зависимым классам.
- **Seed** — повторяемое заполнение БД начальными учебными данными.
- **Telemetry** — технические logs, traces и metrics, используемые для диагностики работы приложения.

## Почему пароль не шифруют

Шифрование можно расшифровать ключом. Для проверки пароля исходное значение не нужно, поэтому хранится медленный salted hash. При входе библиотека извлекает параметры из hash и проверяет кандидат.

```text
registration: password -> bcrypt(password, random salt) -> hash in DB
login:        candidate + stored hash -> bcrypt.compare -> true/false
```

Одинаковые пароли получают разные hashes из-за salt. Медленный алгоритм делает перебор дороже. Обычный SHA-256 не подходит: он слишком быстрый.

## Зачем одинаковая ошибка login

Ответы «email не найден» и «пароль неверен» позволяют перебирать зарегистрированные адреса. Поэтому оба случая возвращают одинаковый `401`, а подробность остаётся только в безопасной telemetry.

## DTO — граница доверия

Клиент контролирует JSON. TypeScript type исчезает во время выполнения, а DTO с class-validator реально проверяет значение.

> [!note] Аналогия для frontend
>
> - **React:** DTO похож на Zod-схему, подключённую к React Hook Form: данные проверяются до передачи в business logic.
> - **Vue:** DTO похож на Zod-схему, подключённую к VeeValidate: компонент не доверяет произвольному объекту формы.
> - **Backend:** проверка обязательна повторно, потому что HTTP-клиент может полностью обойти frontend.

```ts
class CreateProfileDto {
	@IsString()
	@Length(2, 80)
	displayName!: string;
}
```

Даже после validation не стоит делать `data: { ...dto }`, если рядом есть служебные поля. Безопаснее явно перечислить разрешённое:

```ts
data: { displayName: dto.displayName, ownerId: currentUserId }
```

`passwordConfirmation` существует только на входной границе. Это проверка пользовательской ошибки, а не часть domain model.

## Зачем разделять Nest-модули

Controller отвечает за HTTP, service — за сценарий, PrismaService — за доступ к БД. Когда login, project CRUD и DTO лежат в одном файле, изменение одной функции затрагивает слишком большой контекст.

```text
AccountController -> AccountService -> PrismaService
CatalogController -> CatalogService -> PrismaService
```

Отдельный repository полезен не всегда. Если он лишь повторяет методы Prisma без собственной семантики, появляется лишний слой без пользы.

## Переиспользуемый рецепт NestJS

Входной DTO существует в runtime и проверяет оба пароля:

```ts
export class SignUpDto {
	@IsEmail()
	email!: string;

	@IsString()
	@Length(2, 80)
	displayName!: string;

	@IsString()
	@Length(8, 72)
	password!: string;

	@IsString()
	passwordConfirmation!: string;
}
```

DTO другой feature не принимает owner/service fields:

```ts
export class CreateCatalogItemDto {
	@IsString()
	@Length(1, 120)
	label!: string;

	@IsOptional()
	@IsString()
	@MaxLength(1000)
	details?: string;
}
```

Спрячьте bcrypt за маленьким service: реализацию можно заменить отдельно, а параметры не размазываются по auth-коду.

```ts
@Injectable()
export class CredentialService {
	private readonly rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);

	hash(password: string): Promise<string> {
		return bcrypt.hash(password, this.rounds);
	}

	verify(password: string, hash: string): Promise<boolean> {
		return bcrypt.compare(password, hash);
	}
}
```

Registration явно формирует DB input:

```ts
async signUp(dto: SignUpDto) {
	if (dto.password !== dto.passwordConfirmation) {
		throw new BadRequestException('Passwords do not match');
	}

	return this.prisma.customerAccount.create({
		data: {
			loginEmail: dto.email.trim().toLowerCase(),
			displayName: dto.displayName.trim(),
			credentialHash: await this.credentials.hash(dto.password),
		},
		select: { id: true, loginEmail: true, displayName: true },
	});
}
```

## Частые ошибки

- hash уже захешированного пароля при каждом seed;
- слишком маленький/огромный cost без измерения;
- логирование DTO регистрации;
- сохранение confirmation;
- выбор tenant через первый membership;
- использование compile-time interface вместо runtime validation.
