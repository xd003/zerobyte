import { spawn, execFile, type ChildProcess, type ExecException, type ExecFileOptions } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setPriority } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

type ExecProps = {
	command: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
} & ExecFileOptions;

const activeChildren = new Set<ChildProcess>();

const trackChild = (child: ChildProcess) => {
	if (child.pid === undefined) return;

	activeChildren.add(child);
	const untrack = () => activeChildren.delete(child);
	child.once("exit", untrack);
	child.once("error", untrack);
};

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Interrupts every child started through safeSpawn/safeExec and waits for them to exit.
 * SIGINT lets restic release its repository lock; children still alive after graceMs are SIGKILLed.
 * Returns the number of children that were interrupted.
 */
export const terminateChildProcesses = async (graceMs = 15_000) => {
	const children = [...activeChildren].filter((child) => !hasExited(child));
	if (children.length === 0) return 0;

	const exited = Promise.all(children.map((child) => once(child, "exit")));

	for (const child of children) {
		child.kill("SIGINT");
	}

	const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs, true, { ref: false })]);

	if (timedOut) {
		for (const child of children) {
			if (!hasExited(child)) child.kill("SIGKILL");
		}
		await exited;
	}

	return children.length;
};

export const safeExec = async ({ command, args = [], env = {}, ...rest }: ExecProps) => {
	const options = {
		env: { ...process.env, ...env },
	};

	try {
		const execution = promisify(execFile)(command, args, {
			...options,
			...rest,
			shell: false,
			encoding: "utf8",
		});
		trackChild(execution.child);
		const { stdout, stderr } = await execution;

		return { exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString(), timedOut: false };
	} catch (error) {
		const execError = error as ExecException & { killed?: boolean };
		const timedOut = execError.killed === true && execError.code === null;

		return {
			exitCode: typeof execError.code === "number" ? execError.code : 1,
			stdout: execError.stdout?.toString() ?? "",
			stderr: timedOut
				? "Command timed out before completing"
				: execError.stderr?.toString() || execError.message || "",
			timedOut,
		};
	}
};

interface SafeSpawnParamsBase {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	priority?: "background";
	onStderr?: (error: string) => void;
	onSpawn?: (child: ReturnType<typeof spawn>) => void;
}

export interface SafeSpawnParamsLines extends SafeSpawnParamsBase {
	stdoutMode?: "lines";
	onStdout?: (line: string) => void;
}

export interface SafeSpawnParamsRaw extends SafeSpawnParamsBase {
	stdoutMode: "raw";
	onStdout?: never;
}

export type SafeSpawnParams = SafeSpawnParamsLines | SafeSpawnParamsRaw;

export type SpawnResult = {
	exitCode: number;
	summary: string;
	error: string;
	stderr?: string;
};

const MAX_STDERR_LINES = 50;
const BACKGROUND_NICE_VALUE = 10;

const getBackgroundCommand = (command: string, args: string[]) => {
	const ionice = ["/bin/ionice", "/usr/bin/ionice"].find((path) => existsSync(path));

	if (ionice) {
		return {
			command: ionice,
			args: ["-t", "-c", "3", command, ...args],
		};
	}

	return { command, args };
};

const setBackgroundPriority = (pid: number | undefined) => {
	if (!pid) return;

	try {
		setPriority(pid, BACKGROUND_NICE_VALUE);
	} catch {
		// some oses can reject priority changes
	}
};

export function safeSpawn(params: SafeSpawnParamsLines): Promise<SpawnResult>;
export function safeSpawn(params: SafeSpawnParamsRaw): Promise<SpawnResult>;
export function safeSpawn(params: SafeSpawnParams): Promise<SpawnResult> {
	const { command, args, env = {}, signal, priority, onStderr, onSpawn } = params;
	const spawnCommand = priority === "background" ? getBackgroundCommand(command, args) : { command, args };
	const stdoutMode = params.stdoutMode ?? "lines";
	const onStdout = stdoutMode === "lines" ? params.onStdout : undefined;

	let lastStdout = "";
	let lastStderr = "";
	const stderrLines: string[] = [];

	return new Promise<SpawnResult>((resolve) => {
		let spawnError: Error | null = null;
		const child = spawn(spawnCommand.command, spawnCommand.args, {
			env: { ...process.env, ...env },
			shell: false,
			signal: signal,
			stdio: ["ignore", "pipe", "pipe"],
		});
		trackChild(child);

		if (priority === "background") {
			setBackgroundPriority(child.pid);
		}

		onSpawn?.(child);

		child.stderr.setEncoding("utf8");

		const rlErr = createInterface({ input: child.stderr });
		let rl: ReturnType<typeof createInterface> | undefined;

		if (stdoutMode === "lines") {
			child.stdout.setEncoding("utf8");

			rl = createInterface({ input: child.stdout });

			rl.on("line", (line) => {
				if (onStdout) onStdout(line);
				const trimmed = line.trim();
				if (trimmed.length > 0) {
					lastStdout = line;
				}
			});
		}

		rlErr.on("line", (line) => {
			if (onStderr) onStderr(line);
			stderrLines.push(line);
			if (stderrLines.length > MAX_STDERR_LINES) {
				stderrLines.shift();
			}
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				lastStderr = line;
			}
		});

		child.on("error", (err) => {
			spawnError = err;
		});

		child.on("close", (code) => {
			rlErr.close();
			rl?.close();

			const exitCode = spawnError ? -1 : (code ?? -1);
			const error = spawnError?.message || lastStderr;

			resolve({
				exitCode,
				summary: lastStdout,
				error,
				stderr: stderrLines.join("\n"),
			});
		});
	});
}
