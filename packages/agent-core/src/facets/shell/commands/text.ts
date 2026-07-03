/**
 * Text-processing commands: sort, uniq, cut, tr, nl, rev, tac.
 *
 * Structure and logic adapted from LIFO OS
 * (`packages/core/src/commands/text/*.ts`, MIT-licensed), ported to our async
 * VFS and CommandContext shape.
 */

import type { CommandFn } from "../types";
import { parseArgv } from "../argv";
import { collectTextInput, splitLines } from "../helpers";

export const cmdSort: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "sort",
		flags: [
			{ name: "r", short: ["r"], long: ["reverse"], type: "boolean" },
			{ name: "n", short: ["n"], long: ["numeric-sort"], type: "boolean" },
			{ name: "u", short: ["u"], long: ["unique"], type: "boolean" },
			{ name: "f", short: ["f"], long: ["ignore-case"], type: "boolean" },
			{ name: "k", short: ["k"], long: ["key"], type: "number", default: 0 },
			{ name: "t", short: ["t"], long: ["field-separator"], type: "string", default: "" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	const text = await collectTextInput(ctx, positional, "sort");
	if (text === null) return 1;

	const sep = flags.t ? new RegExp(flags.t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /\s+/;
	const getKey = (line: string): string => {
		const raw = flags.k > 0
			? (line.split(sep)[flags.k - 1] ?? "")
			: line;
		return flags.f ? raw.toLowerCase() : raw;
	};

	let lines = splitLines(text);
	if (ctx.signal.aborted) return 130;
	lines.sort((a, b) => {
		const ka = getKey(a);
		const kb = getKey(b);
		let cmp: number;
		if (flags.n) cmp = (parseFloat(ka) || 0) - (parseFloat(kb) || 0);
		else cmp = ka.localeCompare(kb);
		return flags.r ? -cmp : cmp;
	});
	if (flags.u) lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
	if (ctx.signal.aborted) return 130;

	ctx.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
	return 0;
};

export const cmdUniq: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "uniq",
		flags: [
			{ name: "c", short: ["c"], long: ["count"], type: "boolean" },
			{ name: "d", short: ["d"], long: ["repeated"], type: "boolean" },
			{ name: "u", short: ["u"], long: ["unique"], type: "boolean" },
			{ name: "i", short: ["i"], long: ["ignore-case"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	const text = await collectTextInput(ctx, positional, "uniq");
	if (text === null) return 1;

	const lines = splitLines(text);
	const groups: { line: string; count: number }[] = [];
	const norm = (s: string) => flags.i ? s.toLowerCase() : s;
	for (const line of lines) {
		const last = groups[groups.length - 1];
		if (last && norm(last.line) === norm(line)) last.count++;
		else groups.push({ line, count: 1 });
	}
	for (const g of groups) {
		if (ctx.signal.aborted) return 130;
		if (flags.d && g.count < 2) continue;
		if (flags.u && g.count > 1) continue;
		ctx.stdout.write(flags.c ? `${String(g.count).padStart(7)} ${g.line}\n` : `${g.line}\n`);
	}
	return 0;
};

export const cmdCut: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "cut",
		flags: [
			{ name: "d", short: ["d"], long: ["delimiter"], type: "string", default: "\t" },
			{ name: "f", short: ["f"], long: ["fields"], type: "string", default: "" },
			{ name: "c", short: ["c"], long: ["characters"], type: "string", default: "" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	if (!flags.f && !flags.c) {
		ctx.stderr.write("cut: you must specify -f (fields) or -c (characters)\n");
		return 1;
	}

	const spec = flags.f || flags.c;
	const indices: number[] = [];
	for (const part of spec.split(",")) {
		const m = part.match(/^(\d+)(?:-(\d+))?$/);
		if (!m) continue;
		const start = Number(m[1]);
		const end = m[2] !== undefined ? Number(m[2]) : start;
		for (let i = start; i <= end; i++) indices.push(i);
	}

	const text = await collectTextInput(ctx, positional, "cut");
	if (text === null) return 1;

	const emit = (line: string): string => {
		if (flags.c) {
			return indices.map((i) => line[i - 1] ?? "").join("");
		}
		const parts = line.split(flags.d);
		return indices.map((i) => parts[i - 1] ?? "").join(flags.d);
	};

	const lines = splitLines(text);
	for (const line of lines) {
		if (ctx.signal.aborted) return 130;
		ctx.stdout.write(emit(line) + "\n");
	}
	return 0;
};

function expandCharSet(set: string): string {
	let result = "";
	let i = 0;
	while (i < set.length) {
		if (i + 2 < set.length && set.charAt(i + 1) === "-") {
			const start = set.charCodeAt(i);
			const end = set.charCodeAt(i + 2);
			for (let c = start; c <= end; c++) result += String.fromCharCode(c);
			i += 3;
		} else {
			result += set.charAt(i);
			i++;
		}
	}
	return result;
}

export const cmdTr: CommandFn = async (ctx) => {
	let deleteMode = false;
	let squeezeMode = false;
	const sets: string[] = [];
	for (const a of ctx.args) {
		if (a === "-d") { deleteMode = true; continue; }
		if (a === "-s") { squeezeMode = true; continue; }
		sets.push(a);
	}
	if (sets.length === 0) { ctx.stderr.write("tr: missing operand\n"); return 1; }
	if (!ctx.stdin) { ctx.stderr.write("tr: requires stdin\n"); return 1; }
	const text = await ctx.stdin.readAll();
	const set1 = expandCharSet(sets.at(0) ?? "");

	// Collect into arrays and join — V8 can degrade `out += ch` to O(n²) for
	// large inputs.
	if (deleteMode) {
		const drop = new Set(set1);
		const parts: string[] = [];
		for (const ch of text) if (!drop.has(ch)) parts.push(ch);
		ctx.stdout.write(parts.join(""));
		return 0;
	}

	if (squeezeMode && sets.length === 1) {
		const squeeze = new Set(set1);
		const parts: string[] = [];
		let last = "";
		for (const ch of text) {
			if (squeeze.has(ch) && ch === last) continue;
			parts.push(ch);
			last = ch;
		}
		ctx.stdout.write(parts.join(""));
		return 0;
	}

	if (sets.length < 2) { ctx.stderr.write("tr: missing second operand\n"); return 1; }
	const set2 = expandCharSet(sets.at(1) ?? "");
	const map = new Map<string, string>();
	for (let i = 0; i < set1.length; i++) {
		map.set(set1.charAt(i), set2.charAt(Math.min(i, set2.length - 1)));
	}
	const translated: string[] = [];
	for (const ch of text) translated.push(map.get(ch) ?? ch);
	if (squeezeMode) {
		const squeeze = new Set(set2);
		const sq: string[] = [];
		let last = "";
		for (const ch of translated) {
			if (squeeze.has(ch) && ch === last) continue;
			sq.push(ch);
			last = ch;
		}
		ctx.stdout.write(sq.join(""));
	} else {
		ctx.stdout.write(translated.join(""));
	}
	return 0;
};

export const cmdNl: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "nl",
		flags: [
			{ name: "b", short: ["b"], long: ["body-numbering"], type: "string", default: "t" },
			{ name: "w", short: ["w"], long: ["number-width"], type: "number", default: 6 },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	const text = await collectTextInput(ctx, positional, "nl");
	if (text === null) return 1;
	const lines = splitLines(text);
	let n = 1;
	for (const line of lines) {
		if (ctx.signal.aborted) return 130;
		const shouldNumber = flags.b === "a" || (flags.b === "t" && line.length > 0);
		if (shouldNumber) {
			ctx.stdout.write(`${String(n).padStart(flags.w, " ")}\t${line}\n`);
			n++;
		} else {
			ctx.stdout.write(`${" ".repeat(flags.w)}\t${line}\n`);
		}
	}
	return 0;
};

export const cmdRev: CommandFn = async (ctx) => {
	const text = await collectTextInput(ctx, ctx.args, "rev");
	if (text === null) return 1;
	const lines = splitLines(text);
	for (const line of lines) {
		if (ctx.signal.aborted) return 130;
		ctx.stdout.write([...line].reverse().join("") + "\n");
	}
	return 0;
};

export const cmdTac: CommandFn = async (ctx) => {
	const text = await collectTextInput(ctx, ctx.args, "tac");
	if (text === null) return 1;
	const lines = splitLines(text);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (ctx.signal.aborted) return 130;
		ctx.stdout.write(lines[i] + "\n");
	}
	return 0;
};
