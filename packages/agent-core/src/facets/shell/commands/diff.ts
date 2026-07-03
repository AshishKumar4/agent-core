/**
 * Line-based diff. Adapted from LIFO OS (`packages/core/src/commands/text/diff.ts`, MIT).
 * Exit codes: 0 = identical, 1 = differ, 2 = error.
 */

import type { CommandFn } from "../types";
import { parseArgv } from "../argv";
import { readTextFileForCmd } from "../helpers";
import { isBinaryFile } from "../mime";

// Per-file cap chosen so the LCS DP matrix (Uint16Array) stays under 8 MB —
// well below Workers' 128 MB heap limit, with room for other in-flight
// allocations. 2000×2000×2 bytes = 8 MB; 2000 < 65535 so cell counts fit
// cleanly in uint16.
const MAX_LCS_LINES = 2000;

/**
 * Edit-script step used by `computeLCS` and both output formatters.
 * - `keep`   — line is present in both old and new (unchanged).
 * - `delete` — line exists only on the old side and is being removed.
 * - `insert` — line exists only on the new side and is being added.
 * Each variant carries only the side(s) it owns, so consumers narrow via
 * `op.type` without non-null assertions.
 */
type EditOp =
	| { type: "keep"; line: string }
	| { type: "delete"; oldLine: string }
	| { type: "insert"; newLine: string };

/**
 * Standard LCS edit-script computation. The DP matrix is backed by a single
 * `Uint16Array` of `(m+1)(n+1)` cells rather than a nested `number[][]`
 * — that's ~4x smaller and one contiguous allocation, so we stay well under
 * the Worker heap budget even near the cap. Counts cap at `MAX_LCS_LINES`
 * which is far below the `Uint16Array` ceiling (65535), so no overflow risk.
 *
 * Time: O(m·n). Space: O(m·n) cells of 2 bytes each.
 */
function computeLCS(a: string[], b: string[]): EditOp[] {
	const m = a.length, n = b.length;
	const width = n + 1;
	const dp = new Uint16Array((m + 1) * width);
	const cell = (index: number): number => dp.at(index) ?? 0;
	for (let i = 1; i <= m; i++) {
		const row = i * width;
		const prev = (i - 1) * width;
		for (let j = 1; j <= n; j++) {
			if (a.at(i - 1) === b.at(j - 1)) dp[row + j] = cell(prev + j - 1) + 1;
			else {
				const up = cell(prev + j);
				const left = cell(row + j - 1);
				dp[row + j] = up > left ? up : left;
			}
		}
	}
	const ops: EditOp[] = [];
	let i = m, j = n;
	while (i > 0 || j > 0) {
		const oldLine = a.at(i - 1);
		const newLine = b.at(j - 1);
		if (i > 0 && j > 0 && oldLine !== undefined && oldLine === newLine) {
			ops.push({ type: "keep", line: oldLine });
			i--; j--;
		} else if (j > 0 && newLine !== undefined && (i === 0 || cell(i * width + (j - 1)) >= cell((i - 1) * width + j))) {
			ops.push({ type: "insert", newLine });
			j--;
		} else if (oldLine !== undefined) {
			ops.push({ type: "delete", oldLine });
			i--;
		} else {
			break;
		}
	}
	return ops.reverse();
}

function formatNormal(ops: EditOp[]): string {
	const out: string[] = [];
	let oldIdx = 0, newIdx = 0, i = 0;
	while (i < ops.length) {
		const op = ops.at(i);
		if (op === undefined) break;
		if (op.type === "keep") { oldIdx++; newIdx++; i++; continue; }
		const delStart = oldIdx;
		const insStart = newIdx;
		const delLines: string[] = [];
		const insLines: string[] = [];
		while (i < ops.length) {
			const cur = ops.at(i);
			if (cur === undefined || cur.type === "keep") break;
			if (cur.type === "delete") { delLines.push(cur.oldLine); oldIdx++; }
			else { insLines.push(cur.newLine); newIdx++; }
			i++;
		}
		const delRange = delLines.length === 1
			? `${delStart + 1}`
			: delLines.length > 0 ? `${delStart + 1},${delStart + delLines.length}` : `${delStart}`;
		const insRange = insLines.length === 1
			? `${insStart + 1}`
			: insLines.length > 0 ? `${insStart + 1},${insStart + insLines.length}` : `${insStart}`;
		if (delLines.length > 0 && insLines.length > 0) {
			out.push(`${delRange}c${insRange}`);
			for (const l of delLines) out.push(`< ${l}`);
			out.push("---");
			for (const l of insLines) out.push(`> ${l}`);
		} else if (delLines.length > 0) {
			out.push(`${delRange}d${insRange}`);
			for (const l of delLines) out.push(`< ${l}`);
		} else {
			out.push(`${delRange}a${insRange}`);
			for (const l of insLines) out.push(`> ${l}`);
		}
	}
	return out.length > 0 ? out.join("\n") + "\n" : "";
}

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[]; }

type AnnotatedOp = { type: "keep" | "delete" | "insert"; line: string };

function annotateOps(ops: EditOp[]): AnnotatedOp[] {
	return ops.map((op) => {
		switch (op.type) {
			case "keep": return { type: "keep", line: op.line };
			case "delete": return { type: "delete", line: op.oldLine };
			case "insert": return { type: "insert", line: op.newLine };
		}
	});
}

