import { ContentRef, Digest, RecordCodec, encodeCanonicalJson, type JsonValue } from "../../core";
import { requireSynchronousResult } from "../../actors";
import { AgentCoreError } from "../../errors";
import { PrincipalId } from "../../identity";
import { RunCommitId, TurnId } from "../../execution-references";
import { ReceiptId } from "../../invocation-references";
import { AuditRecordId, InvocationId, RouteReservationId } from "../../interaction-references";
import {
    CodecRecord,
    requireArray,
    requireExactFields,
    requireObject,
    requireOptionalString,
    requireString
} from "../record-data";
import { RunBranchId, RunId } from "./id";
import type { LeaseToken } from "./lease";
import { RunPins } from "./pins";
import type { RunEvidencePort } from "./evidence";

export type RunCommitKind =
    | "root"
    | "message"
    | "checkpoint"
    | "invocation"
    | "eventDelivery"
    | "result"
    | "merge"
    | "verdict"
    | "undo"
    | "migration";

export type SystemCause =
    | { readonly kind: "receipt"; readonly audit: AuditRecordId; readonly receipt: ReceiptId }
    | {
          readonly kind: "delivery";
          readonly audit: AuditRecordId;
          readonly reservation: RouteReservationId;
      }
    | { readonly kind: "control"; readonly audit: AuditRecordId; readonly receipt: ReceiptId };

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

export interface RunCommitInit {
    readonly id: RunCommitId;
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly kind: RunCommitKind;
    readonly parents: readonly RunCommitId[];
    readonly pins: RunPins;
    readonly writer: CommitWriter;
    readonly subjectTurn?: TurnId;
    readonly content?: ContentRef;
    readonly selects?: RunCommitId;
    readonly treeCheckpoint?: ContentRef;
    readonly resolution?: MergeResolution;
    readonly treeResolution?: TreeMergeResolution;
    readonly invocation?: InvocationId;
    readonly receipt?: ReceiptId;
    readonly reservation?: RouteReservationId;
    readonly migration?: { readonly from: RunPins; readonly to: RunPins };
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
    public readonly pins: RunPins;
    public readonly writer: CommitWriter;
    public readonly subjectTurn: TurnId | undefined;
    public readonly content: ContentRef | undefined;
    public readonly selects: RunCommitId | undefined;
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
        this.parents = Object.freeze([...init.parents]);
        this.pins = RunPins.fromData(init.pins.toData());
        this.writer = copyWriter(init.writer);
        this.subjectTurn = init.subjectTurn;
        this.content = init.content;
        this.selects = init.selects;
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
        validateClosedShape(this);
        this.proposalDigest = Digest.sha256(encodeCanonicalJson(this.proposalData()));
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            ...(this.proposalData() as object),
            writer: writerData(this.writer)
        } as JsonValue;
    }

    public proposalData(): JsonValue {
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
                "resolution",
                "run",
                "selects",
                "subjectTurn",
                "treeCheckpoint",
                "treeResolution",
                "writer"
            ],
            [],
            "Run commit"
        );
        const migration = object["migration"];
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
            ...optionalId(
                object["subjectTurn"],
                (value) => new TurnId(value),
                "Run subject Turn",
                "subjectTurn"
            ),
            ...optionalId(
                object["content"],
                (value) => new ContentRef(value),
                "Run content",
                "content"
            ),
            ...optionalId(
                object["selects"],
                (value) => new RunCommitId(value),
                "Run selection",
                "selects"
            ),
            ...optionalId(
                object["treeCheckpoint"],
                (value) => new ContentRef(value),
                "Tree checkpoint",
                "treeCheckpoint"
            ),
            ...(object["resolution"] === null
                ? {}
                : { resolution: requireMergeResolution(object["resolution"]!) }),
            ...(object["treeResolution"] === null
                ? {}
                : { treeResolution: requireTreeMergeResolution(object["treeResolution"]!) }),
            ...optionalId(
                object["invocation"],
                (value) => new InvocationId(value),
                "Run Invocation",
                "invocation"
            ),
            ...optionalId(
                object["receipt"],
                (value) => new ReceiptId(value),
                "Run Receipt",
                "receipt"
            ),
            ...optionalId(
                object["reservation"],
                (value) => new RouteReservationId(value),
                "Run reservation",
                "reservation"
            ),
            ...(migration === null || migration === undefined
                ? {}
                : { migration: migrationFromData(migration) })
        });
    }
}

