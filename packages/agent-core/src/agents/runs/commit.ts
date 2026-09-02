import {
    ContentRef,
    type ContentRetentionField,
    contentRetentionFields,
    Digest,
    encodeCanonicalJson,
    isMember,
    type JsonObject,
    type JsonValue,
    RecordCodec,
    Revision,
    SemVer,
    TextId
} from "../../core";
import { PackageId, PackagePin } from "../../definition";
import { EnvironmentId } from "../../environments";
import { requireSynchronousResult } from "../../actors";
import { AgentCoreError } from "../../errors";
import { PrincipalId, PrincipalRef, TenantId } from "../../identity";
import { RunCommitId, TurnId } from "../../execution-references";
import { ReceiptId } from "../../invocation-references";
import { AttemptReceipt, type AttemptFailureKind, type Receipt } from "../../invocations";
import { AuditRecordId, InvocationId, RouteReservationId } from "../../interaction-references";
import {
    CodecRecord,
    requireArray,
    requireExactFields,
    requireObject,
    requireOptionalString,
    requireString
} from "../record-data";
import { AgentId, AgentPolicyId, ModelPolicyId } from "../id";
import { RunBranchId, RunId } from "./id";
import { leaseTokenFromData, leaseTokenToData, leaseTokensEqual, type LeaseToken } from "./lease";
import { BlueprintPin, RunPins } from "./pins";
import type { RunEvidencePort } from "./evidence";

export type SystemCause =
    | { readonly kind: "receipt"; readonly audit: AuditRecordId; readonly receipt: ReceiptId }
    | {
          readonly kind: "delivery";
          readonly audit: AuditRecordId;
          readonly reservation: RouteReservationId;
      }
    | { readonly kind: "control"; readonly audit: AuditRecordId; readonly receipt: ReceiptId };

export interface RunMigration {
    readonly from: RunPins;
    readonly to: RunPins;
}

/** Every Run commit kind, in the order the record vocabulary lists them. */
export const RUN_COMMIT_KINDS = [
    "root",
    "message",
    "checkpoint",
    "invocation",
    "eventDelivery",
    "result",
    "merge",
    "verdict",
    "undo",
    "migration",
    "rewrite",
    "modelInput"
] as const;

export type RunCommitKind = (typeof RUN_COMMIT_KINDS)[number];

/** The kinds a Turn's own lease may append. */
const TURN_AUTHORED_KINDS: readonly RunCommitKind[] = [
    "message",
    "modelInput",
    "checkpoint",
    "result",
    "verdict"
];

/** The kinds a system writer may append on control evidence. */
const CONTROL_AUTHORED_KINDS: readonly RunCommitKind[] = ["merge", "undo", "migration", "rewrite"];

export type CommitWriter =
    | { readonly kind: "root" }
    | { readonly kind: "turn"; readonly token: LeaseToken }
    | { readonly kind: "system"; readonly cause: SystemCause };

export type MergeResolution =
    | { readonly kind: "pick"; readonly parent: RunCommitId }
    | { readonly kind: "concat" }
    | { readonly kind: "synthesize"; readonly token: LeaseToken; readonly receipt: ReceiptId };

export type TreeMergeResolution =
    | {
          readonly policy: "ours" | "theirs";
          readonly side: RunCommitId;
          readonly base: ContentRef;
          readonly environment: string;
      }
    | {
          readonly policy: "perPath";
          readonly base: ContentRef;
          readonly environment: string;
          readonly resolutions: readonly PathResolution[];
      };

export interface PathResolution {
    readonly path: string;
    readonly side: RunCommitId;
}

/**
 * The two ordered parents of a merge commit (§5.2): the head the merge lands on, and the head
 * of the distinct lineage it joins in. Distinctness is a property of this value rather than a
 * length a later reader measures, so a merge that joins one lineage to itself is not a record
 * a caller can build or a decoder can restore.
 */
export class MergeParents {
    /** The pair in the order the merge declared, which is the commit's own parent list. */
    public readonly ordered: readonly RunCommitId[];

