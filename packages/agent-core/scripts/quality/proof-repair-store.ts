import {
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
    type Stats
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseCanonicalJson } from "./project.mjs";
import { ProofRepairLedger, ProofRepairLedgerCodec } from "./proof-repair-record.js";
import { acceptedProofRepair, type ProofRepairState } from "./proof-repair-outcome.js";

const packageRoot = resolve(import.meta.dirname, "../..");

/** The reviewed genesis record. Operational hosts may pass another absolute ledger path for
 * an isolated run, but this is the one committed state location the quality workflow owns. */
export const proofRepairLedgerArtifact = join(
    packageRoot,
    "artifacts",
    "quality",
    "proof-repair.json"
);

/**
 * The sole owner of accepted proof repair state.
 *
 * The accepted ledger is one immutable, versioned record. It contains the closed obligations
 * and the exact accepted artifact text. There is no candidate log, no second artifact cache,
 * and no mutable status beside it. A refused state has no authority to enter this seam.
 *
 * `commit` is one critical section: the baseline comparison and the publish happen inside the
 * store's exclusion, and the current ledger is read again inside it. Reading before the
 * section would be the defect this structure exists to remove — two committers that both
 * compared against the same old digest and then both published, the second silently
 * discarding the first candidate's closures and artifacts.
 */
export abstract class ProofRepairStore {
    public abstract load(): ProofRepairLedger;

    /** The only mutation. A caller cannot hand the store arbitrary text or a forged object;
     * it must present a state this protocol module itself constructed as accepted. */
    public commit(state: ProofRepairState): ProofRepairLedger {
        const accepted = acceptedProofRepair(state);
        if (accepted === undefined) {
            throw new TypeError("A refused proof repair has no authority to overwrite artifacts");
        }
        return this.exclusive(() => {
            const current = this.load();
            if (current.digest !== accepted.baseline) {
                throw new TypeError("An accepted proof repair was decided against a stale ledger");
            }
            if (accepted.ledger.candidate !== accepted.candidate) {
                throw new TypeError("An accepted proof repair does not name its candidate");
            }
            this.write(accepted.ledger);
            return accepted.ledger;
        });
    }

    /**
     * Runs the compare-and-publish while this store is the only committer.
     *
     * The base implementation runs it directly, which is exclusion enough for a store one
     * process owns: the section is synchronous, so nothing can interleave with it. A store
     * whose state is shared with other processes overrides this and holds a durable lock.
     */
    protected exclusive<Result>(operation: () => Result): Result {
        return operation();
    }

    protected abstract write(ledger: ProofRepairLedger): void;
}

/** The reference implementation used by behavior tests. Its one mutable field is the actor's
 * state; all records it returns are frozen immutable values. */
export class MemoryProofRepairStore extends ProofRepairStore {
    private ledger: ProofRepairLedger;

    public constructor(ledger: ProofRepairLedger = ProofRepairLedger.genesis) {
        super();
        this.ledger = ledger;
    }

    public load(): ProofRepairLedger {
        return this.ledger;
    }

    protected write(ledger: ProofRepairLedger): void {
        this.ledger = ledger;
    }
}

/**
 * The durable store. The file itself is the aggregate — it contains both accepted artifact
 * text and the obligation ledger — and a same-directory rename publishes the next record only
 * after its complete canonical bytes exist. A failed write removes its temporary file and
 * leaves the last accepted record untouched.
 */
export class FileProofRepairStore extends ProofRepairStore {
    private readonly path: string;

    public constructor(path: string) {
        super();
        if (!isAbsolute(path)) throw new TypeError(`A ledger path is not absolute: ${path}`);
        mkdirSync(dirname(path), { recursive: true });
        const directory = realpathSync(dirname(path));
        const name = basename(path);
        if (name.length === 0 || name === "." || name === "..") {
            throw new TypeError(`A ledger path has no ordinary file name: ${path}`);
        }
        this.path = resolve(directory, name);
        Object.freeze(this);
    }

    public load(): ProofRepairLedger {
        const entry = presentEntry(this.path);
        if (entry === undefined) return ProofRepairLedger.genesis;
        if (entry.isSymbolicLink() || !entry.isFile()) {
            throw new TypeError(`The proof repair ledger is not an ordinary file: ${this.path}`);
        }
        return ProofRepairLedgerCodec.decode(
            parseCanonicalJson(readFileSync(this.path, "utf8"), this.path),
            this.path
        );
    }

    /**
     * Holds the ledger's durable exclusion for the whole compare-and-publish.
     *
     * The lock file is created with `O_EXCL`, which is one filesystem operation that either
     * creates the name or fails: the second committer to arrive cannot mistake a held lock for
     * a free one, and because the baseline is re-read inside the section it cannot publish over
     * a ledger that moved while it waited. The lock is removed on every path out, including a
     * refusal, so a rejected commit does not strand the next one. A lock left behind by a
     * killed process is content and is refused rather than broken: this store cannot ask
     * whether its holder is still running, and taking a lock on that guess is how two writers
     * publish at once.
     */
    protected override exclusive<Result>(operation: () => Result): Result {
        const lock = join(dirname(this.path), `.${basename(this.path)}.lock`);
        try {
            writeFileSync(lock, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
        } catch {
            throw new TypeError(`The proof repair ledger is locked by another commit: ${lock}`);
        }
        try {
            return operation();
        } finally {
            rmSync(lock, { force: true });
        }
    }

    protected write(ledger: ProofRepairLedger): void {
        const temporary = join(dirname(this.path), `.${basename(this.path)}.${ledger.digest}.tmp`);
        if (presentEntry(temporary) !== undefined) {
            throw new TypeError(`A pending proof repair ledger already exists: ${temporary}`);
        }
        try {
            writeFileSync(
                temporary,
                `${JSON.stringify(ProofRepairLedgerCodec.encode(ledger), null, 2)}\n`,
                { encoding: "utf8", flag: "wx" }
            );
            renameSync(temporary, this.path);
        } catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
    }
}

/**
 * The directory entry at a path, without following it, or nothing when there is none.
 *
 * `existsSync` answers about the target of a link, so a ledger path pointed at something that
 * does not exist reads as an absent ledger and would be answered with genesis — which is a
 * redirect deciding the accepted state. Reading the entry itself refuses the link instead.
 */
function presentEntry(path: string): Stats | undefined {
    return lstatSync(path, { throwIfNoEntry: false });
}
