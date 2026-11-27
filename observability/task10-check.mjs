import { spawn, spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { createInterface } from "node:readline";
import { isTestEnvironment } from "../backend/test/task10-telemetry.mjs";

const compose = [
	"compose",
	"-p",
	"nest-fullstack-project",
	"-f",
	"docker-compose.yml",
	"-f",
	"observability/compose.task10.yml",
];

function run(args, description, capture = false) {
	const result = spawnSync("docker", [...compose, ...args], {
		stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.status !== 0) throw new Error(description);
	return result.stdout;
}

function port(service, target) {
	const mapping = run(
		["port", service, target],
		"Missing port for " + service,
		true,
	);
	const match = mapping
		.trim()
		.split(/\r?\n/)[0]
		?.match(/:(\d+)$/);
	if (!match) throw new Error("Invalid published port for " + service);
	return match[1];
}

// Inspect the actual service environments before requesting any worker stop.
for (const service of ["backend", "worker"]) {
	run(
		[
			"exec",
			"-T",
			service,
			"node",
			"-e",
			"process.exit((" +
				isTestEnvironment.toString() +
				")(process.env) ? 0 : 1)",
		],
		"Task 10 requires the running " +
			service +
			" to use the test database, fake provider and dedicated queues. Run node observability/stand-up.mjs task10.",
	);
}
const ports = [
	["JAEGER", "jaeger", "16686"],
	["GRAFANA", "grafana", "3000"],
	["PROMETHEUS", "prometheus", "9090"],
].flatMap(([key, service, target]) => [
	"-e",
	"TASK10_" + key + "_PORT=" + port(service, target),
]);

const test = spawn(
	"docker",
	[
		...compose,
		"exec",
		"-T",
		...ports,
		"backend",
		"node",
		"test/task10-acceptance.mjs",
	],
	{
		stdio: ["pipe", "pipe", "inherit"],
	},
);
const completed = new Promise((resolve, reject) => {
	test.on("error", reject);
	test.on("exit", resolve);
});
let stopped = false;
let interrupted = false;
function interrupt() {
	interrupted = true;
	test.stdin.end();
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
	for await (const line of createInterface({ input: test.stdout })) {
		if (line !== "::worker.stop" && line !== "::worker.start") {
			console.log(line);
			continue;
		}
		if (interrupted) continue;
		const stop = line === "::worker.stop";
		if (stop) stopped = true;
		run([stop ? "stop" : "start", "worker"], "Task 10 worker control failed");
		stopped = stop;
		test.stdin.write("ok\n");
	}
	const exitCode = await completed;
	process.exitCode = interrupted ? 1 : (exitCode ?? 1);
} finally {
	test.stdin.end();
	if (stopped) run(["start", "worker"], "Failed to restore Task 10 worker");
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", interrupt);
}
