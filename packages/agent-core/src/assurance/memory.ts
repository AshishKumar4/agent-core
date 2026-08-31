import { MonitorReport, RuntimeMonitor, RuntimeMonitorDeclaration } from "./monitor";

/**
 * A scripted reference monitor for contract tests and local model exercises.
 *
 * Each call consumes one scripted result. `undefined` is an honest missing observation, not a
 * synthetic clean report: consumers receive no coverage and no discharge from it. The monitor
 * snapshots its script at construction, so later writes through the caller's array cannot alter
 * what it will report.
 *
 * This is the in-memory implementation of the observation seam. `RuntimeAssuranceLedger` is
 * the in-memory implementation of the derived evidence projection; neither persists domain
 * records or substitutes for the owning Actor's durable evidence.
 */
export class MemoryRuntimeMonitor extends RuntimeMonitor {
    readonly #results: readonly (MonitorReport | undefined)[];
    #next = 0;

    public constructor(
        declaration: RuntimeMonitorDeclaration,
        results: readonly (MonitorReport | undefined)[]
    ) {
        super(declaration);
        this.#results = requireResults(results, declaration);
    }

    public async observe(nowMs: number): Promise<MonitorReport | undefined> {
        requireSafeInteger(nowMs, "Observation instant");
        if (this.#next >= this.#results.length) return undefined;
        const result = this.#results[this.#next];
        this.#next += 1;
        return result;
    }
}

function requireResults(
    results: readonly (MonitorReport | undefined)[],
    declaration: RuntimeMonitorDeclaration
): readonly (MonitorReport | undefined)[] {
    const snapshot: (MonitorReport | undefined)[] = [];
    for (const result of results) {
        if (result !== undefined && !(result instanceof MonitorReport)) {
            throw new TypeError("Memory monitor results must be MonitorReport values or undefined");
        }
        if (
            result !== undefined &&
            (!result.monitor.equals(declaration.id) || !declaration.coversExactly(result.covers))
        ) {
            throw new TypeError("Memory monitor report must match its declaration");
        }
        snapshot.push(result);
    }
    return Object.freeze(snapshot);
}

function requireSafeInteger(value: number, subject: string): void {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
}
