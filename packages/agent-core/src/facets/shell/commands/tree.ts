import type { CommandFn } from "../types";
import picomatch from "picomatch";
import { parseArgv } from "../argv";
import { expensiveMountAdvisory, isImplicitRoot } from "../helpers";

export const cmdTree: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "tree",
		flags: [
			{ name: "L", short: ["L"], long: ["level"], type: "number", default: 3 },
			{ name: "d", short: ["d"], type: "boolean" },
			{ name: "a", short: ["a"], long: ["all"], type: "boolean" },
			{ name: "I", short: ["I"], long: ["ignore"], type: "string", default: "" },
			{ name: "P", short: ["P"], long: ["pattern"], type: "string", default: "" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	// Strip trailing slashes so `tree sandbox/` doesn't produce `sandbox//foo`
	// when building child paths. Empty string and `.` are preserved verbatim.
	const rawRoot = positional[0] ?? "";
	const root = rawRoot === "." ? rawRoot : rawRoot.replace(/\/+$/, "");
	const ignoreMatch = flags.I ? picomatch(flags.I) : null;
	const patternMatch = flags.P ? picomatch(flags.P) : null;
	let dirs = 0;
	let files = 0;

	// Implicit-root tree (no arg) skips expensive mounts with a stderr advisory —
	// same policy as grep -r / find / ls -R / cp -r. Explicit `tree sandbox/`
	// walks normally because the agent opted in.
	const implicitRoot = isImplicitRoot(root);
	const expensive = implicitRoot && ctx.expensivePaths.length > 0
		? new Set(ctx.expensivePaths)
		: null;
	const advised = new Set<string>();

	const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
		if (depth >= flags.L) return;
		let entries: string[];
		try { entries = await ctx.vfs.readdir(dir); } catch { return; }
		if (!flags.a) entries = entries.filter((n) => !n.startsWith("."));
		if (ignoreMatch) entries = entries.filter((n) => !ignoreMatch(n));
		entries.sort();

		for (let i = 0; i < entries.length; i++) {
			if (ctx.signal.aborted) return;
			const name = entries.at(i);
			if (name === undefined) continue;
			// Implicit-root traversal skips top-level expensive mounts.
			// Fires exactly once per unique mount so the advisory doesn't spam.
			if (depth === 0 && expensive && expensive.has(name)) {
				if (!advised.has(name)) {
					advised.add(name);
					ctx.stderr.write(expensiveMountAdvisory("tree", name));
				}
				continue;
			}
			const full = dir ? `${dir}/${name}` : name;
			const isLast = i === entries.length - 1;
			const connector = isLast ? "└── " : "├── ";
			const childPrefix = prefix + (isLast ? "    " : "│   ");

			let isDir = false;
			try { isDir = (await ctx.vfs.stat(full)).isDirectory(); } catch { continue; }

			if (flags.d && !isDir) continue;
			if (!isDir && patternMatch && !patternMatch(name)) continue;

			if (isDir) {
				dirs++;
				ctx.stdout.write(`${prefix}${connector}${name}/\n`);
				await walk(full, childPrefix, depth + 1);
			} else {
				files++;
				ctx.stdout.write(`${prefix}${connector}${name}\n`);
			}
		}
	};

	ctx.stdout.write((root || ".") + "\n");
	await walk(root, "", 0);
	if (ctx.signal.aborted) return 130;

	const dirLabel = dirs === 1 ? "directory" : "directories";
	const fileLabel = files === 1 ? "file" : "files";
	if (flags.d) {
		ctx.stdout.write(`\n${dirs} ${dirLabel}\n`);
	} else {
		ctx.stdout.write(`\n${dirs} ${dirLabel}, ${files} ${fileLabel}\n`);
	}
	return 0;
};
