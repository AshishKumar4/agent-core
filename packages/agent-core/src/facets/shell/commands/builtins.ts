/**
 * Tiny single-purpose commands that don't warrant their own files.
 *
 * Everything here is a pure transform over args / env — no VFS interaction,
 * no dispatcher coupling. Grouped together to reduce navigation overhead.
 * Commands that touch the VFS (tee) or re-enter dispatch (xargs) live in `io.ts`.
 *
 * printf / date / seq / yes logic adapted from LIFO OS
 * (`packages/core/src/commands/{io,system,text}/`, MIT-licensed).
 */

import type { CommandFn } from "../types";

// ---------------------------------------------------------------------------
// Exit-code primitives
// ---------------------------------------------------------------------------

export const cmdTrue: CommandFn = async () => 0;
export const cmdFalse: CommandFn = async () => 1;

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

export const cmdPwd: CommandFn = async (ctx) => {
	// This shell is rootless — paths are relative to the workspace VFS root.
	// Emit "." to stay POSIX-shaped while honoring that model.
	ctx.stdout.write(".\n");
	return 0;
};

export const cmdBasename: CommandFn = async (ctx) => {
	if (ctx.args.length === 0) { ctx.stderr.write("basename: missing operand\n"); return 1; }
	const name = ctx.args.at(0) ?? "";
	const suffix = ctx.args.at(1);
	const idx = name.lastIndexOf("/");
	let base = idx === -1 ? name : name.slice(idx + 1);
	if (suffix && base.endsWith(suffix) && base !== suffix) base = base.slice(0, -suffix.length);
	ctx.stdout.write(base + "\n");
	return 0;
};

export const cmdDirname: CommandFn = async (ctx) => {
	if (ctx.args.length === 0) { ctx.stderr.write("dirname: missing operand\n"); return 1; }
	for (const arg of ctx.args) {
		const idx = arg.lastIndexOf("/");
		ctx.stdout.write((idx <= 0 ? (arg.startsWith("/") ? "/" : ".") : arg.slice(0, idx)) + "\n");
	}
	return 0;
};

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

// Bounded yes to prevent runaway output. Real yes is infinite; agents don't need that.
const YES_MAX_LINES = 10_000;

// Matches YES_MAX_LINES; keeps runaway ranges (seq 1 1000000000) from OOMing the worker.
const SEQ_MAX = 10_000;

export const cmdYes: CommandFn = async (ctx) => {
	const text = ctx.args.length > 0 ? ctx.args.join(" ") : "y";
	let count = 0;
	while (count < YES_MAX_LINES && !ctx.signal.aborted) {
		ctx.stdout.write(text + "\n");
		count++;
	}
	return ctx.signal.aborted ? 130 : 0;
};

export const cmdSeq: CommandFn = async (ctx) => {
	const args = ctx.args;
	let separator = "\n";
	let equalWidth = false;
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const argument = args.at(i);
		if (argument === undefined) continue;
		if (argument === "-s" && i + 1 < args.length) { separator = args.at(++i) ?? ""; continue; }
		if (argument === "-w") { equalWidth = true; continue; }
		positional.push(argument);
	}
	if (positional.length === 0) { ctx.stderr.write("seq: missing operand\n"); return 1; }
	let first = 1, increment = 1, last: number;
	if (positional.length === 1) last = parseFloat(positional.at(0) ?? "");
	else if (positional.length === 2) { first = parseFloat(positional.at(0) ?? ""); last = parseFloat(positional.at(1) ?? ""); }
	else { first = parseFloat(positional.at(0) ?? ""); increment = parseFloat(positional.at(1) ?? ""); last = parseFloat(positional.at(2) ?? ""); }

	if (!Number.isFinite(first) || !Number.isFinite(increment) || !Number.isFinite(last)) {
		ctx.stderr.write("seq: invalid argument\n"); return 1;
	}
	if (increment === 0) { ctx.stderr.write("seq: zero increment\n"); return 1; }

	const isInt = Number.isInteger(first) && Number.isInteger(increment) && Number.isInteger(last);

	const span = increment > 0 ? (last - first) / increment : (first - last) / -increment;
	const expectedSteps = Number.isFinite(span) && span >= 0 ? Math.floor(span + 1e-10) + 1 : 0;
	if (expectedSteps > SEQ_MAX) {
		ctx.stderr.write(`seq: sequence too long (${expectedSteps} steps; max ${SEQ_MAX}). Narrow the range or use sandbox_exec.\n`);
		return 1;
	}

	const results: string[] = [];
	if (increment > 0) {
		for (let n = first; n <= last + 1e-10; n += increment) {
			if (ctx.signal.aborted) return 130;
			results.push(isInt ? String(Math.round(n)) : String(n));
		}
	} else {
		for (let n = first; n >= last - 1e-10; n += increment) {
			if (ctx.signal.aborted) return 130;
			results.push(isInt ? String(Math.round(n)) : String(n));
		}
	}
	if (results.length === 0) return 0;
	const out = equalWidth && isInt
		? (() => { const w = Math.max(...results.map((r) => r.length)); return results.map((r) => r.padStart(w, "0")); })()
		: results;
	ctx.stdout.write(out.join(separator) + "\n");
	return 0;
};

