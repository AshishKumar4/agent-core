import { FilesystemError } from "./error";
import {
    FilesystemBackend,
    FilesystemTargetState,
    type FilesystemPage,
    type FilesystemReadRange,
    type FilesystemStat,
    type FilesystemWriteMode
} from "./facet";

/**
 * The seam that makes a guarded write's interleave expressible.
 *
 * `P11-FILESYSTEM-WRITE-GUARD-ATOMIC` is a claim about a window: the comparison and the
 * replacement occupy the single atomic step `P11-FILESYSTEM-ATOMIC-WRITE` already requires,
 * so no write lands between them. A synchronous backing store cannot exhibit that window at
 * all — nothing runs between its comparison and its set — so a test driving one directly can
 * only show the sequential case, which a host that reads, compares, and then writes through a
 * second store call passes just as easily. This wrapper splits the write at exactly the seam
 * the rule is about and hands the window to its caller: it discharges the mode's precondition
 * against the target state it observes, runs the landing armed for that crossing, and only
 * then reaches the wrapped store's atomic step with the mode still in hand.
 *
 * Carrying the mode into the store step is the point of the composition. The store discharges
 * the guard again, against the content it actually replaces, so a write that landed inside the
 * window surfaces as a rejection rather than as a replacement authorized by a comparison
 * against content it did not replace. A host that instead trusted the comparison this wrapper
 * already made — a precondition evaluated during §7.3 preparation and believed at effect time
 * — would apply that replacement, which is the time-of-check-to-time-of-use hole the rule
 * closes and what the conformance test for it has to be able to fail.
 */
export class InterleavedFilesystemBackend extends FilesystemBackend {
    #landing: (() => void) | undefined;

    public constructor(private readonly store: FilesystemBackend) {
        super();
    }

    /**
     * Arms the window fired between the next write's comparison and its replacement. One
     * shot, because a landing write is an event rather than a mode: a crossing that wants one
     * arms it again, and an unarmed seam is an ordinary pass-through to the store.
     */
    public landBeforeReplacement(landing: () => void): void {
        this.#landing = landing;
    }

    public read(path: string, range?: FilesystemReadRange): Uint8Array {
        return this.store.read(path, range);
    }

    public stat(path: string): FilesystemStat {
        return this.store.stat(path);
    }

    public list(path: string, cursor?: string, limit?: number): FilesystemPage {
        return this.store.list(path, cursor, limit);
    }

    public write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void {
        // The comparison step: a guard naming what the target holds right now passes here,
        // which is the case the rule is about — a comparison that observed matching content.
        mode.requireWritable(path, this.target(path));
        const landing = this.#landing;
        this.#landing = undefined;
        // The window: whatever the caller lands, lands after that comparison and before the
        // replacement below.
        landing?.();
        // The store step, mode included. The discharge that authorizes the replacement is the
        // store's own, against the content the replacement replaces — never this one.
        this.store.write(path, content, mode);
    }

    public remove(path: string): void {
        this.store.remove(path);
    }

    public move(source: string, destination: string): void {
        this.store.move(source, destination);
    }

    public mkdir(path: string, recursive?: boolean): void {
        this.store.mkdir(path, recursive);
    }

    /**
     * What the store holds at the target, as the two-case value a precondition consumes.
     * `not-found` is the one rejection that means an absent target; every other code — a
     * directory at the target, a path that does not normalize — is the store's answer about
     * this write and reaches the caller unchanged rather than being retold as absence.
     */
    private target(path: string): FilesystemTargetState {
        try {
            return FilesystemTargetState.present(this.store.read(path));
        } catch (error) {
            if (error instanceof FilesystemError && error.detailCode === "not-found") {
                return FilesystemTargetState.absent;
            }
            throw error;
        }
    }
}
