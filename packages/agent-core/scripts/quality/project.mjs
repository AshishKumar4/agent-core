import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const repositoryRoot = resolve(packageRoot, "../..");
export const reportRoot = resolve(packageRoot, "reports/quality");
export const artifactRoot = resolve(packageRoot, "artifacts");

export async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}

export async function readCanonicalJson(path) {
    const source = await readFile(path, "utf8");
    return JSON.parse(source);
}

export async function writeCanonicalJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function collectFiles(root, predicate = () => true) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = resolve(root, entry.name);
        if (entry.isSymbolicLink()) {
            throw new TypeError(`Source universe contains symbolic link ${portablePath(path)}`);
        }
        if (entry.isDirectory()) files.push(...(await collectFiles(path, predicate)));
        else if (predicate(path)) files.push(path);
    }
    return files;
}

export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

export async function fileSha256(path) {
    return sha256(await readFile(path));
}

export function portable(path) {
    return path.split(sep).join("/");
}

export function portablePath(path) {
    return portable(relative(repositoryRoot, path));
}

export function absoluteFromRepository(path) {
    const absolute = resolve(repositoryRoot, path);
    const offset = relative(repositoryRoot, absolute);
    if (offset === ".." || offset.startsWith(`..${sep}`)) {
        throw new TypeError(`Path escapes repository: ${path}`);
    }
    return absolute;
}

export function globMatches(pattern, path) {
    const expression = pattern
        .replaceAll(/[-/\\^$+?.()|[\]{}]/g, "\\$&")
        .replaceAll("**", "\u0000")
        .replaceAll("*", "[^/]*")
        .replaceAll("\u0000", ".*");
    return new RegExp(`^${expression}$`).test(path);
}

export function assertExactKeys(value, expected, owner) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${owner} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(keys)) {
        throw new TypeError(`${owner} has missing or unknown fields`);
    }
}

export function assertString(value, owner) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${owner} must be a nonempty string`);
    }
    return value;
}

export function assertUniqueStrings(value, owner) {
    if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string" || item.trim().length === 0) ||
        new Set(value).size !== value.length
    ) {
        throw new TypeError(`${owner} must be an array of unique nonempty strings`);
    }
    return value;
}

export function assertFlatFragmentNames(value, owner) {
    assertUniqueStrings(value, owner);
    if (value.some((name) => !/^[a-z0-9-]+\.json$/u.test(name))) {
        throw new TypeError(`${owner} must contain flat lowercase JSON filenames`);
    }
    return value;
}
