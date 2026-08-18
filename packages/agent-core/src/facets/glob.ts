const highSurrogateStart = 0xd800;
const highSurrogateEnd = 0xdbff;
const lowSurrogateStart = 0xdc00;
const lowSurrogateEnd = 0xdfff;

/**
 * Matches a whole string by scanning forward. Compiling stored `*` patterns to repeated
 * `.*` groups permits exponential regex backtracking on a failed match.
 */
export function matchesGlob(pattern: string, value: string): boolean {
    const segments = pattern.split("*");
    const first = segments[0];
    const last = segments.at(-1);
    if (first === undefined || last === undefined) return false;
    if (segments.length === 1) return value === pattern;
    if (
        first.length + last.length > value.length ||
        !value.startsWith(first) ||
        !value.endsWith(last) ||
        !isCodePointBoundary(value, first.length)
    ) {
        return false;
    }

    const end = value.length - last.length;
    if (!isCodePointBoundary(value, end)) return false;
    let cursor = first.length;
    for (const segment of segments.slice(1, -1)) {
        cursor = findSegmentEnd(value, segment, cursor, end);
        if (cursor < 0) return false;
    }
    return true;
}

function findSegmentEnd(value: string, segment: string, cursor: number, end: number): number {
    for (let found = value.indexOf(segment, cursor); found >= 0;) {
        const after = found + segment.length;
        if (after > end) return -1;
        if (isCodePointBoundary(value, found) && isCodePointBoundary(value, after)) return after;
        found = value.indexOf(segment, found + 1);
    }
    return -1;
}

function isCodePointBoundary(value: string, index: number): boolean {
    if (index <= 0 || index >= value.length) return true;
    const before = value.charCodeAt(index - 1);
    const after = value.charCodeAt(index);
    return (
        before < highSurrogateStart ||
        before > highSurrogateEnd ||
        after < lowSurrogateStart ||
        after > lowSurrogateEnd
    );
}
