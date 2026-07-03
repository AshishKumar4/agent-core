import picomatch from "picomatch";
import type { ShellFileSystem } from "./filesystem";
import type { ParsedCommand, ParsedCommandList, ParsedPipeline } from "./parse";
import { parseCommandList } from "./parse";
import type { CommandFn, CommandContext, OutputStream, ShellEnv, ShellResult } from "./types";
import { BufferedOutput, StringInput } from "./stream";
import type { FileEntry } from "./helpers";
import { readText, readTextOrEmpty, walkRecursive } from "./helpers";
import { cmdCat, cmdHead, cmdTail } from "./commands/cat";
import { cmdLs } from "./commands/ls";
import { cmdTree } from "./commands/tree";
import { cmdFind } from "./commands/find";
import { cmdGrep } from "./commands/grep";
import { cmdEcho, cmdMkdir, cmdTouch, cmdRm, cmdCp, cmdMv } from "./commands/write";
import { cmdSed } from "./commands/edit";
import { cmdStat, cmdWc } from "./commands/stat";
import { cmdSort, cmdUniq, cmdCut, cmdTr, cmdNl, cmdRev, cmdTac } from "./commands/text";
import { cmdTee, cmdXargs } from "./commands/io";
import {
	cmdPrintf, cmdYes, cmdSeq,
	cmdBasename, cmdDirname, cmdPwd, cmdDate, cmdTrue, cmdFalse,
} from "./commands/builtins";
import { cmdAwk } from "./commands/awk";
import { cmdDiff } from "./commands/diff";

export type { ShellResult } from "./types";

export const COMMANDS: Record<string, CommandFn> = {
	// Files (read)
	cat: cmdCat, head: cmdHead, tail: cmdTail,
	ls: cmdLs, tree: cmdTree, find: cmdFind, stat: cmdStat,
	// Files (write)
	mkdir: cmdMkdir, touch: cmdTouch, rm: cmdRm, cp: cmdCp, mv: cmdMv,
	// Text
	grep: cmdGrep, sed: cmdSed, awk: cmdAwk, diff: cmdDiff,
	sort: cmdSort, uniq: cmdUniq, cut: cmdCut, tr: cmdTr,
	nl: cmdNl, rev: cmdRev, tac: cmdTac, wc: cmdWc,
	// I/O and utility
	echo: cmdEcho, printf: cmdPrintf, tee: cmdTee, xargs: cmdXargs, yes: cmdYes,
	seq: cmdSeq, basename: cmdBasename, dirname: cmdDirname, pwd: cmdPwd,
	date: cmdDate, true: cmdTrue, false: cmdFalse,
};

/**
 * List of real OS programs that this shell intentionally cannot run.
 * For these, `sandbox_exec` is the right tool — that's a runtime concern,
 * not a shell-emulation gap.
 */
const PROGRAM_COMMANDS = new Set([
	"npm", "npx", "node", "bun", "bunx", "deno", "python", "python3", "pip",
	"git", "curl", "wget", "make", "cargo", "go", "ruby", "java", "javac",
	"docker", "kubectl", "terraform", "ssh", "scp", "rsync",
	"bash", "sh", "zsh", "fish",
]);

/** Shell builtins this shell doesn't support (stateless evaluator — no cwd, no env mutation). */
const SHELL_BUILTINS = new Set(["cd", "export", "source", "alias", "unset", "set"]);

const MAX_CMDSUB_DEPTH = 3;

/**
 * Public entry. Evaluates a command string against the VFS and returns the
 * combined shell result. `stdin` seeds the first pipeline stage; `env` is
 * exposed to variable expansion.
 */
export async function exec(
	vfs: ShellFileSystem,
	input: string,
	stdin?: string,
	env: ShellEnv = {},
	signal?: AbortSignal,
	expensivePaths: readonly string[] = [],
): Promise<ShellResult> {
	try {
		const list = parseCommandList(input, env);
		return evalCommandList(vfs, list, stdin, env, signal ?? new AbortController().signal, 0, expensivePaths);
	} catch (err) {
		return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
	}
}

/**
 * Internal entry used by `xargs` and command substitution to invoke an already-
 * tokenized argv without re-parsing. Writes to the provided streams.
 */
