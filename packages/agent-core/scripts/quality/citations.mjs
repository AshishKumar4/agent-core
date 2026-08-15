import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isNonEmptyString } from "./project.mjs";

export async function instructionSource(source, owner, root) {
    if (
        !isNonEmptyString(source) ||
        isAbsolute(source) ||
        /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(source)
    ) {
        throw new TypeError(`${owner} has invalid instruction source ${source}`);
    }
    return readFile(resolve(root, source), "utf8");
}

export async function requireInstructionText(sources, expected, owner, root) {
    if (!isNonEmptyString(expected)) {
        throw new TypeError(`${owner} instruction text is empty`);
    }
    const text = (
        await Promise.all(sources.map((source) => instructionSource(source, owner, root)))
    ).join("\n");
    const occurrences = text.split(expected).length - 1;
    if (occurrences !== 1) {
        throw new TypeError(
            `${owner} instruction sources contain ${occurrences} copies of ${expected}; expected exactly one`
        );
    }
}
