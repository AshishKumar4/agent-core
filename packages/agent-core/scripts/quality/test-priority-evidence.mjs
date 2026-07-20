export const TEST_PRIORITIES = Object.freeze(["p0", "p1", "p2"]);

export function requireNonP2ConformanceEvidence(requirement, selectors, classified) {
    if (!Array.isArray(selectors) || selectors.some((selector) => typeof selector !== "string")) {
        throw new TypeError(`${requirement} has malformed conformance selectors`);
    }
    requireExactSelectorKeys(classified);
    const bySelector = new Map();
    for (const priority of TEST_PRIORITIES) {
        for (const selector of classified[priority]) {
            if (typeof selector !== "string" || selector.length === 0) {
                throw new TypeError("Priority classification contains a malformed selector");
            }
            if (bySelector.has(selector)) {
                throw new TypeError(`Priority classification overlaps at ${selector}`);
            }
            bySelector.set(selector, priority);
        }
    }
    const selected = selectors.flatMap((selector) => {
        const priority = bySelector.get(selector);
        return priority === undefined ? [] : [priority];
    });
    if (selected.length > 0 && selected.every((priority) => priority === "p2")) {
        throw new TypeError(`${requirement} relies only on P2 conformance evidence`);
    }
}

function requireExactSelectorKeys(classified) {
    if (classified === null || typeof classified !== "object" || Array.isArray(classified)) {
        throw new TypeError("Priority classification must be an object");
    }
    const actual = Object.keys(classified).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...TEST_PRIORITIES].sort())) {
        throw new TypeError(
            "Priority classification must contain exactly P0, P1, and P2 selectors"
        );
    }
    for (const priority of TEST_PRIORITIES) {
        if (!Array.isArray(classified[priority])) {
            throw new TypeError(`${priority.toUpperCase()} priority selectors must be an array`);
        }
    }
}
