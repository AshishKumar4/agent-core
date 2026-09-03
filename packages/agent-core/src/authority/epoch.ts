import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    type JsonValue,
    RecordCodec,
    type RecordVersion,
    Revision,
    TextId,
    compareCanonicalText,
    isNonempty
} from "../core";
import { AgentCoreError } from "../errors";
import { PrincipalId, PrincipalRef, ProjectId, ScopeRef, TenantId, WorkspaceId } from "../identity";
import {
    requireArray,
    requireExact,
    requireObject,
    requireSafeInteger,
    requireString,
    type JsonObject
} from "./data";
import { decodeAuthorityScope, encodeAuthorityScope, scopeKey } from "./reference";

class ScopeEpochCodecV1 extends RecordCodec<ScopeEpoch> {
    public constructor() {
        super(
            [ScopeEpoch, ScopeRef, TextId, TenantId, WorkspaceId, ProjectId],
            "authority.scope-epoch",
            { major: 1, minor: 0 }
        );
    }
    protected encodePayload(record: ScopeEpoch): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue, _version: RecordVersion): ScopeEpoch {
        return ScopeEpoch.fromData(payload);
    }
}

class PathEpochEvidenceCodecV1 extends RecordCodec<PathEpochEvidence> {
    public constructor() {
        super(
            [PathEpochEvidence, ScopeEpoch, ScopeRef, TextId, ProjectId, TenantId, WorkspaceId],
            "authority.path-epoch-evidence",
            {
                major: 1,
                minor: 0
            }
        );
    }
    protected encodePayload(record: PathEpochEvidence): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): PathEpochEvidence {
        return PathEpochEvidence.fromData(payload);
    }
}

class InvalidationWatermarkCodecV1 extends RecordCodec<InvalidationWatermark> {
    public constructor() {
        super(
            [
                InvalidationWatermark,
                ActorRef,
                Revision,
                TextId,
                ScopeEpoch,
                ActorId,
                TenantId,
                WorkspaceId,
                ProjectId,
                PrincipalId,
                PrincipalRef,
                ScopeRef
            ],
            "authority.invalidation-watermark",
            { major: 1, minor: 0 }
        );
    }
    protected encodePayload(record: InvalidationWatermark): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): InvalidationWatermark {
        return InvalidationWatermark.fromData(payload);
    }
}

