// @ts-nocheck
import { Digest, TextId, encodeCanonicalJson } from "../core";

type IdentityIdInput = string | { readonly value: string };

export class GrantId extends TextId {
    public constructor(value: string) {
        super(value, "Grant ID");
        Object.freeze(this);
    }

    public static forRole(membership: IdentityIdInput, ruleOrdinal: number): GrantId {
        validateRoleRuleOrdinal(ruleOrdinal);
        const membershipId = validateIdentityIdValue(membership, "Membership ID");
        const digest = Digest.sha256(
            encodeCanonicalJson({ membership: membershipId, ruleOrdinal })
        );
        return new GrantId(`role:${digest.value}`);
    }
}

function validateRoleRuleOrdinal(ruleOrdinal: number): void {
    if (!Number.isSafeInteger(ruleOrdinal) || ruleOrdinal < 0) {
        throw new TypeError("Role rule ordinal must be a non-negative safe integer");
    }
}

function validateIdentityIdValue(value: IdentityIdInput, name: string): string {
    const result = typeof value === "string" ? value : value.value;
    if (result.length === 0 || result.length > 256) {
        throw new TypeError(`${name} must contain between 1 and 256 characters`);
    }
    return result;
}
