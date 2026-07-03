import type { CommandFn } from "../types";
import picomatch from "picomatch";
import { parseArgv } from "../argv";
import { expensiveMountAdvisory, isImplicitRoot, walkFiltered } from "../helpers";

/**
 * Minimal POSIX-ish find.
 *
 * Supports the flags agents actually use: -name, -iname, -type, -maxdepth,
 * -mindepth, -path, -not (alias !), -print, -print0. Predicates are ANDed.
 *
 * The structural fix over the prior implementation: `-name`, `-type`,
 * `-maxdepth` now correctly parse as long-with-single-dash flags. Before,
 * minimist clustered `-name` into `-n -a -m -e` and the filter was silently
 * dropped.
 */

export const cmdFind: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "find",
		flags: [
			{ name: "name", long: ["name"], type: "string", default: "" },
			{ name: "iname", long: ["iname"], type: "string", default: "" },
			{ name: "path", long: ["path"], type: "string", default: "" },
			{ name: "type", long: ["type"], type: "string", default: "" },
			{ name: "maxdepth", long: ["maxdepth"], type: "number", default: 20 },
			{ name: "mindepth", long: ["mindepth"], type: "number", default: 0 },
			{ name: "print0", long: ["print0"], type: "boolean" },
			{ name: "print", long: ["print"], type: "boolean" },
			{ name: "not", long: ["not"], short: ["!"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	const roots = positional.length > 0 ? positional : ["."];

	const nameMatch = flags.name ? picomatch(flags.name) : null;
	const inameMatch = flags.iname ? picomatch(flags.iname, { nocase: true }) : null;
	const pathMatch = flags.path ? picomatch(flags.path) : null;
	const typeFilter = flags.type;

	const separator = flags.print0 ? "\0" : "\n";

	const accept = (relPath: string, isDir: boolean): boolean => {
		let ok = true;
		if (typeFilter === "f" && isDir) ok = false;
		if (typeFilter === "d" && !isDir) ok = false;
		const basename = relPath.split("/").pop() ?? "";
		if (ok && nameMatch && !nameMatch(basename)) ok = false;
		if (ok && inameMatch && !inameMatch(basename)) ok = false;
		if (ok && pathMatch && !pathMatch(relPath)) ok = false;
		return flags.not ? !ok : ok;
	};

	let anyResult = false;
	let exit = 0;

	// Shared advisory emitter — fires once per mount across all roots so `find .`
	// or `find . memory/` never spams the agent with duplicate notices.
	const advised = new Set<string>();
	const emitAdvisory = (mount: string) => {
		if (advised.has(mount)) return;
		advised.add(mount);
		ctx.stderr.write(expensiveMountAdvisory("find", mount));
	};

	for (const root of roots) {
		// Normalize: strip trailing slashes; some backends don't tolerate them in readdir.
		const basePath = root === "." ? "" : root.replace(/\/+$/, "");
		const implicitRoot = isImplicitRoot(root);
		try {
			const rootStat = await ctx.vfs.stat(basePath);
			// "find ." / "find dir" — include the root itself in results like real find
			if (flags.mindepth === 0 && accept(root, rootStat.isDirectory())) {
				ctx.stdout.write(root + separator);
				anyResult = true;
			}

			if (rootStat.isDirectory()) {
				// `-maxdepth N` in POSIX find: root is depth 0, direct children depth 1, etc.
				// Our `walkFiltered` max-depth counts recursion levels below the root, so
				// find's maxdepth N corresponds to walkFiltered's maxDepth N-1.
				const baseDepth = basePath ? basePath.split("/").length : 0;
				for await (const e of walkFiltered(ctx.vfs, basePath, {
					maxDepth: Math.max(0, flags.maxdepth - 1),
					includeDirs: true,
					signal: ctx.signal,
					excludeMounts: implicitRoot ? ctx.expensivePaths : undefined,
					onExcludeMount: implicitRoot ? emitAdvisory : undefined,
				})) {
					const depth = e.path.split("/").length - baseDepth;
					if (depth < flags.mindepth) continue;
					const displayPath = basePath ? e.path : (root === "." ? `./${e.path}` : e.path);
					if (accept(e.path, e.stat.isDirectory())) {
						ctx.stdout.write(displayPath + separator);
						anyResult = true;
					}
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			ctx.stderr.write(`find: '${root}': ${msg}\n`);
			exit = 1;
		}
	}

	return exit !== 0 ? exit : anyResult ? 0 : 1;
};
