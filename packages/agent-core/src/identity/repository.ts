import { compareCanonicalText } from "../core";
import type {
    GuestTrustId,
    MembershipId,
    PrincipalId,
    ProjectId,
    RoleName,
    ShareOfferId,
    TeamId,
    TenantId,
    WorkspaceId
} from "./id";
import { AgentCoreError } from "../errors";
import { GuestTrust } from "./guest-trust";
import { Membership } from "./member";
import { Principal } from "./principal";
import { Project } from "./project";
import { Role } from "./role";
import { ShareOffer } from "./share-offer";
import { Team } from "./team";
import { Tenant } from "./tenant";
import { Workspace } from "./workspace";

export type IdentityRecordKind =
    | "membership"
    | "guestTrust"
    | "principal"
    | "project"
    | "role"
    | "shareOffer"
    | "team"
    | "tenant"
    | "workspace";

export interface StoredIdentityRecord {
    readonly kind: IdentityRecordKind;
    readonly id: string;
    readonly bytes: Uint8Array;
}

export interface MemoryIdentitySnapshot {
    readonly version: 1;
    readonly records: readonly StoredIdentityRecord[];
}

export abstract class IdentityRepository {
    public abstract loadPrincipal(id: PrincipalId): Principal | undefined;
    public abstract loadTenant(id: TenantId): Tenant | undefined;
    public abstract loadTeam(id: TeamId): Team | undefined;
    public abstract loadProject(id: ProjectId): Project | undefined;
    public abstract loadWorkspace(id: WorkspaceId): Workspace | undefined;
    public abstract loadGuestTrust(id: GuestTrustId): GuestTrust | undefined;
    public abstract loadRole(name: RoleName): Role | undefined;
    public abstract loadMembership(id: MembershipId): Membership | undefined;
    public abstract loadShareOffer(id: ShareOfferId): ShareOffer | undefined;
}

export class MemoryIdentityRepository extends IdentityRepository {
    readonly #records = new Map<string, StoredIdentityRecord>();

    public constructor(snapshot: MemoryIdentitySnapshot = emptySnapshot()) {
        super();
        requireSnapshot(snapshot);
        for (const stored of snapshot.records) {
            const record = copyRecord(stored);
            const key = recordKey(record.kind, record.id);
            if (this.#records.has(key)) {
                throw corruptIdentitySnapshot(
                    "Memory identity snapshot contains duplicate records"
                );
            }
            verifyRecord(record);
            this.#records.set(key, record);
        }
    }

    public loadPrincipal(id: PrincipalId): Principal | undefined {
        return this.load("principal", id.value, Principal.decode);
    }

    public loadTenant(id: TenantId): Tenant | undefined {
        return this.load("tenant", id.value, Tenant.decode);
    }

    public loadTeam(id: TeamId): Team | undefined {
        return this.load("team", id.value, Team.decode);
    }

    public loadProject(id: ProjectId): Project | undefined {
        return this.load("project", id.value, Project.decode);
    }

    public loadWorkspace(id: WorkspaceId): Workspace | undefined {
        return this.load("workspace", id.value, Workspace.decode);
    }

    public loadGuestTrust(id: GuestTrustId): GuestTrust | undefined {
        return this.load("guestTrust", id.value, GuestTrust.decode);
    }

    public loadRole(name: RoleName): Role | undefined {
        return this.load("role", name.value, Role.decode);
    }

    public loadMembership(id: MembershipId): Membership | undefined {
        return this.load("membership", id.value, Membership.decode);
    }

    public loadShareOffer(id: ShareOfferId): ShareOffer | undefined {
        return this.load("shareOffer", id.value, ShareOffer.decode);
    }

    public snapshot(): MemoryIdentitySnapshot {
        return Object.freeze({
            version: 1 as const,
            records: Object.freeze(
                [...this.#records.values()]
                    .sort((left, right) =>
                        compareCanonicalText(
                            recordKey(left.kind, left.id),
                            recordKey(right.kind, right.id)
                        )
                    )
                    .map(copyRecord)
            )
        });
    }

    private load<Record>(
        kind: IdentityRecordKind,
        id: string,
        decode: (bytes: Uint8Array) => Record
    ): Record | undefined {
        const record = this.#records.get(recordKey(kind, id));
        return record === undefined ? undefined : decode(record.bytes.slice());
    }
}

function emptySnapshot(): MemoryIdentitySnapshot {
    return Object.freeze({ version: 1, records: Object.freeze([]) });
}

function requireSnapshot(snapshot: unknown): asserts snapshot is MemoryIdentitySnapshot {
    if (
        !isIdentitySnapshotCandidate(snapshot) ||
        !hasExactKeys(snapshot, ["records", "version"]) ||
        snapshot.version !== 1 ||
        !Array.isArray(snapshot.records)
    ) {
        throw corruptIdentitySnapshot("Memory identity snapshot is malformed");
    }
}

function verifyRecord(record: StoredIdentityRecord): void {
    const id =
        record.kind === "principal"
            ? Principal.decode(record.bytes).id.value
            : record.kind === "tenant"
              ? Tenant.decode(record.bytes).id.value
              : record.kind === "team"
                ? Team.decode(record.bytes).id.value
                : record.kind === "project"
                  ? Project.decode(record.bytes).id.value
                  : record.kind === "workspace"
                    ? Workspace.decode(record.bytes).id.value
                    : record.kind === "guestTrust"
                      ? GuestTrust.decode(record.bytes).id.value
                      : record.kind === "role"
                        ? Role.decode(record.bytes).name.value
                        : record.kind === "shareOffer"
                          ? ShareOffer.decode(record.bytes).id.value
                          : Membership.decode(record.bytes).id.value;
    if (id !== record.id) {
        throw corruptIdentitySnapshot("Stored identity key does not match its codec record");
    }
}

function copyRecord(record: StoredIdentityRecord): StoredIdentityRecord {
    if (
        !isStoredIdentityRecord(record) ||
        !hasExactKeys(record, ["bytes", "id", "kind"]) ||
        record.id.length === 0 ||
        !(record.bytes instanceof Uint8Array)
    ) {
        throw corruptIdentitySnapshot("Memory identity snapshot record is malformed");
    }
    return Object.freeze({ kind: record.kind, id: record.id, bytes: record.bytes.slice() });
}

function isRecordKind(value: string): value is IdentityRecordKind {
    return (
        value === "membership" ||
        value === "guestTrust" ||
        value === "principal" ||
        value === "project" ||
        value === "role" ||
        value === "shareOffer" ||
        value === "team" ||
        value === "tenant" ||
        value === "workspace"
    );
}

function recordKey(kind: IdentityRecordKind, id: string): string {
    return `${kind}\u0000${id}`;
}

function corruptIdentitySnapshot(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function hasExactKeys(
    value: IdentitySnapshotCandidate | StoredIdentityRecord,
    keys: readonly string[]
): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

interface IdentitySnapshotCandidate {
    readonly records?: unknown;
    readonly version?: unknown;
}

function isIdentitySnapshotCandidate(value: unknown): value is IdentitySnapshotCandidate {
    return value !== null && typeof value === "object";
}

function isStoredIdentityRecord(value: unknown): value is StoredIdentityRecord {
    return (
        value !== null &&
        typeof value === "object" &&
        "kind" in value &&
        typeof value.kind === "string" &&
        isRecordKind(value.kind) &&
        "id" in value &&
        typeof value.id === "string" &&
        "bytes" in value &&
        value.bytes instanceof Uint8Array
    );
}
