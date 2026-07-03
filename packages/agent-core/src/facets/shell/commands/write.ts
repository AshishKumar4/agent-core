import type { CommandFn } from "../types";
import { parseArgv } from "../argv";
import { FileErrorCode } from "../../filesystem/error";
import { errorCode, expensiveMountAdvisory, isImplicitRoot, vfsErrorMessage, walkFiltered } from "../helpers";

/** Top-level directories the agent should not blow away. */
const PROTECTED = new Set(["", "memory", "sessions", "shared", "sandbox"]);

export const cmdEcho: CommandFn = async (ctx) => {
	let noNewline = false;
	let interpret = false;
	const parts: string[] = [];
	for (const a of ctx.args) {
		if (a === "-n") { noNewline = true; continue; }
		if (a === "-e") { interpret = true; continue; }
		if (a === "-E") { interpret = false; continue; }
		parts.push(a);
	}
	let text = parts.join(" ");
	if (interpret) {
		text = text
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\r/g, "\r")
			.replace(/\\\\/g, "\\")
			.replace(/\\0/g, "\0");
	}
	ctx.stdout.write(noNewline ? text : text + "\n");
	return 0;
};

export const cmdMkdir: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "mkdir",
		flags: [
			{ name: "p", short: ["p"], long: ["parents"], type: "boolean" },
			{ name: "v", short: ["v"], long: ["verbose"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }
	if (positional.length === 0) { ctx.stderr.write("mkdir: missing operand\n"); return 1; }

	let exit = 0;
	for (const p of positional) {
		try {
			if (flags.p) {
				// Create every intermediate segment, swallowing EEXIST
				const segments = p.split("/").filter(Boolean);
				for (let i = 0; i < segments.length; i++) {
					const partial = segments.slice(0, i + 1).join("/");
					try { await ctx.vfs.mkdir(partial); }
					catch (e) {
						if (errorCode(e) !== FileErrorCode.alreadyExists) throw e;
					}
					if (flags.v) ctx.stdout.write(`mkdir: created directory '${partial}'\n`);
				}
			} else {
				await ctx.vfs.mkdir(p);
				if (flags.v) ctx.stdout.write(`mkdir: created directory '${p}'\n`);
			}
		} catch (e) {
			ctx.stderr.write(`mkdir: ${vfsErrorMessage(e, p)}\n`);
			exit = 1;
		}
	}
	return exit;
};

export const cmdTouch: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "touch",
		flags: [{ name: "c", short: ["c"], long: ["no-create"], type: "boolean" }],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }
	if (positional.length === 0) { ctx.stderr.write("touch: missing operand\n"); return 1; }

	let exit = 0;
	for (const p of positional) {
		try {
			const exists = await ctx.vfs.exists(p);
			if (!exists && flags.c) continue;
			if (!exists) await ctx.vfs.writeFile(p, "");
		} catch (e) {
			ctx.stderr.write(`touch: ${vfsErrorMessage(e, p)}\n`);
			exit = 1;
		}
	}
	return exit;
};

