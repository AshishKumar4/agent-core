import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
    type AcceptedArtifact,
    type ProofArtifactContent,
    type ProofRepairCandidate
} from "./proof-repair-record.js";
import type { ProofCandidateSubject } from "./proof-repair-verification.js";

/** The repository root, so an isolation can be refused for living inside it. */
const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * Where one candidate is materialized, and who removes it.
 *
 * The two halves are separate because the isolation must not exist when it is materialized —
 * reusing a directory would admit residue from an older candidate — while *something* has to
 * own the enclosing scratch space and delete it on every path out, including the refusals that
 * happen before any candidate text is written.
 */
export interface ProofIsolationWorkspace {
    /** The directory the candidate will be copied into. It does not exist yet. */
    readonly candidate: string;

    /** Removes whatever this workspace owns. Idempotent, and a no-op for a caller's path. */
    discard(): void;
}

/**
 * A fresh workspace in the operating system's own temporary area.
 *
 * `mkdtempSync` creates the enclosing scratch directory, and the candidate path is a child of
 * it that deliberately does not exist: `isolateProofCandidate` refuses a target that already
 * exists, so handing it the scratch directory itself would refuse every default isolation. The
 * scratch directory is outside the repository because candidate elaboration can run arbitrary
 * Lean IO, and a tree inside the working copy would let even a refused candidate touch
 * reviewed sources, the ledger, or its own evidence while the host still believes them
 * untouched.
 */
export function freshProofIsolation(): ProofIsolationWorkspace {
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), "agent-core-proof-repair-"));
    if (proofTreesOverlap(scratch, repositoryRoot)) {
        rmSync(scratch, { recursive: true, force: true });
        throw new ProofTreeError("The isolation directory is inside the repository");
    }
    return Object.freeze({
        candidate: join(scratch, "candidate"),
        discard: (): void => {
            rmSync(scratch, { recursive: true, force: true });
        }
    });
}

/** A workspace a caller supplied and therefore a workspace a caller owns. The protocol still
 * refuses it when it exists, overlaps the base, or lives inside the repository. */
export function callerProofIsolation(candidate: string): ProofIsolationWorkspace {
    return Object.freeze({
        candidate,
        discard: (): void => undefined
    });
}

/** Whether a directory is somewhere the protocol refuses to build an isolation. */
function insideRepository(directory: string): boolean {
    return proofTreesOverlap(directory, repositoryRoot);
}

/**
 * The disposable tree a candidate is verified in.
 *
 * The base corpus is copied, accepted overlays are applied, and the proposed overlays are
 * applied last. The verifier receives this root and no reviewed-tree path. Candidate bytes
 * can therefore be elaborated and kernel-checked without being imported by the accepted
 * corpus, loaded by a runtime, or written over an artifact another candidate already earned.
 */
export class IsolatedProofCandidate implements ProofCandidateSubject {
    public readonly candidate: ProofRepairCandidate;
    public readonly root: string;

    public constructor(candidate: ProofRepairCandidate, root: string) {
        this.candidate = candidate;
        this.root = realpathSync(root);
        Object.freeze(this);
    }
}

/** Removes the disposable tree after the verifier returns. Accepted bytes live only in the
 * ledger, never in a retained candidate worktree. */
export function discardProofIsolation(isolation: IsolatedProofCandidate): void {
    rmSync(isolation.root, { force: true, recursive: true });
}

/** Why a tree could not contain one artifact. This is an ordinary typed boundary failure, not
 * a bare filesystem exception: the protocol catches it and feeds back the exact artifact and
 * the escape it refused. */
export class ProofTreeError extends TypeError {
    public readonly artifact: string | undefined;

    public constructor(message: string, artifact?: string) {
        super(message);
        this.name = "ProofTreeError";
        this.artifact = artifact;
        Object.freeze(this);
    }
}

/** Whether two directories contain one another. Equality overlaps too. */
export function proofTreesOverlap(left: string, right: string): boolean {
    const fromLeft = relative(left, right);
    const fromRight = relative(right, left);
    return isContainedRelative(fromLeft) || isContainedRelative(fromRight);
}

/**
 * Copies the reviewed base into a new isolation, then overlays the accepted artifact set and
 * the proposed artifact set. The isolation must not exist, and it must not be inside the
 * repository: reusing one would admit residue from an older candidate into the question this
 * candidate's identity is meant to name, and building one inside the working copy would put a
 * candidate's untrusted writes next to the sources and ledger it is judged against.
 */