export async function runCommand(
	vfs: ShellFileSystem,
	argv: string[],
	stdin: string | undefined,
	env: ShellEnv,
	signal: AbortSignal,
	stdout: OutputStream,
	stderr: OutputStream,
	expensivePaths: readonly string[] = [],
): Promise<number> {
	const name = argv.at(0);
	if (name === undefined) return 0;
	const args = argv.slice(1);

	if (PROGRAM_COMMANDS.has(name)) {
		stderr.write(`sh: '${name}' is an external program and cannot run in this shell. Use sandbox_exec to run programs in the container.\n`);
		return 127;
	}
	if (SHELL_BUILTINS.has(name)) {
		stderr.write(`sh: '${name}': this shell is stateless (no cd / env mutation). Use absolute relative paths from workspace root.\n`);
		return 1;
	}

	const fn = COMMANDS[name];
	if (!fn) {
		const supported = Object.keys(COMMANDS).sort().join(", ");
		stderr.write(`sh: command not found: ${name}\nSupported: ${supported}\n`);
		return 127;
	}

	const ctx: CommandContext = {
		args,
		argv0: name,
		env,
		vfs,
		stdout,
		stderr,
		runCommand: (nextArgv: string[], nextStdin?: string) =>
			runCommand(vfs, nextArgv, nextStdin, env, signal, stdout, stderr, expensivePaths),
		stdin: stdin !== undefined ? new StringInput(stdin) : undefined,
		signal,
		expensivePaths,
	};
	try {
		return await fn(ctx);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		stderr.write(`${name}: ${msg}\n`);
		return 1;
	}
}

async function evalCommandList(
	vfs: ShellFileSystem,
	list: ParsedCommandList,
	stdin: string | undefined,
	env: ShellEnv,
	signal: AbortSignal,
	depth: number,
	expensivePaths: readonly string[] = [],
): Promise<ShellResult> {
	// Left-to-right with lastExit propagation. Correctly handles long chains
	// the old skipNext/break got wrong, e.g. `a || b || c` with a=0 runs only a.
	const combinedStdout: string[] = [];
	const combinedStderr: string[] = [];
	let lastResult: ShellResult = { stdout: "", stderr: "", exitCode: 0 };

	for (let i = 0; i < list.segments.length; i++) {
		const seg = list.segments.at(i);
		if (seg === undefined) continue;
		if (i > 0) {
			const prevOp = list.segments.at(i - 1)?.operator;
			if (prevOp === "&&" && lastResult.exitCode !== 0) continue;
			if (prevOp === "||" && lastResult.exitCode === 0) continue;
		}

		lastResult = await evalPipeline(vfs, seg.pipeline, stdin, env, signal, depth, expensivePaths);
		if (lastResult.stdout) combinedStdout.push(lastResult.stdout);
		if (lastResult.stderr) combinedStderr.push(lastResult.stderr);

		stdin = undefined;
	}

	return {
		stdout: combinedStdout.join(""),
		stderr: combinedStderr.join(""),
		exitCode: lastResult.exitCode,
	};
}

async function evalPipeline(
	vfs: ShellFileSystem,
	pipeline: ParsedPipeline,
	stdin: string | undefined,
	env: ShellEnv,
	signal: AbortSignal,
	depth: number,
	expensivePaths: readonly string[] = [],
): Promise<ShellResult> {
	// Apply `<` redirect (takes precedence over stdin from previous segment)
	const stdinRedirect = pipeline.redirects.find((r) => r.type === "<");
	if (stdinRedirect) {
		try {
			stdin = await readText(vfs, stdinRedirect.path);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { stdout: "", stderr: `sh: ${stdinRedirect.path}: ${msg}\n`, exitCode: 1 };
		}
	}

	// Thread stdout through each command
	let data = stdin;
	const stderrBuf = new BufferedOutput();
	let exitCode = 0;

	for (const cmd of pipeline.commands) {
		const stdoutBuf = new BufferedOutput();

		// Expand argv: env vars, globs, command substitutions
		const argv = await expandArgv(vfs, cmd, env, signal, depth, expensivePaths);
		if (argv.error) {
			stderrBuf.write(argv.error + "\n");
			return { stdout: "", stderr: stderrBuf.read(), exitCode: 1 };
		}

		exitCode = await runCommand(vfs, argv.tokens, data, env, signal, stdoutBuf, stderrBuf, expensivePaths);
		data = stdoutBuf.read();

		// A non-zero in the middle of a pipe still flows the (possibly partial) output downstream,
		// matching bash without pipefail. The final exit code is the last segment's.
	}

	// Apply stdout / stderr redirects at pipeline end
	const stdoutText = data ?? "";
	const stderrText = stderrBuf.read();

	const stdoutRedirect = pipeline.redirects.find((r) => r.type === ">" || r.type === ">>" || r.type === "&>");
	// `&>` is handled entirely by the stdout branch (writes stdout+stderr
	// to the same file). Including it here would re-open the same path
	// and overwrite the combined content with stderr only.
	const stderrRedirect = pipeline.redirects.find((r) => r.type === "2>" || r.type === "2>>");

	let finalStdout = stdoutText;
	let finalStderr = stderrText;

	if (stdoutRedirect) {
		const combined = stdoutRedirect.type === "&>" ? stdoutText + stderrText : stdoutText;
		const writeErr = await writeRedirect(vfs, stdoutRedirect.path, combined, stdoutRedirect.type === ">>");
		if (writeErr) return { stdout: "", stderr: finalStderr + writeErr, exitCode: 1 };
		finalStdout = "";
		if (stdoutRedirect.type === "&>") finalStderr = "";
	}

	if (stderrRedirect) {
		const writeErr = await writeRedirect(vfs, stderrRedirect.path, stderrText, stderrRedirect.type === "2>>");
		if (writeErr) return { stdout: "", stderr: finalStderr + writeErr, exitCode: 1 };
		finalStderr = "";
	}

	return { stdout: finalStdout, stderr: finalStderr, exitCode };
}

