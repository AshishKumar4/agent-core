import type { CommandFn } from "../types";
import { parseArgv } from "../argv";
import { readTextFileForCmd, splitLines } from "../helpers";

export const cmdCat: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "cat",
		flags: [
			{ name: "n", short: ["n"], long: ["number"], type: "boolean" },
			{ name: "b", short: ["b"], long: ["number-nonblank"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	const addNumbers = (text: string): string => {
		if (!flags.n && !flags.b) return text;
		const lines = text.split("\n");
		let counter = 0;
		return lines.map((line) => {
			if (flags.b && line.trim() === "") return line;
			counter++;
			return `${String(counter).padStart(6, " ")}\t${line}`;
		}).join("\n");
	};

	if (positional.length === 0) {
		if (!ctx.stdin) { ctx.stderr.write("cat: missing operand\n"); return 1; }
		ctx.stdout.write(addNumbers(await ctx.stdin.readAll()));
		return 0;
	}

	let exit = 0;
	for (const f of positional) {
		const content = await readTextFileForCmd(ctx, f, "cat");
		if (content === null) { exit = 1; continue; }
		ctx.stdout.write(addNumbers(content));
	}
	return exit;
};

// head and tail share an almost-identical structure. Parametrize over the
// slicing function and let the flag spec drive the command name.
const sliceCommand = (cmdName: "head" | "tail", slice: (lines: string[], count: number) => string[]): CommandFn =>
	async (ctx) => {
		const { flags, positional, error } = parseArgv(ctx.args, {
			command: cmdName,
			numericShortcut: { target: "n" },
			flags: [
				{ name: "n", short: ["n"], long: ["lines"], type: "number", default: 10 },
				{ name: "q", short: ["q"], long: ["quiet", "silent"], type: "boolean" },
				{ name: "v", short: ["v"], long: ["verbose"], type: "boolean" },
			],
		});
		if (error) { ctx.stderr.write(error + "\n"); return 2; }

		const count = flags.n;
		const emit = (text: string, label = "", showHeader = false): void => {
			if (showHeader && label) ctx.stdout.write(`==> ${label} <==\n`);
			// head uses raw lines (preserves trailing newline state); tail drops empty trailing entry
			const lines = cmdName === "tail" ? splitLines(text) : text.split("\n");
			const selected = slice(lines, count);
			const out = selected.join("\n");
			ctx.stdout.write(out);
			if (cmdName === "head" ? lines.length > count : selected.length > 0) ctx.stdout.write("\n");
		};

		if (positional.length === 0) {
			if (!ctx.stdin) { ctx.stderr.write(`${cmdName}: missing operand\n`); return 1; }
			emit(await ctx.stdin.readAll());
			return 0;
		}

		const showHeaders = !flags.q && (flags.v || positional.length > 1);
		let exit = 0;
		for (let i = 0; i < positional.length; i++) {
			const f = positional.at(i);
			if (f === undefined) continue;
			const content = await readTextFileForCmd(ctx, f, cmdName);
			if (content === null) { exit = 1; continue; }
			if (showHeaders && i > 0) ctx.stdout.write("\n");
			emit(content, f, showHeaders);
		}
		return exit;
	};

export const cmdHead: CommandFn = sliceCommand("head", (lines, n) => lines.slice(0, n));
export const cmdTail: CommandFn = sliceCommand("tail", (lines, n) => lines.slice(Math.max(0, lines.length - n)));
