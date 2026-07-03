import type { FileSystem } from "../filesystem/filesystem";
import type { OperationContext } from "../../operations/context";
import { ShellFileSystem } from "./filesystem";
import { exec } from "./dispatch";
import type { ShellEnv, ShellResult } from "./types";

export type { ShellResult } from "./types";
export { COMMANDS } from "./dispatch";
export { ShellFacet } from "./facet";

export interface ShellOptions {
	/**
	 * Read-only environment for `$VAR` expansion. Pass a factory to re-evaluate
	 * per exec (e.g. so `NOW` stays current for long-lived shell instances).
	 */
	env?: ShellEnv | (() => ShellEnv);
	/** AbortSignal for cancelling long-running commands (yes, grep -r over sandbox/...). */
	signal?: AbortSignal;
	/**
	 * Top-level mount names whose recursive traversal is RPC-backed (e.g. a
	 * container-filesystem mount in Seal). Broad-search commands (`grep -r`,
	 * `find`, `tree`, `ls -R`, `cp -r`) silently skip these paths ONLY when
	 * the command's root is implicit (`.` or omitted) so the agent doesn't
	 * inadvertently flood the RPC boundary. An explicit path (e.g.
	 * `grep -r foo sandbox/`) walks normally — the agent has opted in.
	 * Non-recursive ops (`cat`, `ls`, `stat`, `wc`, `grep` without `-r`,
	 * `head`, `tail`, `sed`) are unaffected; single RPCs are cheap.
	 */
	expensivePaths?: string[];
}

export interface Shell {
	exec(command: string, stdin?: string): Promise<ShellResult>;
}

export function createShell(
	files: FileSystem,
	context: OperationContext,
	options: ShellOptions = {}
): Shell {
	const vfs = new ShellFileSystem(files, context);
	const resolveEnv = (): ShellEnv => {
		const e = options.env;
		if (typeof e === "function") return e();
		return e ?? {};
	};
	return {
		exec: (command: string, stdin?: string) => exec(vfs, command, stdin, resolveEnv(), options.signal, options.expensivePaths),
	};
}
