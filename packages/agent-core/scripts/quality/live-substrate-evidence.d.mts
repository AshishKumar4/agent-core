import type { JsonObject } from "./project.mjs";

/**
 * Fingerprinted sources that no longer match the tree, and the rows waiting on the
 * operator's re-run because of them. Both are empty while the archive matches the tree,
 * and a drift reaches this shape only because no row claims `verified` from the archive:
 * a drift under a verified claim throws instead.
 */
export interface PendingLiveEvidence {
    readonly sources: readonly string[];
    readonly requirements: readonly string[];
}

export interface LiveEvidence {
    readonly manifest: JsonObject;
    readonly selectors: ReadonlySet<string>;
    readonly pending: PendingLiveEvidence;
}

export function validateLiveEvidence(root?: string): LiveEvidence;
export function liveEvidenceSelectors(conformanceRoot?: string): ReadonlySet<string>;
