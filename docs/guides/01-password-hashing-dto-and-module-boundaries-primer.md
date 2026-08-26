# Памятка к задаче 1: пароли, DTO и границы модулей

> [!tip] В двух словах
> **Снижение ущерба.** Если база утечёт, хеши усложнят восстановление паролей; DTO и модули не дадут случайным данным расползтись по системе.

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
AuthController -> AuthService -> PrismaService
ProjectController -> ProjectService -> PrismaService
```

Отдельный repository полезен не всегда. Если он лишь повторяет методы Prisma без собственной семантики, появляется лишний слой без пользы.

## Что обычно тестируют

- в БД нет исходного пароля;
- неизвестный пользователь и неверный пароль выглядят одинаково;
- extra fields не меняют служебные колонки;
- ошибочный DTO даёт `400` до вызова business operation;
- seed создаёт такие же hashes, как обычная регистрация.

## Переиспользуемый рецепт NestJS

Спрячьте bcrypt за маленьким service: tests смогут подменить его, а параметры не размазываются по auth-коду.

```ts
@Injectable()
export class PasswordService {
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
async register(dto: RegisterDto) {
	if (dto.password !== dto.passwordConfirmation) {
		throw new BadRequestException('Passwords do not match');
	}

	return this.prisma.user.create({
		data: {
			email: dto.email.trim().toLowerCase(),
			name: dto.name.trim(),
			password: await this.passwords.hash(dto.password),
		},
		select: { id: true, email: true, name: true },
	});
}
```

E2E проверяет не только response, но и сохранённое значение:

```ts
const response = await request(app.getHttpServer())
	.post('/auth/register')
	.send({ email, name: 'Test', password, passwordConfirmation: password })
	.expect(201);

const stored = await prisma.user.findUniqueOrThrow({ where: { id: response.body.id } });
expect(stored.password).not.toBe(password);
expect(await bcrypt.compare(password, stored.password)).toBe(true);
```

## Частые ошибки

- hash уже захешированного пароля при каждом seed;
- слишком маленький/огромный cost без измерения;
- логирование DTO регистрации;
- сохранение confirmation;
- выбор tenant через первый membership;
- использование compile-time interface вместо runtime validation.