    public constructor(
        public readonly target: RunCommitId,
        public readonly source: RunCommitId
    ) {
        if (target.constructor !== RunCommitId || source.constructor !== RunCommitId) {
            throw new TypeError("Merge parents must use exact context classes");
        }
        if (target.equals(source)) {
            throw new TypeError("Merge parents must name two distinct commits");
        }
        this.ordered = Object.freeze([target, source]);
        Object.freeze(this);
    }
}

export interface RunCommitInit {
    readonly id: RunCommitId;
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly kind: RunCommitKind;
    readonly parents: readonly RunCommitId[];
    readonly pins: RunPins;
    readonly writer: CommitWriter;
    readonly subjectTurn?: TurnId | undefined;
    readonly content?: ContentRef | undefined;
    readonly selects?: RunCommitId | undefined;
    /**
     * Rewrite only: the exact commit identities this rewrite removes from the effective
     * transcript, empty when the attempt was abandoned. Identities rather than a span,
     * because once one rewrite exists the commits a second covers are not an interval.
     */
    readonly shadows?: readonly RunCommitId[] | undefined;
    /** Message only: the Invocations this commit's content requests. */
    readonly requests?: readonly InvocationId[] | undefined;
    readonly treeCheckpoint?: ContentRef | undefined;
    readonly resolution?: MergeResolution | undefined;
    readonly treeResolution?: TreeMergeResolution | undefined;
    readonly invocation?: InvocationId | undefined;
    readonly receipt?: ReceiptId | undefined;
    readonly reservation?: RouteReservationId | undefined;
    readonly migration?: RunMigration | undefined;
}

export class RunCommit extends CodecRecord {
    public static get codec(): RecordCodec<RunCommit> {
        return RunCommitCodec;
    }
    public readonly id: RunCommitId;
    public readonly run: RunId;
    public readonly branch: RunBranchId;
    public readonly kind: RunCommitKind;
    public readonly parents: readonly RunCommitId[];
    /** Present on exactly a merge commit, where it is the record's own parent order. */
    public readonly mergeParents: MergeParents | undefined;
    public readonly pins: RunPins;
    public readonly writer: CommitWriter;
    public readonly subjectTurn: TurnId | undefined;
    public readonly content: ContentRef | undefined;
    public readonly selects: RunCommitId | undefined;
    public readonly shadows: readonly RunCommitId[] | undefined;
    public readonly requests: readonly InvocationId[] | undefined;
    public readonly treeCheckpoint: ContentRef | undefined;
    public readonly resolution: MergeResolution | undefined;
    public readonly treeResolution: TreeMergeResolution | undefined;
    public readonly invocation: InvocationId | undefined;
    public readonly receipt: ReceiptId | undefined;
    public readonly reservation: RouteReservationId | undefined;
    public readonly migration: { readonly from: RunPins; readonly to: RunPins } | undefined;
    public readonly proposalDigest: Digest;

    public constructor(init: RunCommitInit) {
        super();
        this.id = init.id;
        this.run = init.run;
        this.branch = init.branch;
        this.kind = init.kind;
        this.mergeParents = requireMergeParents(init);
        this.parents = this.mergeParents?.ordered ?? Object.freeze([...init.parents]);
        this.pins = RunPins.fromData(init.pins.toData());
        this.writer = copyWriter(init.writer);
        this.subjectTurn = init.subjectTurn;
        this.content = init.content;
        this.selects = init.selects;
        this.shadows = init.shadows === undefined ? undefined : Object.freeze([...init.shadows]);
        this.requests = init.requests === undefined ? undefined : Object.freeze([...init.requests]);
        this.treeCheckpoint = init.treeCheckpoint;
        this.resolution =
            init.resolution === undefined ? undefined : copyResolution(init.resolution);
        this.treeResolution =
            init.treeResolution === undefined ? undefined : copyTreeResolution(init.treeResolution);
        this.invocation = init.invocation;
        this.receipt = init.receipt;
        this.reservation = init.reservation;
        this.migration =
            init.migration === undefined
                ? undefined
                : Object.freeze({
                      from: RunPins.fromData(init.migration.from.toData()),
                      to: RunPins.fromData(init.migration.to.toData())
                  });
        validateClosedKind(this);
        this.proposalDigest = Digest.sha256(encodeCanonicalJson(this.proposalData()));
        Object.freeze(this);
    }