/**
 * Render the edit script as a unified diff (`@@ -oldStart,oldCount +newStart,newCount @@`).
 * Walks `annotated` once, accumulating a hunk around each change plus `CTX`
 * lines of surrounding context. When two changes are >= `2·CTX + 1` lines apart
 * they split into separate hunks; closer changes stay in the same hunk.
 *
 * Implementation notes:
 * - `current` is eagerly initialized to a dummy `Hunk` value and gated by
 *   `currentLive` so TS narrows it to `Hunk` (not `Hunk | null`) throughout
 *   the loop — this avoids non-null assertions (RFC-009).
 * - `lastChange = -Infinity` is a "no change observed yet" sentinel so the
 *   very first change always opens a hunk (since `i - (-Infinity) > CTX*2+1`
 *   is trivially true). Using `-Infinity` rather than `-1` makes the intent
 *   explicit and avoids relying on `CTX` arithmetic wrap.
 * - `priorO[k]` / `priorN[k]` are prefix sums over `annotated[0..k)` counting
 *   old-side (non-insert) and new-side (non-delete) lines respectively. O(1)
 *   lookup at each hunk start replaces the former O(n-per-hunk) `countPrior`
 *   scan, so total work stays O(n) even with many hunks.
 */
function formatUnified(ops: EditOp[], file1: string, file2: string): string {
	if (ops.every((o) => o.type === "keep")) return "";
	const annotated = annotateOps(ops);

	const CTX = 3;
	const hunks: Hunk[] = [];
	let current: Hunk = { oldStart: 0, newStart: 0, oldCount: 0, newCount: 0, lines: [] };
	let currentLive = false;
	let lastChange = -Infinity;

	const priorO = Array.from({ length: annotated.length + 1 }, () => 0);
	const priorN = Array.from({ length: annotated.length + 1 }, () => 0);
	for (let j = 0; j < annotated.length; j++) {
		const annotatedOp = annotated.at(j);
		if (annotatedOp === undefined) continue;
		priorO[j + 1] = (priorO.at(j) ?? 0) + (annotatedOp.type !== "insert" ? 1 : 0);
		priorN[j + 1] = (priorN.at(j) ?? 0) + (annotatedOp.type !== "delete" ? 1 : 0);
	}

	const pushContextFromRange = (start: number, endExclusive: number): void => {
		for (let j = start; j < endExclusive && j < annotated.length; j++) {
			const annotatedOp = annotated.at(j);
			if (annotatedOp?.type === "keep") {
				current.lines.push(` ${annotatedOp.line}`);
				current.oldCount++;
				current.newCount++;
			}
		}
	};

	for (let i = 0; i < annotated.length; i++) {
		const a = annotated.at(i);
		if (a === undefined || a.type === "keep") continue;
		if (!currentLive || i - lastChange > CTX * 2 + 1) {
			if (currentLive) {
				pushContextFromRange(lastChange + 1, lastChange + 1 + CTX);
				hunks.push(current);
			}
			const ctxStart = Math.max(0, i - CTX);
			current = { oldStart: (priorO.at(ctxStart) ?? 0) + 1, newStart: (priorN.at(ctxStart) ?? 0) + 1, oldCount: 0, newCount: 0, lines: [] };
			currentLive = true;
			pushContextFromRange(ctxStart, i);
		} else if (i - lastChange > 1) {
			pushContextFromRange(lastChange + 1, i);
		}
		if (a.type === "delete") { current.lines.push(`-${a.line}`); current.oldCount++; }
		else { current.lines.push(`+${a.line}`); current.newCount++; }
		lastChange = i;
	}
	if (currentLive) {
		pushContextFromRange(lastChange + 1, lastChange + 1 + CTX);
		hunks.push(current);
	}

	const out: string[] = [];
	out.push(`--- ${file1}`);
	out.push(`+++ ${file2}`);
	for (const h of hunks) {
		out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
		out.push(...h.lines);
	}
	return out.join("\n") + "\n";
}

export const cmdDiff: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "diff",
		flags: [{ name: "unified", short: ["u"], long: ["unified"], type: "boolean" }],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }
	if (positional.length < 2) { ctx.stderr.write("diff: missing operand\n"); return 2; }

	const file1 = positional.at(0) ?? "";
	const file2 = positional.at(1) ?? "";
	if (isBinaryFile(file1) || isBinaryFile(file2)) {
		ctx.stdout.write(`Binary files ${file1} and ${file2} differ\n`);
		return 2;
	}

	const content1 = await readTextFileForCmd(ctx, file1, "diff");
	if (content1 === null) return 2;
	const content2 = await readTextFileForCmd(ctx, file2, "diff");
	if (content2 === null) return 2;

	if (content1 === content2) return 0;

	const lines1 = content1.split("\n");
	const lines2 = content2.split("\n");
	if (lines1.at(-1) === "") lines1.pop();
	if (lines2.at(-1) === "") lines2.pop();

	if (lines1.length > MAX_LCS_LINES || lines2.length > MAX_LCS_LINES) {
		ctx.stderr.write(
			`diff: files too large for in-memory LCS ` +
			`(${file1}: ${lines1.length} lines, ${file2}: ${lines2.length} lines; max ${MAX_LCS_LINES} each).\n` +
			`Narrow with sed/head/tail, or run diff against the container via sandbox_exec.\n`,
		);
		return 2;
	}

	const ops = computeLCS(lines1, lines2);
	ctx.stdout.write(flags.unified ? formatUnified(ops, file1, file2) : formatNormal(ops));
	return 1;
};
