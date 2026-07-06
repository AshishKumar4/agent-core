import { FileError, FileErrorCode } from "../filesystem/error";
import type { ShellFileSystem } from "./filesystem";
import type { CommandContext } from "./types";
import { isBinaryFile } from "./mime";
import type { WalkEntry } from "./walk";

export type { WalkEntry as FileEntry } from "./walk";
export { walkRecursive } from "./walk";

export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export function formatDate(ms: number): string {
	const d = new Date(ms);
	const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${mon[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Read a file as UTF-8 text through the shell filesystem boundary so every
 * command receives a string while Agent Core's FileSystem remains byte-based.
 */
export function readText(
	vfs: ShellFileSystem,
	path: string
): Promise<string> {
	return vfs.readText(path);
}

/**
 * Read a file as UTF-8 text, returning `""` if the file doesn't exist.
 * Used by `>>` / `2>>` append-redirects and `tee -a` where a missing file
 * is legal and the content just starts empty. Other errors propagate.
 */
export async function readTextOrEmpty(
	vfs: ShellFileSystem,
	path: string
): Promise<string> {
	try {
		return await readText(vfs, path);
	} catch (error) {
		if (errorCode(error) === FileErrorCode.notFound) return "";
		throw error;
	}
}

export function errorCode(error: unknown): FileErrorCode | undefined {
	return error instanceof FileError ? error.code : undefined;
}

export function vfsErrorMessage(error: unknown, path: string): string {
	if (error instanceof FileError) {
		if (error.code === FileErrorCode.notFound) return `${path}: No such file or directory`;
		if (error.code === FileErrorCode.isDirectory) return `${path}: Is a directory`;
		if (error.code === FileErrorCode.notDirectory) return `${path}: Not a directory`;
		if (error.code === FileErrorCode.alreadyExists) return `${path}: File exists`;
		return `${path}: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Escape a pattern for fixed-string (`grep -F`) matching.
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
 */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the user gave no path (or `.` / ``) to a recursive command — the
 * walk root is implicit, so we apply expensive-mount exclusion on the agent's
 * behalf. Explicit paths (`grep -r foo sandbox/`) always walk normally.
 */
export function isImplicitRoot(path: string): boolean {
	return path === "" || path === ".";
}

/**
 * Standard stderr advisory when a recursive command skipped an expensive mount
 * during an implicit-root walk. Phrased to tell the agent exactly how to opt in
 * (name the path) or escalate (sandbox_exec). Used by every recursive command
 * so the wording is consistent and the observability classifier can key off it.
 */
export function expensiveMountAdvisory(cmdName: string, mountName: string): string {
	return (
		`${cmdName}: skipping ${mountName}/ from implicit-root walk (it is RPC-backed and slow). ` +
		`Name it explicitly to search it (e.g. \`${cmdName} ... ${mountName}/\`), ` +
		`or use sandbox_exec for recursive work against the container filesystem.\n`
	);
}

/**
 * Strip the trailing newline so we don't emit a ghost empty line after splitting.
 * Real POSIX text commands treat files ending in `\n` as N lines, not N+1.
 */
export function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	return trimmed.split("\n");
}

/**
 * Shared "read text input from positional files OR stdin" pattern used by every
 * text-processing command that accepts concatenated input.
 *
 * - No files + stdin present → reads stdin.
 * - No files + no stdin → writes `cmd: missing file operand` to stderr, returns null.
 * - Files present → concatenates UTF-8 content of each, skipping binaries with a
 *   stderr warning. First unreadable file writes an error and returns null.
 *
 * Callers that need per-file handling (grep, sed, wc formatting) use `readTextFileForCmd`
 * instead.
 */
export async function collectTextInput(
	ctx: CommandContext,
	files: string[],
	cmdName: string,
): Promise<string | null> {
	if (files.length === 0) {
		if (!ctx.stdin) {
			ctx.stderr.write(`${cmdName}: missing file operand\n`);
			return null;
		}
		return ctx.stdin.readAll();
	}
	let text = "";
	for (const f of files) {
		if (isBinaryFile(f)) {
			ctx.stderr.write(`${cmdName}: ${f}: binary file, skipping\n`);
			continue;
		}
		try {
			text += await readText(ctx.vfs, f);
		} catch (e) {
			ctx.stderr.write(`${cmdName}: ${vfsErrorMessage(e, f)}\n`);
			return null;
		}
	}
	return text;
}

/**
 * Read a single file as UTF-8, routing standard failure modes to stderr under
 * the command's name. Returns the content on success, or null on error
 * (binary / ENOENT / etc). Used by commands that process files one-at-a-time
 * and emit per-file output (head, tail, grep, sed).
 */
export async function readTextFileForCmd(
	ctx: CommandContext,
	path: string,
	cmdName: string,
): Promise<string | null> {
	if (isBinaryFile(path)) {
		ctx.stderr.write(`${cmdName}: ${path}: binary file, skipping\n`);
		return null;
	}
	try {
		return await readText(ctx.vfs, path);
	} catch (e) {
		ctx.stderr.write(`${cmdName}: ${vfsErrorMessage(e, path)}\n`);
		return null;
	}
}

/**
 * Options for `walkFiltered`. Every predicate is optional and receives the
 * relative path / basename of a candidate entry.
 */
export interface WalkFilterOptions {
	/** Hard ceiling on recursion depth passed through to walkRecursive (default 20). */
	maxDepth?: number;
	/** Safety cap on returned entries so a pathological tree can't freeze the worker (default 2000). */
	maxEntries?: number;
	/** Skip a directory (and its subtree) when the predicate returns true for its basename. */
	excludeDir?: ((basename: string) => boolean) | undefined;
	/** Only yield files whose basename matches; non-matching files are skipped but their dirs still walked. */
	includeFile?: ((basename: string) => boolean) | undefined;
	/** Skip files whose basename looks binary (MIME-based). Default false — callers may want to handle binary themselves. */
	skipBinary?: boolean | undefined;
	/** Yield directory entries in addition to files. Default false (yields files only). */
	includeDirs?: boolean | undefined;
	/** Aborts mid-walk when signaled. */
	signal?: AbortSignal | undefined;
	/**
	 * First-segment names to skip entirely. Any entry whose path starts with
	 * `${name}/` (or whose full path equals `${name}`) is excluded along with
	 * its subtree. Used by broad-search commands to avoid RPC-heavy mounts
	 * (e.g. a container-backed `sandbox/` mount) on implicit-root walks. Each unique excluded
	 * mount name fires `onExcludeMount` once so callers can emit a single
	 * stderr advisory per command invocation.
	 */
	excludeMounts?: readonly string[] | undefined;
	onExcludeMount?: ((mountName: string) => void) | undefined;
}

/**
 * Lazy DFS over a VFS subtree. Yields each entry as it's discovered so
 * consumers that `break` early (grep -m N, find into head) don't pay for the
 * remainder of the walk — important for RPC-backed backends where every
 * `stat`/`readdir` is a network round-trip.
 */
export async function* walkFiltered(
	vfs: ShellFileSystem,
	base: string,
	options: WalkFilterOptions = {},
): AsyncGenerator<WalkEntry> {
	const { maxDepth = 20, maxEntries = 2000, excludeDir, includeFile, skipBinary, includeDirs, signal, excludeMounts, onExcludeMount } = options;
	const normalized = base === "." ? "" : base.replace(/\/+$/, "");
	const mountSet = excludeMounts && excludeMounts.length > 0 ? new Set(excludeMounts) : null;
	const reportedMounts = new Set<string>();
	let yielded = 0;

	async function* walk(dir: string, depth: number): AsyncGenerator<WalkEntry> {
		if (depth > maxDepth || yielded >= maxEntries) return;
		if (signal?.aborted) return;
		let names: string[];
		try { names = await vfs.readdir(dir); } catch { return; }

		for (const name of names) {
			if (yielded >= maxEntries) return;
			if (signal?.aborted) return;

			const full = dir ? `${dir}/${name}` : name;
			const segments = full.split("/");

			if (mountSet) {
				const top = segments[0] ?? "";
				if (mountSet.has(top)) {
					if (onExcludeMount && !reportedMounts.has(top)) {
						reportedMounts.add(top);
						onExcludeMount(top);
					}
					continue;
				}
			}

			if (excludeDir && excludeDir(name)) continue;

			let stat: WalkEntry["stat"];
			try { stat = await vfs.stat(full); } catch { continue; }

			if (stat.isDirectory()) {
				if (includeDirs) { yielded++; yield { path: full, stat }; }
				yield* walk(full, depth + 1);
				continue;
			}
			if (skipBinary && isBinaryFile(name)) continue;
			if (includeFile && !includeFile(name)) continue;
			yielded++;
			yield { path: full, stat };
		}
	}

	yield* walk(normalized, 0);
}