    public isTurnAuthored(kind: RunCommitKind, token: LeaseToken): boolean {
        if (this.writer.kind !== "turn") return false;
        return (
            this.kind === kind &&
            this.subjectTurn?.equals(token.turn) === true &&
            leaseTokensEqual(this.writer.token, token)
        );
    }

    public toData(): JsonValue {
        return { ...this.proposalData(), writer: writerData(this.writer) };
    }

    public proposalData(): JsonObject {
        return {
            branch: this.branch.value,
            id: this.id.value,
            kind: this.kind,
            parents: this.parents.map((parent) => parent.value),
            pins: this.pins.toData(),
            run: this.run.value,
            subjectTurn: this.subjectTurn?.value ?? null,
            content: this.content?.value ?? null,
            selects: this.selects?.value ?? null,
            shadows: this.shadows?.map((shadowed) => shadowed.value) ?? null,
            requests: this.requests?.map((invocation) => invocation.value) ?? null,
            treeCheckpoint: this.treeCheckpoint?.value ?? null,
            resolution: this.resolution === undefined ? null : resolutionData(this.resolution),
            treeResolution:
                this.treeResolution === undefined ? null : treeResolutionData(this.treeResolution),
            invocation: this.invocation?.value ?? null,
            receipt: this.receipt?.value ?? null,
            reservation: this.reservation?.value ?? null,
            migration:
                this.migration === undefined
                    ? null
                    : { from: this.migration.from.toData(), to: this.migration.to.toData() }
        };
    }

    public static fromData(value: JsonValue): RunCommit {
        const object = requireObject(value, "Run commit");
        requireExactFields(
            object,
            [
                "branch",
                "content",
                "id",
                "invocation",
                "kind",
                "migration",
                "parents",
                "pins",
                "receipt",
                "reservation",
                "requests",
                "resolution",
                "run",
                "selects",
                "shadows",
                "subjectTurn",
                "treeCheckpoint",
                "treeResolution",
                "writer"
            ],
            [],
            "Run commit"
        );
        const migration = object["migration"];
        const resolution = object["resolution"];
        const treeResolution = object["treeResolution"];
        return new RunCommit({
            id: new RunCommitId(requireString(object["id"], "Run commit ID")),
            run: new RunId(requireString(object["run"], "Run commit Run")),
            branch: new RunBranchId(requireString(object["branch"], "Run commit branch")),
            kind: requireCommitKind(object["kind"]),
            parents: requireArray(object["parents"], "Run commit parents").map(
                (parent) => new RunCommitId(requireString(parent, "Run commit parent"))
            ),
            pins: RunPins.fromData(object["pins"]!),
            writer: requireCommitWriter(object["writer"]!),
            subjectTurn: optionalId(
                object["subjectTurn"],
                (value) => new TurnId(value),
                "Run subject Turn"
            ),
            content: optionalId(object["content"], (value) => new ContentRef(value), "Run content"),
            selects: optionalId(
                object["selects"],
                (value) => new RunCommitId(value),
                "Run selection"
            ),
            shadows: optionalIds(
                object["shadows"],
                (value) => new RunCommitId(value),
                "Rewrite shadow"
            ),
            requests: optionalIds(
                object["requests"],
                (value) => new InvocationId(value),
                "Message request"
            ),
            treeCheckpoint: optionalId(
                object["treeCheckpoint"],
                (value) => new ContentRef(value),
                "Tree checkpoint"
            ),
            resolution: resolution === null ? undefined : requireMergeResolution(resolution),
            treeResolution:
                treeResolution === null ? undefined : requireTreeMergeResolution(treeResolution),
            invocation: optionalId(
                object["invocation"],
                (value) => new InvocationId(value),
                "Run Invocation"
            ),
            receipt: optionalId(object["receipt"], (value) => new ReceiptId(value), "Run Receipt"),
            reservation: optionalId(
                object["reservation"],
                (value) => new RouteReservationId(value),
                "Run reservation"
            ),
            migration:
                migration === null || migration === undefined
                    ? undefined
                    : migrationFromData(migration)
        });
    }
}