export class ScopeEpoch {
    public static get codec(): RecordCodec<ScopeEpoch> {
        return scopeEpochCodecInstance;
    }
    public constructor(
        public readonly scope: ScopeRef,
        public readonly epoch: number
    ) {
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Scope epoch must be a non-negative safe integer");
        }
        Object.freeze(this);
    }

    public static initial(scope: ScopeRef): ScopeEpoch {
        return new ScopeEpoch(scope, 0);
    }

    public static encode(record: ScopeEpoch): Uint8Array {
        return ScopeEpoch.codec.encode(record);
    }
    public static decode(bytes: Uint8Array): ScopeEpoch {
        return ScopeEpoch.codec.decode(bytes);
    }

    public next(): ScopeEpoch {
        if (this.epoch === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Authority epoch is exhausted for ${scopeKey(this.scope)}`
            );
        }
        return new ScopeEpoch(this.scope, this.epoch + 1);
    }

    public equals(other: ScopeEpoch): boolean {
        return scopeKey(this.scope) === scopeKey(other.scope) && this.epoch === other.epoch;
    }

    public toData(): JsonObject {
        return { epoch: this.epoch, scope: encodeAuthorityScope(this.scope) };
    }

    public static fromData(value: JsonValue | undefined): ScopeEpoch {
        const object = requireObject(value, "Scope epoch");
        requireExact(object, ["epoch", "scope"], "Scope epoch");
        return new ScopeEpoch(
            decodeAuthorityScope(object["scope"]!),
            requireSafeInteger(object, "epoch", "Scope epoch")
        );
    }
}

const scopeEpochCodecInstance = new ScopeEpochCodecV1();

export class PathEpochEvidence {
    public static get codec(): RecordCodec<PathEpochEvidence> {
        return pathEpochEvidenceCodecInstance;
    }
    public readonly path: readonly [ScopeEpoch, ...ScopeEpoch[]];

    public constructor(path: readonly [ScopeEpoch, ...ScopeEpoch[]]) {
        validatePath(path);
        this.path = Object.freeze([...path]);
        Object.freeze(this);
    }

    public static encode(record: PathEpochEvidence): Uint8Array {
        return PathEpochEvidence.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): PathEpochEvidence {
        return PathEpochEvidence.codec.decode(bytes);
    }

    public get target(): ScopeEpoch {
        return this.path[this.path.length - 1]!;
    }

    public equals(other: PathEpochEvidence): boolean {
        return (
            this.path.length === other.path.length &&
            this.path.every((entry, index) => entry.equals(other.path[index]!))
        );
    }

    public staleScopes(current: PathEpochEvidence): readonly ScopeRef[] {
        if (this.path.length !== current.path.length) {
            return Object.freeze(current.path.map((entry) => entry.scope));
        }
        return Object.freeze(
            current.path
                .filter((entry, index) => {
                    const previous = this.path[index]!;
                    return (
                        scopeKey(entry.scope) !== scopeKey(previous.scope) ||
                        entry.epoch !== previous.epoch
                    );
                })
                .map((entry) => entry.scope)
        );
    }

    public toData(): JsonObject {
        return { path: this.path.map((entry) => entry.toData()) };
    }

    public static fromData(value: JsonValue | undefined): PathEpochEvidence {
        const object = requireObject(value, "Path epoch evidence");
        requireExact(object, ["path"], "Path epoch evidence");
        const path = requireArray(object["path"], "Path epoch evidence").map(ScopeEpoch.fromData);
        if (!isNonempty(path)) throw new TypeError("Path epoch evidence must not be empty");
        return new PathEpochEvidence(path);
    }
}

const pathEpochEvidenceCodecInstance = new PathEpochEvidenceCodecV1();

export class InvalidationWatermark {
    public static get codec(): RecordCodec<InvalidationWatermark> {
        return invalidationWatermarkCodecInstance;
    }
    public readonly delivered: readonly ScopeEpoch[];

    public constructor(
        public readonly ownerTenant: TenantId,
        public readonly owner: ActorRef,
        public readonly holder: PrincipalRef,
        delivered: readonly ScopeEpoch[],
        public readonly revision: Revision
    ) {
        const unique = new Map<string, ScopeEpoch>();
        for (const entry of delivered) {
            if (!entry.scope.tenantId.equals(ownerTenant)) {
                throw new TypeError("Watermark entries must belong to the owning Tenant");
            }
            const key = scopeKey(entry.scope);
            if (unique.has(key)) throw new TypeError("Watermark Scope entries must be unique");
            unique.set(key, entry);
        }
        this.delivered = Object.freeze(
            [...unique.values()].sort((left, right) =>
                compareCanonicalText(scopeKey(left.scope), scopeKey(right.scope))
            )
        );
        Object.freeze(this);
    }

    public static empty(
        ownerTenant: TenantId,
        owner: ActorRef,
        holder: PrincipalRef
    ): InvalidationWatermark {
        return new InvalidationWatermark(ownerTenant, owner, holder, [], Revision.initial());
    }

    public static encode(record: InvalidationWatermark): Uint8Array {
        return InvalidationWatermark.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): InvalidationWatermark {
        return InvalidationWatermark.codec.decode(bytes);
    }

    public epoch(scope: ScopeRef): number {
        return (
            this.delivered.find((entry) => scopeKey(entry.scope) === scopeKey(scope))?.epoch ?? 0
        );
    }

    public join(entries: readonly ScopeEpoch[]): InvalidationWatermark {
        const joined = new Map(this.delivered.map((entry) => [scopeKey(entry.scope), entry]));
        let changed = false;
        for (const entry of entries) {
            if (!entry.scope.tenantId.equals(this.ownerTenant)) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Watermark join entries must belong to the owning Tenant"
                );
            }
            const key = scopeKey(entry.scope);
            const previous = joined.get(key);
            if (previous === undefined || entry.epoch > previous.epoch) {
                joined.set(key, entry);
                changed = true;
            }
        }
        if (changed && this.revision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Invalidation watermark revision is exhausted"
            );
        }
        return changed
            ? new InvalidationWatermark(
                  this.ownerTenant,
                  this.owner,
                  this.holder,
                  [...joined.values()],
                  this.revision.next()
              )
            : this;
    }

    public dominates(other: InvalidationWatermark): boolean {
        return (
            this.ownerTenant.equals(other.ownerTenant) &&
            this.owner.equals(other.owner) &&
            this.holder.equals(other.holder) &&
            other.delivered.every((entry) => this.epoch(entry.scope) >= entry.epoch)
        );
    }

    public toData(): JsonObject {
        return {
            delivered: this.delivered.map((entry) => entry.toData()),
            holder: {
                principal: this.holder.principalId.value,
                tenant: this.holder.tenantId.value
            },
            owner: { id: this.owner.id.value, kind: this.owner.kind },
            ownerTenant: this.ownerTenant.value,
            revision: this.revision.value
        };
    }

    public static fromData(value: JsonValue | undefined): InvalidationWatermark {
        const object = requireObject(value, "Invalidation watermark");
        requireExact(
            object,
            ["delivered", "holder", "owner", "ownerTenant", "revision"],
            "Invalidation watermark"
        );
        const holder = requireObject(object["holder"], "Watermark holder");
        const owner = requireObject(object["owner"], "Watermark owner");
        requireExact(holder, ["principal", "tenant"], "Watermark holder");
        requireExact(owner, ["id", "kind"], "Watermark owner");
        return new InvalidationWatermark(
            new TenantId(requireString(object, "ownerTenant", "Watermark owner Tenant")),
            new ActorRef(
                requireActorKind(owner["kind"]),
                new ActorId(requireString(owner, "id", "Watermark owner ID"))
            ),
            new PrincipalRef(
                new TenantId(requireString(holder, "tenant", "Watermark holder Tenant")),
                new PrincipalId(requireString(holder, "principal", "Watermark holder Principal"))
            ),
            requireArray(object["delivered"], "Watermark entries").map(ScopeEpoch.fromData),
            new Revision(requireSafeInteger(object, "revision", "Watermark revision"))
        );
    }
}

const invalidationWatermarkCodecInstance = new InvalidationWatermarkCodecV1();

/**
 * The deepest authority path: the longest exact Scope chain the enumeration below admits,
 * `tenant,project,workspace`. Named rather than written as a literal, because its source
 * is that enumeration and not a chosen ceiling — adding a Scope kind to the chain set is
 * what may move it.
 */
const MAX_AUTHORITY_PATH_SCOPES = 3;

function validatePath(path: readonly ScopeEpoch[]): void {
    if (path.length < 1 || path.length > MAX_AUTHORITY_PATH_SCOPES) {
        throw new TypeError("Authority path must contain one to three Scopes");
    }
    const kinds = path.map((entry) => entry.scope.kind).join(",");
    if (
        kinds !== "tenant" &&
        kinds !== "tenant,project" &&
        kinds !== "tenant,workspace" &&
        kinds !== "tenant,project,workspace"
    ) {
        throw new TypeError("Authority path must be an exact Tenant-to-target Scope chain");
    }
    if (new Set(path.map((entry) => scopeKey(entry.scope))).size !== path.length) {
        throw new TypeError("Authority path Scopes must be unique");
    }
    const target = path[path.length - 1]!.scope;
    if (path.some((entry) => !entry.scope.tenantId.equals(target.tenantId))) {
        throw new TypeError("Authority path Scopes must share one Tenant");
    }
    if (target.kind === "workspace" && target.projectId !== undefined) {
        const project = path.find((entry) => entry.scope.kind === "project")?.scope;
        if (project?.projectId === undefined || !project.projectId.equals(target.projectId)) {
            throw new TypeError("Authority path must include the Workspace's exact Project");
        }
    }
    const exact = target.path;
    if (
        exact.length !== path.length ||
        exact.some((scope, index) => !scope.equals(path[index]!.scope))
    ) {
        throw new TypeError("Authority path must equal the target Scope's canonical ancestry");
    }
}

function requireActorKind(value: JsonValue | undefined): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    )
        return value;
    throw new TypeError("Watermark owner Actor kind is invalid");
}
