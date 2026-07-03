import type { CommandFn } from "../types";
import { parseArgv } from "../argv";
import { expensiveMountAdvisory, humanSize, formatDate, isImplicitRoot, vfsErrorMessage, walkFiltered } from "../helpers";

export const cmdLs: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "ls",
		flags: [
			{ name: "l", short: ["l"], type: "boolean" },
			{ name: "a", short: ["a"], long: ["all"], type: "boolean" },
			{ name: "R", short: ["R"], long: ["recursive"], type: "boolean" },
			{ name: "h", short: ["h"], long: ["human-readable"], type: "boolean" },
			{ name: "t", short: ["t"], type: "boolean" },
			{ name: "one", short: ["1"], type: "boolean" },
			{ name: "r", short: ["r"], long: ["reverse"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	const path = positional[0] ?? "";

	try {
		if (flags.R) {
			// Implicit-root `ls -R` (no path, or `.`) skips expensive mounts.
			// Explicit `ls -R sandbox` walks normally — the agent asked for it.
			const implicitRoot = isImplicitRoot(path);
			const advised = new Set<string>();
			const emitAdvisory = (mount: string) => {
				if (advised.has(mount)) return;
				advised.add(mount);
				ctx.stderr.write(expensiveMountAdvisory("ls", mount));
			};
			const entries: { path: string; stat: { type: string; size: number; mtimeMs: number; mode: number } }[] = [];
			for await (const e of walkFiltered(ctx.vfs, path, {
				maxDepth: 50,
				maxEntries: 500,
				includeDirs: true,
				signal: ctx.signal,
				excludeMounts: implicitRoot ? ctx.expensivePaths : undefined,
				onExcludeMount: implicitRoot ? emitAdvisory : undefined,
			})) {
				entries.push(e);
			}
			const lines = flags.l
				? entries.map((e) => formatLong(e.path, e.stat, flags.h))
				: entries.map((e) => e.path);
			ctx.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
			return 0;
		}

		let entries = await ctx.vfs.readdir(path);
		if (!flags.a) entries = entries.filter((n) => !n.startsWith("."));

		if (flags.t || flags.l) {
			const withStats = await Promise.all(entries.map(async (name) => {
				const full = path ? `${path}/${name}` : name;
				try { return { name, stat: await ctx.vfs.stat(full) }; }
				catch { return { name, stat: null }; }
			}));
			if (flags.t) withStats.sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0));
			if (flags.r) withStats.reverse();
			if (flags.l) {
				const lines = withStats.map((e) => formatLong(e.name, e.stat, flags.h));
				ctx.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
				return 0;
			}
			entries = withStats.map((e) => e.name);
		} else if (flags.r) {
			entries.reverse();
		}

		if (entries.length === 0) return 0;
		if (flags.one || flags.l) ctx.stdout.write(entries.join("\n") + "\n");
		else ctx.stdout.write(entries.join("  ") + "\n");
		return 0;
	} catch (e) {
		ctx.stderr.write(`ls: ${vfsErrorMessage(e, path || ".")}\n`);
		return 2;
	}
};

function formatLong(name: string, stat: { type: string; size: number; mtimeMs: number; mode: number } | null, human: boolean): string {
	if (!stat) return `??????????  ? ?    ?         ? ? ${name}`;
	const type = stat.type === "dir" ? "d" : "-";
	const perms = modeString(stat.mode);
	const size = human ? humanSize(stat.size).padStart(5) : String(stat.size).padStart(8);
	const date = formatDate(stat.mtimeMs);
	return `${type}${perms}  1 user user ${size} ${date} ${name}`;
}

function modeString(mode: number): string {
	const m = mode & 0o777;
	let s = "";
	for (const shift of [6, 3, 0]) {
		const bits = (m >> shift) & 7;
		s += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-");
	}
	return s;
}