class CommitCodec extends RecordCodec<RunCommit> {
    public constructor() {
        super("run.commit", { major: 1, minor: 0 });
    }

    protected encodePayload(value: RunCommit): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): RunCommit {
        return RunCommit.fromData(value);
    }
}

export const RunCommitCodec: RecordCodec<RunCommit> = new CommitCodec();

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
            !(["message", "checkpoint", "result", "verdict"] as RunCommitKind[]).includes(
                commit.kind
            ) ||
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
    const found = requireSynchronousResult(
        evidence.control(transaction, cause.receipt, cause.audit)
    );
    if (
        !(commit.kind === "merge" || commit.kind === "undo" || commit.kind === "migration") ||
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
    if (commit.resolution?.kind === "synthesize") {
        const synthesis = requireSynchronousResult(
            evidence.synthesis(transaction, commit.resolution.receipt)
        );
        if (
            synthesis === undefined ||
            !synthesis.run.equals(commit.run) ||
            !synthesis.receipt.equals(commit.resolution.receipt) ||
            !tokensEqual(synthesis.token, commit.resolution.token) ||
            !commit.content?.equals(synthesis.content)
        ) {
            throw deniedEvidence("Synthesis evidence does not match the exact token and content");
        }
    }
}

function validateClosedShape(commit: RunCommit): void {
    const forbidden = (...values: readonly unknown[]): boolean =>
        values.every((value) => value === undefined);
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
            commit.parents.length !== 2 ||
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
    const cause = writer.cause;
    return Object.freeze({ kind: "system", cause: Object.freeze({ ...cause }) }) as CommitWriter;
}

function writerData(writer: CommitWriter): JsonValue {
    if (writer.kind === "root") return { kind: "root" };
    if (writer.kind === "turn") return { kind: "turn", token: tokenData(writer.token) };
    const cause = writer.cause;
    return cause.kind === "receipt"
        ? {
              kind: "system",
              cause: { kind: cause.kind, audit: cause.audit.value, receipt: cause.receipt.value }
          }
        : cause.kind === "delivery"
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

function migrationFromData(value: JsonValue): { readonly from: RunPins; readonly to: RunPins } {
    const object = requireObject(value, "Run migration");
    requireExactFields(object, ["from", "to"], [], "Run migration");
    return { from: RunPins.fromData(object["from"]!), to: RunPins.fromData(object["to"]!) };
}

function tokenData(token: LeaseToken): JsonValue {
    return { epoch: token.epoch, holder: token.holder.value, turn: token.turn.value };
}

function requireLeaseToken(value: JsonValue): LeaseToken {
    const object = requireObject(value, "Lease token");
    requireExactFields(object, ["epoch", "holder", "turn"], [], "Lease token");
    const epoch = object["epoch"];
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
        throw new TypeError("Lease token epoch is invalid");
    }
    return Object.freeze({
        turn: new TurnId(requireString(object["turn"], "Lease token Turn")),
        holder: new PrincipalId(requireString(object["holder"], "Lease token holder")),
        epoch
    });
}

function copyToken(token: LeaseToken): LeaseToken {
    if (!Number.isSafeInteger(token.epoch) || token.epoch < 0) {
        throw new TypeError("Lease token epoch is invalid");
    }
    return Object.freeze({ turn: token.turn, holder: token.holder, epoch: token.epoch });
}

function tokensEqual(left: LeaseToken, right: LeaseToken): boolean {
    return (
        left.turn.equals(right.turn) &&
        left.holder.equals(right.holder) &&
        left.epoch === right.epoch
    );
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
    const kinds: readonly RunCommitKind[] = [
        "root",
        "message",
        "checkpoint",
        "invocation",
        "eventDelivery",
        "result",
        "merge",
        "verdict",
        "undo",
        "migration"
    ];
    if (typeof value === "string" && kinds.includes(value as RunCommitKind))
        return value as RunCommitKind;
    throw new TypeError("Run commit kind is invalid");
}

function optionalId<Key extends string, Value>(
    value: JsonValue | undefined,
    create: (value: string) => Value,
    subject: string,
    key: Key
): { readonly [P in Key]?: Value } {
    const decoded = requireOptionalString(value, subject);
    return decoded === undefined
        ? {}
        : ({ [key]: create(decoded) } as { readonly [P in Key]?: Value });
}
