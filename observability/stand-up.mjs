import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";
import console from "node:console";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

const action = process.argv[2];
const task9 = action === "task9";
const database = task9 ? "task9_observability_test" : "task10_pipeline_test";
const target = "voyage-4-v1";
const base = [
	"compose",
	"-p",
	"nest-fullstack-project",
	"-f",
	"docker-compose.yml",
	"-f",
	task9 ? "observability/compose.test.yml" : "observability/compose.task10.yml",
];
const mixed = [...base, "-f", "observability/compose.voyage.yml"];
const services = [
	"backend",
	"worker",
	"frontend",
	"redis",
	"otel-collector",
	"jaeger",
	"prometheus",
	"grafana",
];
const psql = [
	"exec",
	"-T",
	"postgres",
	"sh",
	"-ec",
	'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"',
	"stand-up",
];

function docker(
	files,
	args,
	{
		input,
		capture = false,
		providerDiagnostic = false,
		timeout = 600_000,
		message = "Docker Compose command failed",
	} = {},
) {
	const result = spawnSync("docker", [...files, ...args], {
		input,
		encoding: "utf8",
		timeout,
		stdio: [
			input ? "pipe" : "ignore",
			capture ? "pipe" : "inherit",
			capture ? "ignore" : "inherit",
		],
	});
	if (result.status !== 0) {
		let httpStatus;
		if (providerDiagnostic) {
			try {
				const diagnostic = JSON.parse(
					result.stdout.trim().split(/\r?\n/).at(-1),
				);
				const status = diagnostic.httpStatus;
				if (
					diagnostic.error === "EMBEDDING_ROLLOUT_FAILED" &&
					Number.isInteger(status) &&
					status >= 400 &&
					status <= 599
				)
					httpStatus = status;
			} catch {
				/* Ignore unknown output. Provider messages can contain document data. */
			}
		}
		const error = new Error(
			message + (httpStatus ? " Provider HTTP " + httpStatus + "." : ""),
		);
		error.httpStatus = httpStatus;
		throw error;
	}
	return capture ? result.stdout.trim() : "";
}

function prepareDatabase() {
	// POSTGRES_DB only initializes a new volume. Add the selected test database to
	// this cluster; the fixed names come from the operator's selected mode.
	docker(base, [...psql, "postgres"], {
		input:
			"SELECT format('CREATE DATABASE %I', '" +
			database +
			"')\n" +
			"WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='" +
			database +
			"')\n\\gexec\n",
	});
}

function policy() {
	const result = docker(base, [...psql, database], {
		capture: true,
		input:
			"SELECT to_regclass('public.\"EmbeddingReadConfig\"') IS NOT NULL AS has_policy \\gset\n" +
			"\\if :has_policy\n" +
			`SELECT json_build_object('read',"embeddingVersion",'writes',"writeVersions") FROM "EmbeddingReadConfig" WHERE id='default';\n` +
			"\\endif\n",
	});
	const state = result ? JSON.parse(result) : { read: "v1", writes: ["v1"] };
	if (
		!Array.isArray(state.writes) ||
		!state.writes.includes(state.read) ||
		!state.writes.every((version) => ["v1", "v2", target].includes(version))
	)
		throw new Error(
			"Unrecognized stored embedding policy. The API and worker configuration was preserved.",
		);
	return state;
}

function preflight() {
	// Required-variable interpolation uses the normal shell/.env rules. --quiet
	// validates presence without rendering the resolved key or other credentials.
	docker(mixed, ["config", "--quiet"], {
		capture: true,
		message:
			"Set VOYAGE_API_KEY in the shell or the project .env to use Voyage. No service was reconfigured.",
	});
}

function up(files, { onlyApplication = false, rebuild = true } = {}) {
	docker(files, [
		"up",
		"-d",
		rebuild ? "--build" : "--no-build",
		"--wait",
		"--wait-timeout",
		"240",
		...(onlyApplication ? ["--no-deps", "backend", "worker"] : services),
	]);
}

function task10Runtime() {
	try {
		docker(
			base,
			[
				"exec",
				"-T",
				"backend",
				"node",
				"-e",
				"process.exit(new URL(process.env.DATABASE_URL).pathname==='/task10_pipeline_test' && process.env.PIPELINE_QUEUE_NAME==='task10-pipeline-stages' && process.env.EXPORT_QUEUE_NAME==='task10-exports' && require('node:fs').existsSync('dist/src/embeddings/rollout.js') ? 0 : 1)",
			],
			{ capture: true },
		);
		return true;
	} catch {
		return false;
	}
}

function rollout(command, version, admin = false) {
	const overrides = admin
		? [
				"-e",
				"EMBEDDING_PROVIDER=fake",
				"-e",
				"EMBEDDING_VERSION=v1",
				"-e",
				"EMBEDDING_NEXT_VERSION=",
				"-e",
				"VOYAGE_API_KEY=",
			]
		: [];
	const out = docker(
		base,
		[
			"exec",
			"-T",
			...overrides,
			"backend",
			"node",
			"dist/src/embeddings/rollout.js",
			command,
			version,
		],
		{
			capture: true,
			timeout: command === "backfill" ? 3_600_000 : 120_000,
			providerDiagnostic: true,
			message: "Embedding rollout failed at " + command + " " + version + ".",
		},
	);
	try {
		return JSON.parse(out.split(/\r?\n/).at(-1));
	} catch {
		throw new Error("Invalid rollout receipt for " + command + ".");
	}
}

