import type { JsonValue } from "../core";
import {
    invalid,
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityString
} from "./codec";
import { PrincipalId, TeamId, TenantId } from "./id";
import { PrincipalRef } from "./principal-ref";

export type GuestVerificationSchemeValue = "token" | "callback" | "handshake";

export class GuestVerificationScheme {
    public static readonly token = new GuestVerificationScheme("token");
    public static readonly callback = new GuestVerificationScheme("callback");
    public static readonly handshake = new GuestVerificationScheme("handshake");

    /** The closed vocabulary §3.3 fixes, in the order it introduces the schemes. */
    public static readonly all: readonly GuestVerificationScheme[] = Object.freeze([
        GuestVerificationScheme.token,
        GuestVerificationScheme.callback,
        GuestVerificationScheme.handshake
    ]);

    private constructor(public readonly value: GuestVerificationSchemeValue) {
        Object.freeze(this);
    }

    public static from(value: GuestVerificationSchemeValue): GuestVerificationScheme {
        return parseGuestVerificationScheme(value);
    }

    public equals(other: GuestVerificationScheme): boolean {
        return this === other;
    }

    public toString(): string {
        return this.value;
    }
}

function parseGuestVerificationScheme(
    value: GuestVerificationSchemeValue
): GuestVerificationScheme {
    const scheme = GuestVerificationScheme.all.find((candidate) => candidate.value === value);
    if (scheme === undefined) throw new TypeError("Guest verification scheme is invalid");
    return scheme;
}

export interface PrincipalSubjectRef {
    readonly kind: "principal";
    readonly principal: PrincipalRef;
}

export interface TeamSubjectRef {
    readonly kind: "team";
    readonly teamId: TeamId;
}

export interface ForeignPrincipalRef {
    readonly kind: "foreign";
    readonly homeTenant: TenantId;
    readonly principalId: PrincipalId;
    readonly verifiedVia: GuestVerificationScheme;
}

export type SubjectRef = PrincipalSubjectRef | TeamSubjectRef | ForeignPrincipalRef;

export const SubjectRef = Object.freeze({
    principal(principal: PrincipalRef): PrincipalSubjectRef {
        return Object.freeze({ kind: "principal", principal });
    },
    team(teamId: TeamId): TeamSubjectRef {
        return Object.freeze({ kind: "team", teamId });
    },
    foreign(
        homeTenant: TenantId,
        principalId: PrincipalId,
        verifiedVia: GuestVerificationScheme
    ): ForeignPrincipalRef {
        return Object.freeze({ kind: "foreign", homeTenant, principalId, verifiedVia });
    }
});

/**
 * A Principal subject names a Principal of one Tenant, so any record that carries both a
 * subject and the Tenant that owns it rejects a foreign qualification structurally rather
 * than inheriting the Tenant from wherever the record happened to be stored. Cross-Tenant
 * subjects are `ForeignPrincipalRef` and carry their own home Tenant (§3.3).
 */
export function requireSubjectTenant(
    subject: SubjectRef,
    tenantId: TenantId,
    record: string
): void {
    if (subject.kind === "principal" && !subject.principal.tenantId.equals(tenantId)) {
        throw new TypeError(`${record} Principal subject belongs to another Tenant`);
    }
}

export function encodeSubjectRef(subject: SubjectRef): JsonValue {
    if (subject.kind === "principal") {
        return {
            kind: subject.kind,
            principal: subject.principal.principalId.value,
            tenant: subject.principal.tenantId.value
        };
    }
    if (subject.kind === "team") {
        return { kind: subject.kind, team: subject.teamId.value };
    }
    return {
        homeTenant: subject.homeTenant.value,
        kind: subject.kind,
        principal: subject.principalId.value,
        verifiedVia: subject.verifiedVia.value
    };
}

export function decodeSubjectRef(value: JsonValue): SubjectRef {
    const object = requireIdentityObject(value, "Subject reference");
    const kind = object["kind"];
    if (kind === "principal") {
        requireIdentityFields(
            object,
            ["kind", "principal", "tenant"],
            "Principal subject reference"
        );
        return SubjectRef.principal(
            new PrincipalRef(
                new TenantId(requireIdentityString(object["tenant"], "Subject Tenant")),
                new PrincipalId(requireIdentityString(object["principal"], "Subject principal"))
            )
        );
    }
    if (kind === "team") {
        requireIdentityFields(object, ["kind", "team"], "Team subject reference");
        return SubjectRef.team(new TeamId(requireIdentityString(object["team"], "Subject team")));
    }
    if (kind === "foreign") {
        requireIdentityFields(
            object,
            ["homeTenant", "kind", "principal", "verifiedVia"],
            "Foreign subject reference"
        );
        return SubjectRef.foreign(
            new TenantId(requireIdentityString(object["homeTenant"], "Foreign home Tenant")),
            new PrincipalId(requireIdentityString(object["principal"], "Foreign principal")),
            decodeVerificationScheme(object["verifiedVia"])
        );
    }
    throw invalid("Subject reference kind is invalid");
}

function decodeVerificationScheme(value: JsonValue | undefined): GuestVerificationScheme {
    if (value === "token" || value === "callback" || value === "handshake") {
        return GuestVerificationScheme.from(value);
    }
    throw invalid("Guest verification scheme is invalid");
}