export function runCommitContentRetention(value: RunCommit): readonly ContentRetentionField[] {
    return contentRetentionFields([
        ["content", value.content],
        ["treeCheckpoint", value.treeCheckpoint],
        ["treeResolution.base", value.treeResolution?.base]
    ]);
}

class CommitCodec extends RecordCodec<RunCommit> {
    public constructor() {
        super(
            [
                RunCommit,
                MergeParents,
                Revision,
                TextId,
                SemVer,
                RunPins,
                PackagePin,
                BlueprintPin,
                ContentRef,
                Digest,
                RunId,
                RouteReservationId,
                ReceiptId,
                RunCommitId,
                AuditRecordId,
                TenantId,
                TurnId,
                RunBranchId,
                PrincipalId,
                InvocationId,
                AgentId,
                CodecRecord,
                ModelPolicyId,
                EnvironmentId,
                AgentPolicyId,
                PrincipalRef,
                PackageId
            ],
            "run.commit",
            { major: 3, minor: 0 }
        );
    }

    protected encodePayload(value: RunCommit): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): RunCommit {
        return RunCommit.fromData(value);
    }
}

export const RunCommitCodec: RecordCodec<RunCommit> = new CommitCodec();

/**
 * §5.2's abandoned rewrite stands on an attempt that ended without installing anything, and
 * §7.4's closed failure kind on that attempt's Receipt is what says why it ended. The kind is
 * read off the durable Receipt rather than restated beside the evidence, so a host cannot
 * name a kind the Receipt contradicts and no member of the taxonomy needs listing here. A
 * Receipt that is absent, that reached no EffectAttempt, or whose attempt records no failure
 * says nothing an abandoned rewrite may stand on, and each is refused on its own terms.
 */
function requireAbandonedFailureKind(stored: Receipt | undefined): AttemptFailureKind {
    if (stored === undefined) {
        throw deniedEvidence("Abandoned rewrite evidence names no stored Receipt");
    }
    if (!(stored instanceof AttemptReceipt)) {
        throw deniedEvidence(
            "Abandoned rewrite evidence names a Receipt that reached no EffectAttempt"
        );
    }
    const failure = stored.failure;
    if (failure === undefined) {
        throw deniedEvidence(
            "Abandoned rewrite evidence names a Receipt that records no failed attempt"
        );
    }
    return failure;
}

