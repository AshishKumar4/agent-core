import { resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { isModifier } from "typescript/unstable/ast";
import { packageRoot } from "./project.mjs";

/**
 * The compiler session every AST tool reads through.
 *
 * TypeScript 7 has no in-process parser: the compiler API is a client to a separate
 * native server, and a file becomes an AST only inside a snapshot of that server's view
 * of the world. So the boilerplate every tool would otherwise repeat — spawning the
 * server, opening files, resolving a file to the project that owns it, and holding the
 * current snapshot — lives here once. One session per process, spawned on first use.
 *
 * Two entry points, because the tools ask two different questions. `sourceFiles` and
 * `parseSource` answer "what does this text parse to", and own the open-file set and the
 * content overlay that lets a tool parse text with no file behind it. `openProject` and
 * `configuredProject` answer "what does the checker say", and hand back the compiler's
 * own `Project` so semantic callers use `project.program` and `project.checker` directly
 * rather than through a wrapper that would only rename them.
 *
 * The overlay deserves a note, because the obvious reading of this API says it cannot
 * exist: `FileChangeSummary` carries only paths, so there is no way to hand the server
 * new content for a file, and parsing a string looks impossible without writing a
 * temporary file first. The content channel is elsewhere — the client's `fs` option is a
 * virtual filesystem whose `readFile` returns overlay text, or `undefined` to fall
 * through to the real disk. That is what makes `parseSource` and the synthetic
 * configuration files in `openProject` possible without touching the working tree.
 *
 * One sharp edge, learned by measuring all six combinations: an open file's text is
 * pinned when it is opened. A change notice does not unpin it, and neither does
 * `clearSourceFileCache` or `invalidateAll`. Re-reading a path takes a close carrying
 * the change notice followed by a separate reopen — both in one snapshot update yields no
 * project at all. `release` is where that lives.
 */

/** Content for paths whose text does not come from disk. Absent means "read the disk". */
const overlay = new Map();
/** Paths currently open on the server. An open file's text is pinned at open time. */
const opened = new Set();
/** The text each open path was last read with, so re-reading identical text is free. */
const contents = new Map();

let api;
let snapshot;
let projectCount = 0;

function server() {
    api ??= new API({
        cwd: packageRoot,
        fs: {
            readFile: (path) => overlay.get(path),
            fileExists: (path) => (overlay.has(path) ? true : undefined)
        }
    });
    return api;
}

function update(params) {
    snapshot = server().updateSnapshot(params);
    return snapshot;
}

function current() {
    return snapshot ?? update({});
}

function open(paths) {
    const unopened = paths.filter((path) => !opened.has(path));
    if (unopened.length === 0) return current();
    for (const path of unopened) opened.add(path);
    return update({ openFiles: unopened });
}

function materialize(path) {
    return current().getDefaultProjectForFile(path)?.program.getSourceFile(path);
}

/**
 * The AST of every named path, keyed by its absolute path and in the order given. Every
 * path must parse: a tool that walked a source tree and then quietly measured fewer files
 * than it found is the failure this refuses to allow. Paths are opened in one round trip,
 * so a tool walking a tree calls this once rather than once per file.
 */
export function sourceFiles(paths) {
    const wanted = paths.map((path) => resolve(packageRoot, path));
    open(wanted);
    const sources = new Map();
    const unreadable = [];
    for (const path of wanted) {
        const source = materialize(path);
        if (source === undefined) unreadable.push(path);
        else sources.set(path, source);
    }
    if (unreadable.length > 0) {
        throw new TypeError(`Cannot read source file(s):\n${unreadable.join("\n")}`);
    }
    return sources;
}

/** The AST of one path, or undefined when nothing readable is there. */
export function sourceFile(path) {
    const absolute = resolve(packageRoot, path);
    open([absolute]);
    return materialize(absolute);
}

/**
 * The AST of `text` as if it were the file at `name`. The text is held in the session's
 * overlay, so nothing is written to disk and a name with no file behind it is as valid a
 * source as one with. Parsing the same name with the same text again returns the same
 * AST; parsing it with different text re-reads it.
 */
export function parseSource(name, text) {
    const path = resolve(packageRoot, name);
    if (contents.get(path) === text) {
        const cached = materialize(path);
        if (cached !== undefined) return cached;
    }
    release([path]);
    overlay.set(path, text);
    contents.set(path, text);
    open([path]);
    const source = materialize(path);
    if (source === undefined) throw new TypeError(`Cannot parse source ${name}`);
    return source;
}

/** The parse errors of a path already read through this session, in source order. */
export function syntaxErrors(path) {
    const absolute = resolve(packageRoot, path);
    open([absolute]);
    const owner = current().getDefaultProjectForFile(absolute);
    return owner === undefined ? [] : owner.program.getSyntacticDiagnostics(absolute);
}

/**
 * Forgets what the session read for these paths, so the next read sees what is on disk
 * now. A tool that rewrites a file it has already parsed says so here; nothing else has
 * to care that reads are cached.
 */
export function forget(paths) {
    const absolute = paths.map((path) => resolve(packageRoot, path));
    release(absolute);
    for (const path of absolute) overlay.delete(path);
}

/**
 * Drops the session's reading of these paths. An open file's text is pinned at open
 * time and a change notice alone does not unpin it, so releasing is a close plus that
 * notice; the reopen that follows is what reads the text again.
 */
function release(paths) {
    const closing = paths.filter((path) => opened.has(path));
    for (const path of closing) {
        opened.delete(path);
        contents.delete(path);
    }
    if (closing.length > 0) update({ closeFiles: closing, fileChanges: { changed: closing } });
}

/**
 * A project over an exact set of root files. TypeScript 7 builds a program only from a
 * configuration file, so the configuration is written into the session's overlay: the
 * server reads it like any other file and no configuration is left on disk. `extend`
 * names a real configuration to inherit — the only way to reuse its resolved options,
 * since the server reports them as resolved enum values rather than as written.
 */
export function openProject({ files, extend, compilerOptions = {} }) {
    const path = resolve(packageRoot, `tsconfig.quality-${(projectCount += 1)}.json`);
    const settings = { compilerOptions, files, include: [] };
    if (extend !== undefined) settings.extends = extend;
    overlay.set(path, JSON.stringify(settings));
    return loadProject(path, `a project over ${files.length} file(s)`);
}

/** The project a configuration file on disk describes, with its own program and checker. */
export function configuredProject(path) {
    const absolute = resolve(packageRoot, path);
    return loadProject(absolute, absolute);
}

function loadProject(path, description) {
    const loaded = update({ openProjects: [path] }).getProject(path);
    if (loaded === undefined) throw new TypeError(`Cannot open ${description}`);
    return loaded;
}

/** The resolved options and root file names of a configuration file. */
export function configuration(path) {
    return server().parseConfigFile(resolve(packageRoot, path));
}

/**
 * Whether a declaration carries a modifier. TypeScript 7 holds modifiers and decorators
 * in one `modifiers` array on every node that can have either, so the query filters to
 * the modifiers themselves rather than asking first whether the node may have any.
 */
export function hasModifier(node, kind) {
    return (node.modifiers ?? []).some(
        (modifier) => isModifier(modifier) && modifier.kind === kind
    );
}