// ---------------------------------------------------------------------------
// printf — limited subset: %s, %d, %i, %f, %x, %o, plus \n \t \r \\ \0 escapes
// ---------------------------------------------------------------------------

function processPrintfFormat(format: string, args: string[]): string {
	let result = "";
	let argIdx = 0;
	let i = 0;
	while (i < format.length) {
		if (format.charAt(i) === "\\") {
			i++;
			if (i >= format.length) break;
			switch (format.charAt(i)) {
				case "n": result += "\n"; break;
				case "t": result += "\t"; break;
				case "r": result += "\r"; break;
				case "\\": result += "\\"; break;
				case "0": result += "\0"; break;
				default: result += "\\" + format.charAt(i); break;
			}
			i++;
		} else if (format.charAt(i) === "%") {
			i++;
			if (i >= format.length) break;
			if (format.charAt(i) === "%") { result += "%"; i++; continue; }
			const arg = args[argIdx++] ?? "";
			switch (format.charAt(i)) {
				case "s": result += arg; break;
				case "d": case "i": result += String(parseInt(arg, 10) || 0); break;
				case "f": result += String(parseFloat(arg) || 0); break;
				case "x": result += (parseInt(arg, 10) || 0).toString(16); break;
				case "o": result += (parseInt(arg, 10) || 0).toString(8); break;
				default: result += "%" + format.charAt(i); break;
			}
			i++;
		} else {
			result += format.charAt(i);
			i++;
		}
	}
	return result;
}

export const cmdPrintf: CommandFn = async (ctx) => {
	if (ctx.args.length === 0) { ctx.stderr.write("printf: missing format string\n"); return 1; }
	ctx.stdout.write(processPrintfFormat(ctx.args.at(0) ?? "", ctx.args.slice(1)));
	return 0;
};

// ---------------------------------------------------------------------------
// date — accepts `+FORMAT` with a small strftime-like subset
// ---------------------------------------------------------------------------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

function pad(n: number, len = 2): string { return String(n).padStart(len, "0"); }

function formatDate(fmt: string, d: Date): string {
	let out = "";
	let i = 0;
	while (i < fmt.length) {
		if (fmt.charAt(i) === "%" && i + 1 < fmt.length) {
			i++;
			switch (fmt.charAt(i)) {
				case "Y": out += d.getFullYear(); break;
				case "m": out += pad(d.getMonth() + 1); break;
				case "d": out += pad(d.getDate()); break;
				case "H": out += pad(d.getHours()); break;
				case "M": out += pad(d.getMinutes()); break;
				case "S": out += pad(d.getSeconds()); break;
				case "A": out += DAYS.at(d.getDay()) ?? ""; break;
				case "B": out += MONTHS.at(d.getMonth()) ?? ""; break;
				case "s": out += Math.floor(d.getTime() / 1000); break;
				case "p": out += d.getHours() >= 12 ? "PM" : "AM"; break;
				case "%": out += "%"; break;
				default: out += "%" + fmt.charAt(i); break;
			}
			i++;
		} else {
			out += fmt.charAt(i);
			i++;
		}
	}
	return out;
}

export const cmdDate: CommandFn = async (ctx) => {
	const now = new Date();
	const format = ctx.args.at(0);
	if (format !== undefined && format.startsWith("+")) {
		ctx.stdout.write(formatDate(format.slice(1), now) + "\n");
	} else {
		ctx.stdout.write(now.toISOString() + "\n");
	}
	return 0;
};