export function validateCommitWriter<Transaction>(
    transaction: Transaction,
    commit: RunCommit,
    evidence: RunEvidencePort<Transaction>
): void {
    if (commit.writer.kind === "root") {
        if (commit.kind !== "root")
            throw invalidWriter("Root writer may append only the root commit");
        return;
    }
    if (commit.writer.kind === "turn") {
        if (
            !TURN_AUTHORED_KINDS.includes(commit.kind) ||
            !commit.subjectTurn?.equals(commit.writer.token.turn)
        ) {
            throw invalidWriter("Turn writer is incompatible with the Run commit");
        }
        return;
    }
    const cause = commit.writer.cause;
    if (cause.kind === "receipt") {
        const found = requireSynchronousResult(
            evidence.receipt(transaction, cause.receipt, cause.audit)
        );
        if (
            commit.kind !== "invocation" ||
            found === undefined ||
            !found.run.equals(commit.run) ||
            !found.audit.equals(cause.audit) ||
            !found.receipt.equals(cause.receipt) ||
            !commit.receipt?.equals(found.receipt) ||
            !commit.invocation?.equals(found.invocation) ||
            !optionalIdsEqual(commit.subjectTurn, found.subjectTurn)
        ) {
            throw deniedEvidence("Receipt writer evidence does not match the Run commit");
        }
        return;
    }
    if (cause.kind === "delivery") {
        const found = requireSynchronousResult(
            evidence.delivery(transaction, cause.reservation, cause.audit)
        );
        if (
            commit.kind !== "eventDelivery" ||
            found === undefined ||
            !found.run.equals(commit.run) ||
            !found.audit.equals(cause.audit) ||
            !found.reservation.equals(cause.reservation) ||
            !commit.reservation?.equals(found.reservation) ||
            !optionalIdsEqual(commit.subjectTurn, found.subjectTurn)
        ) {
            throw deniedEvidence("Delivery writer evidence does not match the Run commit");
        }
        return;
    }
    // The matrix's system(control) row admits an abandoned rewrite on failed control
    // evidence and nothing else, so the abandoned form resolves its own evidence question
    // rather than reusing the successful-Receipt lookup every other control commit uses.
    const abandoned = commit.kind === "rewrite" && commit.shadows?.length === 0;
    const found = requireSynchronousResult(
        abandoned
            ? evidence.abandonedRewrite(transaction, cause.receipt, cause.audit)
            : evidence.control(transaction, cause.receipt, cause.audit)
    );
    if (
        !CONTROL_AUTHORED_KINDS.includes(commit.kind) ||
        found === undefined ||
        !found.run.equals(commit.run) ||
        !found.audit.equals(cause.audit) ||
        !found.receipt.equals(cause.receipt) ||
        found.proposalDigest !== commit.proposalDigest.value ||
        !commit.receipt?.equals(found.receipt)
    ) {
        throw deniedEvidence(
            "Control writer evidence does not bind the complete Run commit proposal"
        );
    }
    // The abandoned form stands on a failed attempt, and §5.2 reads why that attempt ended off
    // the closed failure kind on its Receipt (§7.4). Reading the kind off that Receipt is the
    // whole check, so nothing downstream carries a determination this layer did not derive.
    if (found.kind === "abandonedRewrite") {
        requireAbandonedFailureKind(
            requireSynchronousResult(evidence.storedReceipt(transaction, found.receipt))
        );
    }
    if (commit.resolution?.kind === "synthesize") {
        const synthesis = requireSynchronousResult(
            evidence.synthesis(transaction, commit.resolution.receipt)
        );
        if (
            synthesis === undefined ||
            !synthesis.run.equals(commit.run) ||
            !synthesis.receipt.equals(commit.resolution.receipt) ||
            !leaseTokensEqual(synthesis.token, commit.resolution.token) ||
            !commit.content?.equals(synthesis.content)
        ) {
            throw deniedEvidence("Synthesis evidence does not match the exact token and content");
        }
    }
}

/**
 * A merge's parents are the one parent list this record proves rather than sizes: exactly two
 * commits, in the order the merge declared, naming two lineages. Every other kind keeps the
 * plain list whose arity its own closed shape reads.
 */
function requireMergeParents(init: RunCommitInit): MergeParents | undefined {
    if (init.kind !== "merge") return undefined;
    const [target, source, ...beyond] = init.parents;
    if (target === undefined || source === undefined || beyond.length > 0) {
        throw new TypeError("Merge commit fields are invalid");
    }
    return new MergeParents(target, source);
}

