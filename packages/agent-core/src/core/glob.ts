/**
 * Matches a `*`-only glob by a greedy left-to-right scan rather than a compiled
 * `^a.*b.*c$`.
 *
 * Patterns reach this from stored records -- a Grant's capability pattern, a Blueprint
 * slot's contribute selector -- so their author is not necessarily the operator. Each
 * `*` in a compiled regex is a backtracking point, and against a value that does not
 * match, the cost is O(value^wildcards): twelve wildcards took two seconds, eighteen did
 * not finish.
 *
 * Taking the earliest occurrence of every interior literal is optimal for `*`-only
 * globs -- a later occurrence only shortens the remaining suffix -- so the scan is exact
 * as well as linear.
 */
export function matchesGlob(pattern: string, value: string): boolean {
    const segments = pattern.split("*");
    const first = segments[0]!;
    const last = segments[segments.length - 1]!;
    if (segments.length === 1) return value === pattern;
    if (
        first.length + last.length > value.length ||
        !value.startsWith(first) ||
        !value.endsWith(last)
    ) {
        return false;
    }
    const end = value.length - last.length;
    let cursor = first.length;
    for (const segment of segments.slice(1, -1)) {
        const found = value.indexOf(segment, cursor);
        if (found < 0 || found + segment.length > end) return false;
        cursor = found + segment.length;
    }
    return true;
}