export function isolateProofCandidate(
    base: string,
    isolation: string,
    accepted: readonly AcceptedArtifact[],
    candidate: ProofRepairCandidate
): IsolatedProofCandidate {
    const reviewed = existingDirectory(base, "The proof base");
    const target = absentDirectoryTarget(isolation);
    if (proofTreesOverlap(reviewed, target)) {
        throw new ProofTreeError("The isolation overlaps the reviewed proof base");
    }
    if (insideRepository(target)) {
        throw new ProofTreeError("The isolation is inside the repository");
    }
    try {
        cpSync(reviewed, target, {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
            filter: (source) => includeProofSource(reviewed, source)
        });
        for (const artifact of accepted) writeProofArtifact(target, artifact);
        for (const artifact of candidate.artifacts) writeProofArtifact(target, artifact);
        return new IsolatedProofCandidate(candidate, target);
    } catch (error) {
        rmSync(target, { force: true, recursive: true });
        if (error instanceof ProofTreeError) throw error;
        if (error instanceof Error) throw new ProofTreeError(error.message);
        throw new ProofTreeError("The isolation could not be materialized");
    }
}

/** Writes one artifact under a root after checking every existing component. A symlink is
 * refused even when it currently resolves inside the root: a later retarget would change
 * where the same candidate path writes without changing the candidate identity. Materializing
 * a candidate is the isolation's job, so this stays inside it. */
function writeProofArtifact(root: string, artifact: ProofArtifactContent): void {
    const canonical = existingDirectory(root, "The artifact root");
    const segments = artifact.path.split("/");
    let parent = canonical;
    for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        if (existsSync(parent)) {
            const entry = lstatSync(parent);
            if (entry.isSymbolicLink()) {
                throw new ProofTreeError(
                    `${artifact.path} traverses symbolic link ${segment}`,
                    artifact.path
                );
            }
            if (!entry.isDirectory()) {
                throw new ProofTreeError(
                    `${artifact.path} traverses non-directory ${segment}`,
                    artifact.path
                );
            }
        } else {
            mkdirSync(parent);
        }
    }
    const target = join(canonical, artifact.path);
    if (existsSync(target)) {
        const entry = lstatSync(target);
        if (entry.isSymbolicLink()) {
            throw new ProofTreeError(`${artifact.path} is a symbolic link`, artifact.path);
        }
        if (!entry.isFile()) {
            throw new ProofTreeError(`${artifact.path} does not name a file`, artifact.path);
        }
    }
    writeFileSync(target, artifact.text, { encoding: "utf8", flag: "w" });
}

function existingDirectory(path: string, owner: string): string {
    if (!isAbsolute(path)) throw new ProofTreeError(`${owner} is not absolute: ${path}`);
    let canonical: string;
    try {
        canonical = realpathSync(path);
    } catch (error) {
        if (error instanceof Error) {
            throw new ProofTreeError(`${owner} is unavailable: ${error.message}`);
        }
        throw new ProofTreeError(`${owner} is unavailable`);
    }
    if (!lstatSync(canonical).isDirectory()) {
        throw new ProofTreeError(`${owner} is not a directory: ${canonical}`);
    }
    return canonical;
}

/** The canonical location a new isolation will occupy. Its parent exists and is resolved, so
 * a symlink in the path cannot redirect creation after the overlap check. */
function absentDirectoryTarget(path: string): string {
    if (!isAbsolute(path)) throw new ProofTreeError(`The isolation is not absolute: ${path}`);
    if (existsSync(path)) throw new ProofTreeError(`The isolation already exists: ${path}`);
    const parent = realpathSync(dirname(path));
    const name = basename(path);
    if (name.length === 0 || name === "." || name === "..") {
        throw new ProofTreeError(`The isolation has no ordinary directory name: ${path}`);
    }
    return resolve(parent, name);
}

/** Build products are not source and are not trusted as proof evidence. A fresh isolation
 * rebuilds them, so copying `.lake` would weaken isolation while only saving time. */
function includeProofSource(root: string, source: string): boolean {
    const selected = relative(root, source).split(sep).join("/");
    return selected !== ".lake" && !selected.startsWith(".lake/");
}

function isContainedRelative(path: string): boolean {
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