function rollback() {
	const stored = policy();
	const retired = stored.writes.filter((version) => version !== "v1");
	if (!retired.length) return;
	if (!task10Runtime()) {
		// start reuses the existing container's configuration, even after the
		// operator removed the key from .env. No calls use Voyage in this admin CLI.
		docker(base, ["start", "backend"], {
			capture: true,
			message:
				"Start the existing Task 10 backend to roll back its database policy.",
		});
		if (!task10Runtime())
			throw new Error(
				"Rollback needs the existing Task 10 backend with its compiled CLI.",
			);
	}
	if (!stored.writes.includes("v1")) rollout("dual-write", "v1", true);
	rollout("backfill", "v1", true);
	rollout("switch", "v1", true);
	for (const version of retired) rollout("retire", version, true);
}

async function voyageCall(command) {
	for (let attempt = 1; ; attempt++) {
		try {
			return rollout(command, target);
		} catch (error) {
			if (error.httpStatus !== 429 || attempt >= 3) throw error;
			console.log(
				"Voyage " +
					command +
					" received HTTP 429. Waiting 61 seconds before attempt " +
					(attempt + 1) +
					"/3.",
			);
			await delay(61_000);
		}
	}
}

async function voyage(stored) {
	if (stored.writes.includes("v2"))
		throw new Error(
			"Return the fixture database to v1 with node observability/stand-up.mjs rollback.",
		);
	const running = docker(base, ["ps", "--status", "running", "--services"], {
		capture: true,
	}).split(/\r?\n/);
	let hasImage = task10Runtime();
	const ready =
		hasImage && services.every((service) => running.includes(service));
	try {
		up(mixed, { onlyApplication: ready });
		hasImage = true;
		const probe = await voyageCall("probe");
		if (
			probe.provider !== "voyage" ||
			probe.model !== "voyage-4" ||
			probe.dimension !== 1024 ||
			probe.documentCount !== 1 ||
			probe.queryCount !== 1
		)
			throw new Error("Voyage probe did not confirm the expected profile.");
		console.log(
			"Voyage probe passed for one document and one query, dimension 1024.",
		);
		if (!stored.writes.includes("v1")) rollout("dual-write", "v1");
		rollout("backfill", "v1");
		rollout("dual-write", target);
		await voyageCall("backfill");
		const coverage = rollout("coverage", target);
		if (!Number.isInteger(coverage.total) || coverage.total !== coverage.ready)
			throw new Error("Voyage coverage is incomplete.");
		console.log(
			"Coverage before read switch: " +
				coverage.ready +
				"/" +
				coverage.total +
				" chunks.",
		);
		rollout("switch", target);
		docker(
			base,
			["exec", "-T", "backend", "node", "test/task10-voyage-check.mjs"],
			{ message: "Voyage verification failed." },
		);
		console.log(
			"Voyage active: " + target + ", model voyage-4, dimension 1024.",
		);
	} catch (error) {
		try {
			rollback();
			up(base, { onlyApplication: hasImage, rebuild: !hasImage });
		} catch {
			throw new Error(
				error.message +
					" Automatic recovery did not finish. Run node observability/stand-up.mjs rollback.",
			);
		}
		throw error;
	}
}

async function withOperatorLock(run) {
	// Shared by starts, fake acceptance and model promotions. Closing stdin (also
	// on host process termination) closes psql's session and releases the lock.
	const child = spawn("docker", [...base, ...psql, "postgres"], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	const lines = createInterface({ input: child.stdout });
	let timer;
	try {
		const acquired = new Promise((resolve, reject) => {
			const fail = () =>
				reject(
					new Error(
						"Cannot lock the existing PostgreSQL service. Start the stand first.",
					),
				);
			child.on("error", fail);
			child.stdin.on("error", fail);
			lines.once("close", fail);
			lines.once("line", (value) => resolve(value === "t"));
			timer = setTimeout(fail, 30000);
		});
		child.stdin.write("SELECT pg_try_advisory_lock(413592, 11);\n");
		if (!(await acquired))
			throw new Error(
				"Another stand or acceptance command is running. Retry after it finishes.",
			);
		clearTimeout(timer);
		await run();
	} finally {
		clearTimeout(timer);
		child.stdin.end();
		lines.close();
	}
}

async function main() {
	if (!["task9", "task10", "check", "voyage", "rollback"].includes(action))
		throw new Error("Unknown stand command");
	if (action === "voyage") preflight();
	if (action !== "check") docker(base, ["up", "-d", "--wait", "postgres"]);
	await withOperatorLock(() => {
		if (action === "check") {
			const result = spawnSync(
				process.execPath,
				["observability/task10-check.mjs"],
				{ stdio: "inherit" },
			);
			if (result.status !== 0)
				throw new Error("Fake Task 10 acceptance did not pass.");
			return;
		}
		prepareDatabase();
		if (task9) return up(base);
		const stored = policy();
		if (action === "voyage") return voyage(stored);
		if (action === "rollback") {
			rollback();
			up(base);
			console.log(
				"Fake provider available. Stored Voyage vectors are retained.",
			);
			return;
		}
		if (stored.writes.includes(target)) {
			if (stored.writes.includes("v2"))
				throw new Error(
					"Conflicting active next versions in the stored policy.",
				);
			preflight();
			up(mixed);
		} else up(base);
	});
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
