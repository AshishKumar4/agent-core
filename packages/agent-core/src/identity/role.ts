import { RecordCodec, type JsonValue } from "../core";
import { CapabilitySpec, isCapabilityEffect, type CapabilityEffect, type Impact } from "../facets";
import {
    invalid,
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityString
} from "./codec";
import { RoleName } from "./id";

export type RoleRuleEffect = CapabilityEffect;
export type RoleImpact = Impact;

const OWNER_NAME = "owner";
const EDITOR_NAME = "editor";
const READER_NAME = "reader";
const ALL_IMPACTS: readonly RoleImpact[] = Object.freeze([
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
]);

export class RoleRule {
    public readonly capability: CapabilitySpec;

    public constructor(
        public readonly effect: RoleRuleEffect,
        capability: CapabilitySpec
    ) {
        if (!isCapabilityEffect(effect)) {
            throw new TypeError("Role rule effect is invalid");
        }
        if (!(capability instanceof CapabilitySpec)) {
            throw new TypeError("Role rule capability must be a CapabilitySpec");
        }
        this.capability = capability;
        Object.freeze(this);
    }
}

class RoleRecordCodec extends RecordCodec<Role> {
    public constructor() {
        super("identity.role", { major: 1, minor: 0 });
    }

    protected encodePayload(role: Role): JsonValue {
        return {
            name: role.name.value,
            rules: role.rules.map((rule) => ({
                capability: rule.capability.toData(),
                effect: rule.effect
            }))
        };
    }

    protected decodePayload(payload: JsonValue): Role {
        const object = requireIdentityObject(payload, "Role payload");
        requireIdentityFields(object, ["name", "rules"], "Role payload");
        const rules = object["rules"];
        if (!Array.isArray(rules)) {
            throw invalid("Role rules must be an array");
        }
        return new Role(
            new RoleName(requireIdentityString(object["name"], "Role name")),
            rules.map(decodeRoleRule)
        );
    }
}

export class Role {
    public static readonly codec: RecordCodec<Role> = new RoleRecordCodec();
    public readonly rules: readonly RoleRule[];

    public constructor(
        public readonly name: RoleName,
        rules: readonly RoleRule[]
    ) {
        this.rules = Object.freeze(rules.map((rule) => new RoleRule(rule.effect, rule.capability)));
        Object.freeze(this);
    }

    public static encode(role: Role): Uint8Array {
        return Role.codec.encode(role);
    }

    public static decode(bytes: Uint8Array): Role {
        return Role.codec.decode(bytes);
    }
}

export const OWNER_ROLE = builtInRole(OWNER_NAME, ALL_IMPACTS);
export const EDITOR_ROLE = builtInRole(
    EDITOR_NAME,
    ALL_IMPACTS.filter((impact) => impact !== "administer")
);
export const READER_ROLE = builtInRole(READER_NAME, ["observe"]);
export const BUILT_IN_ROLES: readonly Role[] = Object.freeze([
    OWNER_ROLE,
    EDITOR_ROLE,
    READER_ROLE
]);

export function findBuiltInRole(name: RoleName | string): Role | undefined {
    const value = typeof name === "string" ? name : name.value;
    return BUILT_IN_ROLES.find((role) => role.name.value === value);
}

function builtInRole(name: string, impacts: readonly RoleImpact[]): Role {
    return new Role(new RoleName(name), [
        new RoleRule(
            "allow",
            new CapabilitySpec({
                argumentConstraints: {},
                facetPattern: "*",
                impacts: Object.freeze([...impacts]) as [Impact, ...Impact[]],
                operations: []
            })
        )
    ]);
}

function decodeRoleRule(value: JsonValue): RoleRule {
    const object = requireIdentityObject(value, "Role rule");
    requireIdentityFields(object, ["capability", "effect"], "Role rule");
    const effect = object["effect"];
    if (!isCapabilityEffect(effect)) {
        throw invalid("Role rule effect is invalid");
    }
    return new RoleRule(effect, CapabilitySpec.fromData(object["capability"]));
}