// Each commit kind admits an exact set of fields; every other field must be absent.
function validateClosedKind(commit: RunCommit): void {
    const forbidden = (...values: readonly unknown[]): boolean =>
        values.every((value) => value === undefined);
    const requests = commit.requests;
    if (
        requests !== undefined &&
        (commit.kind !== "message" ||
            requests.length === 0 ||
            new Set(requests.map((invocation) => invocation.value)).size !== requests.length)
    ) {
        throw new TypeError("Only a message commit names a distinct nonempty request set");
    }
    if (commit.shadows !== undefined && commit.kind !== "rewrite") {
        throw new TypeError("Only a rewrite commit shadows commit identities");
    }
    if (commit.kind === "root") {
        if (
            commit.writer.kind !== "root" ||
            commit.parents.length !== 0 ||
            commit.subjectTurn !== undefined ||
            !forbidden(
                commit.selects,
                commit.resolution,
                commit.treeResolution,
                commit.invocation,
                commit.receipt,
                commit.reservation,
                commit.migration
            )
        ) {
            throw new TypeError("Root commit fields are invalid");
        }
        return;
    }
    if (commit.kind === "merge") {
        if (
            commit.writer.kind !== "system" ||
            commit.writer.cause.kind !== "control" ||
            commit.resolution === undefined ||
            commit.content === undefined ||
            commit.receipt === undefined ||
            !forbidden(commit.selects, commit.invocation, commit.reservation, commit.migration)
        ) {
            throw new TypeError("Merge commit fields are invalid");
        }
        if ((commit.treeResolution === undefined) !== (commit.treeCheckpoint === undefined)) {
            throw new TypeError("Tree resolution and checkpoint must occur together");
        }
        const resolution = commit.resolution;
        if (
            resolution.kind === "pick" &&
            !commit.parents.some((parent) => parent.equals(resolution.parent))
        ) {
            throw new TypeError("Merge pick must name one ordered parent");
        }
        const tree = commit.treeResolution;
        if (
            tree !== undefined &&
            ((tree.policy === "ours" && !tree.side.equals(commit.parents[0]!)) ||
                (tree.policy === "theirs" && !tree.side.equals(commit.parents[1]!)) ||
                (tree.policy === "perPath" &&
                    tree.resolutions.some(
                        (path) => !commit.parents.some((parent) => parent.equals(path.side))
                    )))
        ) {
            throw new TypeError("Tree resolution sides must name ordered merge parents");
        }
        return;
    }
    if (commit.parents.length !== 1) throw new TypeError("Unary Run commits require one parent");
    if (commit.kind === "invocation") {
        if (
            commit.writer.kind !== "system" ||
            commit.writer.cause.kind !== "receipt" ||
            commit.invocation === undefined ||
            commit.receipt === undefined ||
            !forbidden(
                commit.content,
                commit.selects,
                commit.resolution,
                commit.treeResolution,
                commit.reservation,
                commit.migration
            )
        ) {
            throw new TypeError("Invocation commit fields are invalid");
        }
        return;
    }
    if (commit.kind === "eventDelivery") {
        if (
            commit.writer.kind !== "system" ||
            commit.writer.cause.kind !== "delivery" ||
            commit.reservation === undefined ||
            !forbidden(
                commit.content,
                commit.selects,
                commit.resolution,
                commit.treeResolution,
                commit.invocation,
                commit.receipt,
                commit.migration
            )
        ) {
            throw new TypeError("Event delivery commit fields are invalid");
        }
        return;
    }
    if (commit.kind === "undo") {
        requireControl(commit);
        if (
            commit.selects === undefined ||
            !forbidden(
                commit.content,
                commit.subjectTurn,
                commit.resolution,
                commit.treeResolution,
                commit.invocation,
                commit.reservation,
                commit.migration
            )
        )
            throw new TypeError("Undo commit fields are invalid");
        return;
    }
    if (commit.kind === "migration") {
        requireControl(commit);
        if (
            commit.migration === undefined ||
            !commit.pins.equals(commit.migration.to) ||
            !forbidden(
                commit.content,
                commit.subjectTurn,
                commit.selects,
                commit.resolution,
                commit.treeResolution,
                commit.invocation,
                commit.reservation
            )
        ) {
            throw new TypeError("Migration commit fields are invalid");
        }
        return;
    }
    if (commit.kind === "rewrite") {
        requireControl(commit);
        const shadows = commit.shadows;
        if (
            shadows === undefined ||
            // An installed rewrite carries the content read where the shadowed commits
            // stood; an abandoned one shadows nothing and carries none.
            (shadows.length === 0) !== (commit.content === undefined) ||
            shadows.some((shadowed) => shadowed.equals(commit.id)) ||
            new Set(shadows.map((shadowed) => shadowed.value)).size !== shadows.length ||
            !forbidden(
                commit.subjectTurn,
                commit.selects,
                commit.treeCheckpoint,
                commit.resolution,
                commit.treeResolution,
                commit.invocation,
                commit.reservation,
                commit.migration
            )
        ) {
            throw new TypeError("Rewrite commit fields are invalid");
        }
        return;
    }
    if (
        commit.writer.kind !== "turn" ||
        commit.subjectTurn === undefined ||
        commit.content === undefined ||
        !forbidden(
            commit.selects,
            commit.resolution,
            commit.treeResolution,
            commit.invocation,
            commit.receipt,
            commit.reservation,
            commit.migration
        )
    ) {
        throw new TypeError("Turn-authored commit fields are invalid");
    }
}

function requireControl(commit: RunCommit): void {
    if (
        commit.writer.kind !== "system" ||
        commit.writer.cause.kind !== "control" ||
        commit.receipt === undefined
    )
        throw new TypeError("Control commit requires exact control evidence");
}

