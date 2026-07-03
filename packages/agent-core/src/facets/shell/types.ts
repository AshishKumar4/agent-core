import type { ShellFileSystem } from "./filesystem";

/**
 * Result of a pipeline / command-list invocation as surfaced to the caller.
 *
 * `stdout` is the accumulated output the shell would have printed.
 * `stderr` is the accumulated error stream (empty in the common success case).
 * `exitCode` is the exit code of the final segment, 0 on success.
 */
export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Buffered write stream backing `ctx.stdout` / `ctx.stderr` inside a command.
 * Commands call `write(text)` — `read()` collects the accumulated string once
 * the command returns. Splitting is deferred; no intermediate concatenation on
 * the hot path.
 */
export interface OutputStream {
	write(text: string): void;
	read(): string;
}

/**
 * Buffered read stream backing `ctx.stdin`. A command uses `readAll()` to
 * materialize the upstream output (from a pipe, a `<` redirect, or the
 * caller-supplied stdin) as a single string. Streaming is not modeled —
 * upstream commands have already completed by the time the next stage runs.
 */
export interface InputStream {
	readAll(): Promise<string>;
}

/**
 * Environment exposed to commands for variable expansion and reflection.
 * Read-only; commands do not mutate the env. See `parse.ts` expansion logic
 * and `dispatch.ts` for how the values are seeded (`WORKSPACE_ID`, `NOW`, ...).
 */
export type ShellEnv = Record<string, string>;

/**
 * Execution context passed to every command. Mirrors LIFO OS's shape for
 * command ergonomics (write to stdout, read from stdin, return exit code) but
 * is async throughout because our VFS is async (the sandbox-mounted backend
 * does RPC into the container).
 */
export interface CommandContext {
	/** Arguments excluding the command name (argv[1..]). */
	args: string[];
	/** Full argv including the command name (argv[0] = command name). Useful for error messages. */
	argv0: string;
	/** Read-only environment for variable expansion inside commands. */
	env: ShellEnv;
	/** Virtual filesystem. */
	vfs: ShellFileSystem;
	stdout: OutputStream;
	stderr: OutputStream;
	/** Re-enter the shared dispatcher while preserving the current shell context. */
	runCommand(argv: string[], stdin?: string): Promise<number>;
	/** Undefined if no upstream pipe / stdin redirect. */
	stdin: InputStream | undefined;
	/** Best-effort cancellation. Long-running commands check this periodically. */
	signal: AbortSignal;
	/**
	 * Top-level mount names whose recursive traversal is RPC-backed. Recursive
	 * commands skip these only when invoked with an implicit root (`.` or
	 * empty). Plumbed from `ShellOptions.expensivePaths`. Empty array when the
	 * caller didn't configure any.
	 */
	expensivePaths: readonly string[];
}

/** Command implementation. Returns the exit code; output goes through `ctx.stdout` / `ctx.stderr`. */
export type CommandFn = (ctx: CommandContext) => Promise<number>;

/** Registry entry: name → implementation + short help. */
export interface CommandEntry {
	name: string;
	run: CommandFn;
	/** One-line summary for the tool description / help listing. */
	summary: string;
}