/**
 * Apply a single `>`, `>>`, `2>`, `2>>`, or `&>` redirect target.
 * Returns an error-message string on failure (to be concatenated into stderr),
 * or undefined on success. `/dev/null` short-circuits to a no-op.
 */
async function writeRedirect(vfs: ShellFileSystem, path: string, content: string, append: boolean): Promise<string | undefined> {
	if (path === "/dev/null") return undefined;
	try {
		if (append) {
			const existing = await readTextOrEmpty(vfs, path);
			await vfs.writeFile(path, existing + content);
		} else {
			await vfs.writeFile(path, content);
		}
		return undefined;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return `sh: ${path}: ${msg}\n`;
	}
}

/**
 * Expand `ArgToken`s into literal strings:
 *   - `literal`    → pass through (with env-var interpolation)
 *   - `glob`       → expand against VFS; fall back to literal if no matches
 *   - `cmdsub`     → recursive eval; substitute stdout (trimmed)
 */
async function expandArgv(
	vfs: ShellFileSystem,
	cmd: ParsedCommand,
	env: ShellEnv,
	signal: AbortSignal,
	depth: number,
	expensivePaths: readonly string[] = [],
): Promise<{ tokens: string[]; error: string | undefined }> {
	// Reuse walk results across multiple glob tokens in the same argv (`cat *.md *.ts`).
	const globCache = new Map<string, FileEntry[]>();
	const out: string[] = [];
	for (const tok of cmd.argv) {
		if (tok.kind === "literal") {
			// shell-quote already expanded $VAR during parsing; nothing to do here.
			out.push(tok.value);
			continue;
		}
		if (tok.kind === "cmdsub") {
			if (depth >= MAX_CMDSUB_DEPTH) {
				return { tokens: out, error: `sh: command substitution nesting exceeds limit (${MAX_CMDSUB_DEPTH})` };
			}
			try {
				const sublist = parseCommandList(tok.command, env);
				const subResult = await evalCommandList(vfs, sublist, undefined, env, signal, depth + 1, expensivePaths);
				const trimmed = subResult.stdout.replace(/\n+$/, "");
				// Split on whitespace per bash word-splitting semantics
				for (const part of trimmed.split(/\s+/).filter(Boolean)) out.push(part);
			} catch (e) {
				return { tokens: out, error: `sh: command substitution failed: ${e instanceof Error ? e.message : String(e)}` };
			}
			continue;
		}
		if (tok.kind === "glob") {
			const matches = await expandGlob(vfs, tok.pattern, globCache);
			if (matches.length === 0) out.push(tok.pattern);
			else out.push(...matches);
		}
	}
	return { tokens: out, error: undefined };
}

async function expandGlob(
	vfs: ShellFileSystem,
	pattern: string,
	cache: Map<string, FileEntry[]>,
): Promise<string[]> {
	const firstGlob = pattern.search(/[*?[]/);
	let baseDir = "";
	let rel = pattern;
	if (firstGlob > 0) {
		const prefix = pattern.slice(0, firstGlob);
		const lastSlash = prefix.lastIndexOf("/");
		if (lastSlash >= 0) {
			baseDir = prefix.slice(0, lastSlash);
			rel = pattern.slice(lastSlash + 1);
		}
	}
	const matcher = picomatch(rel);
	let entries = cache.get(baseDir);
	if (!entries) {
		entries = await walkRecursive(vfs, baseDir, 20, 2000);
		cache.set(baseDir, entries);
	}
	const matches: string[] = [];
	for (const e of entries) {
		const relPath = baseDir ? e.path.slice(baseDir.length + 1) : e.path;
		if (matcher(relPath)) matches.push(e.path);
	}
	return matches.sort();
}