function copyWriter(writer: CommitWriter): CommitWriter {
    if (writer.kind === "root") return Object.freeze({ kind: "root" });
    if (writer.kind === "turn")
        return Object.freeze({ kind: "turn", token: copyToken(writer.token) });
    const cause: SystemCause = Object.freeze({ ...writer.cause });
    return Object.freeze({ kind: "system", cause });
}

function writerData(writer: CommitWriter): JsonValue {
    if (writer.kind === "root") return { kind: "root" };
    if (writer.kind === "turn") return { kind: "turn", token: tokenData(writer.token) };
    const cause = writer.cause;
    return cause.kind === "delivery"
        ? {
              kind: "system",
              cause: {
                  kind: cause.kind,
                  audit: cause.audit.value,
                  reservation: cause.reservation.value
              }
          }
        : {
              kind: "system",
              cause: { kind: cause.kind, audit: cause.audit.value, receipt: cause.receipt.value }
          };
}

function requireCommitWriter(value: JsonValue): CommitWriter {
    const object = requireObject(value, "Commit writer");
    const kind = requireString(object["kind"], "Commit writer kind");
    if (kind === "root") {
        requireExactFields(object, ["kind"], [], "Root writer");
        return { kind };
    }
    if (kind === "turn") {
        requireExactFields(object, ["kind", "token"], [], "Turn writer");
        return { kind, token: requireLeaseToken(object["token"]!) };
    }
    if (kind !== "system") throw new TypeError("Commit writer kind is invalid");
    requireExactFields(object, ["cause", "kind"], [], "System writer");
    const cause = requireObject(object["cause"]!, "System cause");
    const causeKind = requireString(cause["kind"], "System cause kind");
    if (causeKind === "delivery") {
        requireExactFields(cause, ["audit", "kind", "reservation"], [], "Delivery cause");
        return {
            kind,
            cause: {
                kind: causeKind,
                audit: new AuditRecordId(requireString(cause["audit"], "Delivery audit")),
                reservation: new RouteReservationId(
                    requireString(cause["reservation"], "Delivery reservation")
                )
            }
        };
    }
    if (causeKind === "receipt" || causeKind === "control") {
        requireExactFields(cause, ["audit", "kind", "receipt"], [], "Receipt cause");
        return {
            kind,
            cause: {
                kind: causeKind,
                audit: new AuditRecordId(requireString(cause["audit"], "Receipt audit")),
                receipt: new ReceiptId(requireString(cause["receipt"], "Receipt evidence"))
            }
        };
    }
    throw new TypeError("System cause kind is invalid");
}

function copyResolution(value: MergeResolution): MergeResolution {
    return value.kind === "pick"
        ? Object.freeze({ kind: value.kind, parent: value.parent })
        : value.kind === "concat"
          ? Object.freeze({ kind: value.kind })
          : Object.freeze({
                kind: value.kind,
                token: copyToken(value.token),
                receipt: value.receipt
            });
}

function resolutionData(value: MergeResolution): JsonValue {
    return value.kind === "pick"
        ? { kind: value.kind, parent: value.parent.value }
        : value.kind === "concat"
          ? { kind: value.kind }
          : { kind: value.kind, token: tokenData(value.token), receipt: value.receipt.value };
}

function requireMergeResolution(value: JsonValue): MergeResolution {
    const object = requireObject(value, "Merge resolution");
    const kind = requireString(object["kind"], "Merge resolution kind");
    if (kind === "pick") {
        requireExactFields(object, ["kind", "parent"], [], "Pick resolution");
        return { kind, parent: new RunCommitId(requireString(object["parent"], "Picked parent")) };
    }
    if (kind === "concat") {
        requireExactFields(object, ["kind"], [], "Concat resolution");
        return { kind };
    }
    if (kind === "synthesize") {
        requireExactFields(object, ["kind", "receipt", "token"], [], "Synthesis resolution");
        return {
            kind,
            token: requireLeaseToken(object["token"]!),
            receipt: new ReceiptId(requireString(object["receipt"], "Synthesis Receipt"))
        };
    }
    throw new TypeError("Merge resolution kind is invalid");
}

