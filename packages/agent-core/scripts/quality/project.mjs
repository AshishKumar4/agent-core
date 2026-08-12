import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const repositoryRoot = resolve(packageRoot, "../..");
export const reportRoot = resolve(packageRoot, "reports/quality");
export const artifactRoot = resolve(packageRoot, "artifacts");

export async function readJson(path) {
    return parseCanonicalJson(await readFile(path, "utf8"), portablePath(path));
}

export async function readCanonicalJson(path) {
    const source = await readFile(path, "utf8");
    return parseCanonicalJson(source, portablePath(path));
}

/**
 * A conforming JSON.parse silently keeps the last of two duplicate object keys and
 * discards everything the first held — including, once, an entire rule array. Every
 * artifact this repo treats as evidence is parsed through here instead of the native
 * parser so a duplicate key is a named, located, unambiguous failure rather than a
 * quiet loss the checker that reads it has no way to notice.
 */
export function parseCanonicalJson(source, label) {
    const parser = new StrictJsonParser(source, label);
    const value = parser.parseValue([]);
    parser.skipWhitespace();
    if (parser.index !== parser.source.length) parser.fail("Unexpected trailing content");
    return value;
}

class StrictJsonParser {
    constructor(source, label) {
        this.source = source;
        this.label = label;
        this.index = 0;
    }

    fail(message) {
        const { line, column } = this.locate(this.index);
        throw new SyntaxError(`${message} in ${this.label} at line ${line}, column ${column}`);
    }

    locate(index) {
        let line = 1;
        let column = 1;
        for (let cursor = 0; cursor < index; cursor += 1) {
            if (this.source[cursor] === "\n") {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }
        return { line, column };
    }

    skipWhitespace() {
        while (/[ \t\n\r]/u.test(this.source[this.index] ?? "")) this.index += 1;
    }

    expect(char) {
        if (this.source[this.index] !== char) this.fail(`Expected "${char}"`);
        this.index += 1;
    }

    parseValue(path) {
        this.skipWhitespace();
        const char = this.source[this.index];
        if (char === "{") return this.parseObject(path);
        if (char === "[") return this.parseArray(path);
        if (char === '"') return this.parseString();
        if (char === "-" || (char >= "0" && char <= "9")) return this.parseNumber();
        if (this.source.startsWith("true", this.index)) {
            this.index += 4;
            return true;
        }
        if (this.source.startsWith("false", this.index)) {
            this.index += 5;
            return false;
        }
        if (this.source.startsWith("null", this.index)) {
            this.index += 4;
            return null;
        }
        this.fail(char === undefined ? "Unexpected end of input" : `Unexpected token "${char}"`);
    }

    parseObject(path) {
        this.expect("{");
        const result = {};
        const seenKeys = new Set();
        this.skipWhitespace();
        if (this.source[this.index] === "}") {
            this.index += 1;
            return result;
        }
        for (;;) {
            this.skipWhitespace();
            if (this.source[this.index] !== '"') this.fail("Expected string key");
            const keyStart = this.index;
            const key = this.parseString();
            if (seenKeys.has(key)) {
                this.index = keyStart;
                this.fail(`Duplicate key "${key}" at ${formatJsonPath(path)}`);
            }
            seenKeys.add(key);
            this.skipWhitespace();
            this.expect(":");
            result[key] = this.parseValue([...path, key]);
            this.skipWhitespace();
            const next = this.source[this.index];
            if (next === ",") {
                this.index += 1;
                continue;
            }
            if (next === "}") {
                this.index += 1;
                break;
            }
            this.fail('Expected "," or "}"');
        }
        return result;
    }

    parseArray(path) {
        this.expect("[");
        const result = [];
        this.skipWhitespace();
        if (this.source[this.index] === "]") {
            this.index += 1;
            return result;
        }
        let entryIndex = 0;
        for (;;) {
            result.push(this.parseValue([...path, entryIndex]));
            entryIndex += 1;
            this.skipWhitespace();
            const next = this.source[this.index];
            if (next === ",") {
                this.index += 1;
                continue;
            }
            if (next === "]") {
                this.index += 1;
                break;
            }
            this.fail('Expected "," or "]"');
        }
        return result;
    }

    parseString() {
        this.expect('"');
        let result = "";
        for (;;) {
            const char = this.source[this.index];
            if (char === undefined) this.fail("Unterminated string");
            if (char === '"') {
                this.index += 1;
                return result;
            }
            if (char === "\\") {
                this.index += 1;
                const escape = this.source[this.index];
                switch (escape) {
                    case '"':
                        result += '"';
                        break;
                    case "\\":
                        result += "\\";
                        break;
                    case "/":
                        result += "/";
                        break;
                    case "b":
                        result += "\b";
                        break;
                    case "f":
                        result += "\f";
                        break;
                    case "n":
                        result += "\n";
                        break;
                    case "r":
                        result += "\r";
                        break;
                    case "t":
                        result += "\t";
                        break;
                    case "u": {
                        const hex = this.source.slice(this.index + 1, this.index + 5);
                        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) this.fail("Invalid unicode escape");
                        result += String.fromCharCode(Number.parseInt(hex, 16));
                        this.index += 4;
                        break;
                    }
                    default:
                        this.fail(`Invalid escape character "${escape}"`);
                }
                this.index += 1;
            } else {
                if (char.charCodeAt(0) < 0x20) this.fail("Unescaped control character in string");
                result += char;
                this.index += 1;
            }
        }
    }

    parseNumber() {
        const start = this.index;
        if (this.source[this.index] === "-") this.index += 1;
        if (this.source[this.index] === "0") {
            this.index += 1;
        } else if (this.source[this.index] >= "1" && this.source[this.index] <= "9") {
            while (this.source[this.index] >= "0" && this.source[this.index] <= "9") {
                this.index += 1;
            }
        } else {
            this.fail("Invalid number");
        }
        if (this.source[this.index] === ".") {
            this.index += 1;
            if (!(this.source[this.index] >= "0" && this.source[this.index] <= "9")) {
                this.fail("Invalid number");
            }
            while (this.source[this.index] >= "0" && this.source[this.index] <= "9") {
                this.index += 1;
            }
        }
        if (this.source[this.index] === "e" || this.source[this.index] === "E") {
            this.index += 1;
            if (this.source[this.index] === "+" || this.source[this.index] === "-") this.index += 1;
            if (!(this.source[this.index] >= "0" && this.source[this.index] <= "9")) {
                this.fail("Invalid number");
            }
            while (this.source[this.index] >= "0" && this.source[this.index] <= "9") {
                this.index += 1;
            }
        }
        return Number(this.source.slice(start, this.index));
    }
}

function formatJsonPath(path) {
    let result = "$";
    for (const segment of path) {
        result += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
    }
    return result;
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

/**
 * Duplicate object keys are not the only way one array entry can silently shadow
 * another: two well-formed entries with the same id inside one array — an id
 * one branch of a merge added and another branch's copy quietly outlives when
 * both are folded into a Set — lose the same way ACQ-OUTCOME did. Call this
 * wherever an id-bearing array is reduced to a Set or Map keyed by that id.
 */
export function assertUniqueIds(items, idOf, owner) {
    const seen = new Set();
    for (const item of items) {
        const id = idOf(item);
        if (seen.has(id)) throw new TypeError(`${owner} contains duplicate id ${id}`);
        seen.add(id);
    }
    return items;
}