export const cmdRm: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "rm",
		flags: [
			{ name: "r", short: ["r", "R"], long: ["recursive"], type: "boolean" },
			{ name: "f", short: ["f"], long: ["force"], type: "boolean" },
			{ name: "v", short: ["v"], long: ["verbose"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }
	if (positional.length === 0) {
		if (flags.f) return 0;
		ctx.stderr.write("rm: missing operand\n"); return 1;
	}

	let exit = 0;
	for (const p of positional) {
		if (PROTECTED.has(p)) {
			ctx.stderr.write(`rm: cannot remove '${p}': Protected system path\n`);
			exit = 1;
			continue;
		}
		try {
			if (flags.r) await ctx.vfs.removeRecursive(p);
			else await ctx.vfs.unlink(p);
			if (flags.v) ctx.stdout.write(`removed '${p}'\n`);
		} catch (e) {
			if (flags.f) continue;
			ctx.stderr.write(`rm: ${vfsErrorMessage(e, p)}\n`);
			exit = 1;
		}
	}
	return exit;
};

export const cmdCp: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "cp",
		flags: [
			{ name: "r", short: ["r", "R"], long: ["recursive"], type: "boolean" },
			{ name: "v", short: ["v"], long: ["verbose"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }
	if (positional.length < 2) { ctx.stderr.write("cp: missing destination operand\n"); return 1; }

	const dest = positional.at(-1) ?? "";
	const sources = positional.slice(0, -1);

	// If destination exists and is a dir, copy INTO it
	let destIsDir = false;
	try { destIsDir = (await ctx.vfs.stat(dest)).isDirectory(); } catch { /* may not exist yet */ }

	for (const src of sources) {
		let srcIsDir = false;
		try { srcIsDir = (await ctx.vfs.stat(src)).isDirectory(); }
		catch (e) {
			ctx.stderr.write(`cp: ${vfsErrorMessage(e, src)}\n`);
			return 1;
		}

		if (srcIsDir) {
			if (!flags.r) { ctx.stderr.write(`cp: -r not specified; omitting directory '${src}'\n`); return 1; }
			const targetRoot = destIsDir ? `${dest}/${basenameOf(src)}` : dest;
			const aborted = await copyDir(ctx, src, targetRoot);
			if (aborted) return 130;
			if (flags.v) ctx.stdout.write(`copied '${src}' -> '${targetRoot}'\n`);
		} else {
			const target = destIsDir ? `${dest}/${basenameOf(src)}` : dest;
			try {
				const data = await ctx.vfs.readFile(src);
				await ctx.vfs.writeFile(target, data);
				if (flags.v) ctx.stdout.write(`'${src}' -> '${target}'\n`);
			} catch (e) {
				ctx.stderr.write(`cp: ${vfsErrorMessage(e, src)}\n`);
				return 1;
			}
		}
	}
	return 0;
};

function basenameOf(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Recursively copy `src/**` into `dest/`. Returns true if aborted mid-walk so
 * the caller can propagate exit 130; throws on other errors.
 *
 * When `src` is an implicit root (`.` or empty), expensive mounts are skipped
 * with a stderr advisory — same policy as grep/find/ls -R/tree. Explicit
 * sources (`cp -r sandbox/foo dest/`) walk normally.
 */
async function copyDir(ctx: Parameters<CommandFn>[0], src: string, dest: string): Promise<boolean> {
	if (ctx.signal.aborted) return true;
	try { await ctx.vfs.mkdir(dest); }
	catch (e) { if (errorCode(e) !== FileErrorCode.alreadyExists) throw e; }

	const implicitRoot = isImplicitRoot(src);
	const advised = new Set<string>();
	const emitAdvisory = (mount: string) => {
		if (advised.has(mount)) return;
		advised.add(mount);
		ctx.stderr.write(expensiveMountAdvisory("cp", mount));
	};

	for await (const e of walkFiltered(ctx.vfs, src, {
		maxDepth: 50,
		maxEntries: 5000,
		includeDirs: true,
		signal: ctx.signal,
		excludeMounts: implicitRoot ? ctx.expensivePaths : undefined,
		onExcludeMount: implicitRoot ? emitAdvisory : undefined,
	})) {
		if (ctx.signal.aborted) return true;
		const srcPrefix = src === "" || src === "." ? "" : src + "/";
		const rel = srcPrefix && e.path.startsWith(srcPrefix) ? e.path.slice(srcPrefix.length) : e.path;
		const target = rel ? `${dest}/${rel}` : dest;
		if (e.stat.isDirectory()) {
			try { await ctx.vfs.mkdir(target); }
			catch (err) { if (errorCode(err) !== FileErrorCode.alreadyExists) throw err; }
		} else {
			const data = await ctx.vfs.readFile(e.path);
			await ctx.vfs.writeFile(target, data);
		}
	}
	// walkFiltered returns early without yielding when aborted, so a post-loop
	// check catches "aborted mid-walk before any yield" too.
	if (ctx.signal.aborted) return true;
	return false;
}

export const cmdMv: CommandFn = async (ctx) => {
	const { positional, error } = parseArgv(ctx.args, {
		command: "mv",
		flags: [
			{ name: "f", short: ["f"], long: ["force"], type: "boolean" },
			{ name: "n", short: ["n"], long: ["no-clobber"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }
	if (positional.length < 2) { ctx.stderr.write("mv: missing destination operand\n"); return 1; }

	const dest = positional.at(-1) ?? "";
	const sources = positional.slice(0, -1);
	let destIsDir = false;
	try { destIsDir = (await ctx.vfs.stat(dest)).isDirectory(); } catch { /* ok */ }

	for (const src of sources) {
		const target = destIsDir ? `${dest}/${basenameOf(src)}` : dest;
		try {
			await ctx.vfs.rename(src, target);
		} catch (e) {
			ctx.stderr.write(`mv: ${vfsErrorMessage(e, src)}\n`);
			return 1;
		}
	}
	return 0;
};
