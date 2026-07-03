/**
 * I/O commands that actually touch the VFS (tee) or re-enter dispatch (xargs).
 *
 * Trivial single-purpose commands (printf/yes/seq/date/basename/dirname/pwd/true/false)
 * live in `builtins.ts` instead.
 *
 * tee / xargs structure adapted from LIFO OS
 * (`packages/core/src/commands/io/*.ts`, MIT-licensed), ported to our async
 * VFS and CommandContext shape.
 */

import type { CommandFn } from "../types";
import { readTextOrEmpty } from "../helpers";

export const cmdTee: CommandFn = async (ctx) => {
	let append = false;
	const files: string[] = [];
	for (const a of ctx.args) {
		if (a === "-a" || a === "--append") { append = true; continue; }
		files.push(a);
	}
	const text = ctx.stdin ? await ctx.stdin.readAll() : "";
	ctx.stdout.write(text);
	for (const f of files) {
		try {
			if (append) {
				const existing = await readTextOrEmpty(ctx.vfs, f);
				await ctx.vfs.writeFile(f, existing + text);
			} else {
				await ctx.vfs.writeFile(f, text);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			ctx.stderr.write(`tee: ${f}: ${msg}\n`);
			return 1;
		}
	}
	return 0;
};

/**
 * xargs: read stdin, build and execute command(s) per-batch using our own
 * dispatcher. Unlike LIFO's version which just prints constructed command
 * lines, this actually invokes the commands via the shared registry.
 */
export const cmdXargs: CommandFn = async (ctx) => {
	let maxArgs = 0; // 0 = all at once
	let replaceStr: string | null = null;
	let nullSep = false;
	const cmdTokens: string[] = [];
	let i = 0;
	while (i < ctx.args.length) {
		const a = ctx.args.at(i);
		if (a === undefined) break;
		if (a === "-n" && i + 1 < ctx.args.length) { maxArgs = Number(ctx.args.at(++i)); i++; continue; }
		if (a === "-I" && i + 1 < ctx.args.length) { replaceStr = ctx.args.at(++i) ?? null; i++; continue; }
		if (a === "-0" || a === "--null") { nullSep = true; i++; continue; }
		cmdTokens.push(...ctx.args.slice(i));
		break;
	}
	if (cmdTokens.length === 0) cmdTokens.push("echo");

	const raw = ctx.stdin ? await ctx.stdin.readAll() : "";
	const items = nullSep
		? raw.split("\0").filter(Boolean)
		: raw.split(/\s+/).filter(Boolean);
	if (items.length === 0) return 0;

	const runOne = (argv: string[]): Promise<number> =>
		ctx.runCommand(argv);

	if (replaceStr) {
		// Hoist into a const so the .map() closure carries the narrowed string type.
		const sep = replaceStr;
		for (const item of items) {
			if (ctx.signal.aborted) return 130;
			const expanded = cmdTokens.map((t) => t.split(sep).join(item));
			const code = await runOne(expanded);
			if (code !== 0) return code;
		}
		return 0;
	}

	const batchSize = maxArgs > 0 ? maxArgs : items.length;
	for (let j = 0; j < items.length; j += batchSize) {
		if (ctx.signal.aborted) return 130;
		const batch = items.slice(j, j + batchSize);
		const code = await runOne([...cmdTokens, ...batch]);
		if (code !== 0) return code;
	}
	return 0;
};
