import type { CommandFn } from "../types";
import { parseArgv } from "../argv";
import { formatDate, readTextFileForCmd, vfsErrorMessage } from "../helpers";
import { isBinaryFile } from "../mime";

export const cmdStat: CommandFn = async (ctx) => {
	if (ctx.args.length === 0) { ctx.stderr.write("stat: missing operand\n"); return 1; }
	let exit = 0;
	for (const p of ctx.args) {
		try {
			const st = await ctx.vfs.stat(p);
			ctx.stdout.write(
				`  File: ${p}\n` +
				`  Size: ${st.size}\tType: ${st.type}\n` +
				`  Modified: ${formatDate(st.mtimeMs)}\n`,
			);
		} catch (e) {
			ctx.stderr.write(`stat: ${vfsErrorMessage(e, p)}\n`);
			exit = 1;
		}
	}
	return exit;
};

export const cmdWc: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "wc",
		flags: [
			{ name: "l", short: ["l"], long: ["lines"], type: "boolean" },
			{ name: "w", short: ["w"], long: ["words"], type: "boolean" },
			{ name: "c", short: ["c"], long: ["bytes"], type: "boolean" },
			{ name: "m", short: ["m"], long: ["chars"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	const anyFlag = flags.l || flags.w || flags.c || flags.m;
	const showLines = flags.l || !anyFlag;
	const showWords = flags.w || !anyFlag;
	const showBytes = flags.c || (!anyFlag && !flags.m);
	const showChars = flags.m;

	let totalL = 0, totalW = 0, totalB = 0, totalM = 0;

	const format = (lines: number, words: number, bytes: number, chars: number, label: string): string => {
		const parts: string[] = [];
		if (showLines) parts.push(String(lines).padStart(7));
		if (showWords) parts.push(String(words).padStart(7));
		if (showBytes) parts.push(String(bytes).padStart(7));
		if (showChars) parts.push(String(chars).padStart(7));
		return parts.join("") + (label ? ` ${label}` : "");
	};

	const count = (text: string): { lines: number; words: number; bytes: number; chars: number } => {
		const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
		const words = text.split(/\s+/).filter(Boolean).length;
		const bytes = new TextEncoder().encode(text).length;
		const chars = text.length;
		return { lines, words, bytes, chars };
	};

	if (positional.length === 0) {
		if (!ctx.stdin) { ctx.stderr.write("wc: missing file operand\n"); return 1; }
		const c = count(await ctx.stdin.readAll());
		ctx.stdout.write(format(c.lines, c.words, c.bytes, c.chars, "") + "\n");
		return 0;
	}

	let exit = 0;
	for (const f of positional) {
		if (isBinaryFile(f)) {
			// wc on binary is usually bytes-only; keep it simple
			try {
				const raw = await ctx.vfs.readFile(f);
				const bytes = typeof raw === "string" ? new TextEncoder().encode(raw).length : raw.byteLength;
				ctx.stdout.write(format(0, 0, bytes, bytes, f) + "\n");
			} catch (e) {
				ctx.stderr.write(`wc: ${vfsErrorMessage(e, f)}\n`);
				exit = 1;
			}
			continue;
		}
		const content = await readTextFileForCmd(ctx, f, "wc");
		if (content === null) { exit = 1; continue; }
		const c = count(content);
		totalL += c.lines; totalW += c.words; totalB += c.bytes; totalM += c.chars;
		ctx.stdout.write(format(c.lines, c.words, c.bytes, c.chars, f) + "\n");
	}
	if (positional.length > 1) {
		ctx.stdout.write(format(totalL, totalW, totalB, totalM, "total") + "\n");
	}
	return exit;
};