function copyTreeResolution(value: TreeMergeResolution): TreeMergeResolution {
    if (value.policy !== "perPath") return Object.freeze({ ...value });
    const paths = value.resolutions.map((path) => Object.freeze({ ...path }));
    if (new Set(paths.map((path) => path.path)).size !== paths.length) {
        throw new TypeError("Tree path resolutions must be unique");
    }
    return Object.freeze({ ...value, resolutions: Object.freeze(paths) });
}

function treeResolutionData(value: TreeMergeResolution): JsonValue {
    return value.policy === "perPath"
        ? {
              policy: value.policy,
              base: value.base.value,
              environment: value.environment,
              resolutions: value.resolutions.map((path) => ({
                  path: path.path,
                  side: path.side.value
              }))
          }
        : {
              policy: value.policy,
              base: value.base.value,
              environment: value.environment,
              side: value.side.value
          };
}

function requireTreeMergeResolution(value: JsonValue): TreeMergeResolution {
    const object = requireObject(value, "Tree resolution");
    const policy = requireString(object["policy"], "Tree resolution policy");
    const base = new ContentRef(requireString(object["base"], "Tree merge base"));
    const environment = requireString(object["environment"], "Tree merge Environment");
    if (policy === "ours" || policy === "theirs") {
        requireExactFields(
            object,
            ["base", "environment", "policy", "side"],
            [],
            "Tree side resolution"
        );
        return {
            policy,
            base,
            environment,
            side: new RunCommitId(requireString(object["side"], "Tree side"))
        };
    }
    if (policy !== "perPath") throw new TypeError("Tree resolution policy is invalid");
    requireExactFields(
        object,
        ["base", "environment", "policy", "resolutions"],
        [],
        "Per-path resolution"
    );
    return {
        policy,
        base,
        environment,
        resolutions: requireArray(object["resolutions"], "Path resolutions").map((entry) => {
            const path = requireObject(entry, "Path resolution");
            requireExactFields(path, ["path", "side"], [], "Path resolution");
            return {
                path: requireString(path["path"], "Resolved path"),
                side: new RunCommitId(requireString(path["side"], "Resolved side"))
            };
        })
    };
}

function migrationFromData(value: JsonValue): RunMigration {
    const object = requireObject(value, "Run migration");
    requireExactFields(object, ["from", "to"], [], "Run migration");
    return { from: RunPins.fromData(object["from"]!), to: RunPins.fromData(object["to"]!) };
}

function tokenData(token: LeaseToken): JsonValue {
    return leaseTokenToData(token);
}

function requireLeaseToken(value: JsonValue): LeaseToken {
    return leaseTokenFromData(value);
}

function copyToken(token: LeaseToken): LeaseToken {
    if (!(token.turn instanceof TurnId)) {
        throw new TypeError("Lease token turn must be a TurnId");
    }
    if (!(token.holder instanceof PrincipalRef)) {
        throw new TypeError("Lease token holder must be a PrincipalRef");
    }
    if (!Number.isSafeInteger(token.epoch) || token.epoch < 0) {
        throw new TypeError("Lease token epoch must be a non-negative safe integer");
    }
    return Object.freeze({ turn: token.turn, holder: token.holder, epoch: token.epoch });
}

function optionalIdsEqual(left: TurnId | undefined, right: TurnId | undefined): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function invalidWriter(message: string): AgentCoreError {
    return new AgentCoreError("run.invalid-state", message);
}

function deniedEvidence(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function requireCommitKind(value: JsonValue | undefined): RunCommitKind {
    if (isMember(RUN_COMMIT_KINDS, value)) return value;
    throw new TypeError("Run commit kind is invalid");
}

function optionalId<Value>(
    value: JsonValue | undefined,
    create: (value: string) => Value,
    subject: string
): Value | undefined {
    const decoded = requireOptionalString(value, subject);
    return decoded === undefined ? undefined : create(decoded);
}

function optionalIds<Value>(
    value: JsonValue | undefined,
    create: (value: string) => Value,
    subject: string
): readonly Value[] | undefined {
    if (value === undefined || value === null) return undefined;
    return requireArray(value, subject).map((entry) => create(requireString(entry, subject)));
}
