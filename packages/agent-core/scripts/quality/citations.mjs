import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export async function citedText(citation, owner, root) {
    const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(citation);
    if (match === null)
        throw new TypeError(`${owner} has invalid instruction citation ${citation}`);
    const path = isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
    const lines = (await readFile(path, "utf8")).split("\n");
    const start = Number(match[2]);
    const end = Number(match[3] ?? match[2]);
    if (start < 1 || end < start || end > lines.length) {
        throw new TypeError(`${owner} has stale instruction citation ${citation}`);
    }
    return lines.slice(start - 1, end).join("\n");
}

export async function requireCitedText(citations, expected, owner, root) {
    const text = (
        await Promise.all(citations.map((citation) => citedText(citation, owner, root)))
    ).join("\n");
    if (typeof expected !== "string" || !text.includes(expected)) {
        throw new TypeError(`${owner} instruction citations do not contain ${expected}`);
    }
}
