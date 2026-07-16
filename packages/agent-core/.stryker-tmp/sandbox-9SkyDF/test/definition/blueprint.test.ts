// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    JsonSchema,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { Blueprint, BlueprintMeta, PackageInstall } from "../../src/definition/blueprint";
import { Config } from "../../src/definition/config";
import { PackageId } from "../../src/definition/id";
import { PackageDependency } from "../../src/definition/package";
import { PlacementPolicy } from "../../src/definition/placement";
import { PolicySet } from "../../src/definition/policy";
import { SlotAuthorityPolicy, SlotDeclaration, SlotName } from "../../src/facets";

describe("Blueprint", () => {
    test("[definition.blueprint] [definition.package-install] round-trips strict canonical declaration data", () => {
        const agent = { model: { policy: "balanced" }, name: "helper" };
        const blueprint = new Blueprint({
            meta: new BlueprintMeta("support-desk", new SemVer("1.2.0")),
            packages: [install("acme.deploy", "^1", { region: "wnam" })],
            scopes: { projects: [{ name: "default" }] },
            agents: [agent],
            slots: [
                new SlotDeclaration(
                    new SlotName("dashboard.card"),
                    new JsonSchema({ type: "object" }),
                    new SlotAuthorityPolicy(["installed"], ["scope.read"])
                )
            ],
            subscriptions: [{ source: "schedule.daily" }],
            policies: new PolicySet({ placement: new PlacementPolicy(["dynamic"]) }),
            environments: [{ name: "sandbox" }],
            surfaces: { dashboard: ["dashboard.card"] }
        });
        agent.name = "changed";

        const encoded = Blueprint.encode(blueprint);
        const decoded = Blueprint.decode(encoded);
        expect(Blueprint.encode(decoded)).toEqual(encoded);
        expect(decoded.meta.name).toBe("support-desk");
        expect(decoded.agents[0]).toMatchObject({ name: "helper" });
        expect(decoded.slots?.[0]).toMatchObject({ name: "dashboard.card" });
        expect(Object.isFrozen(decoded.policies)).toBe(true);
        expect(Object.isFrozen(decoded.agents[0])).toBe(true);
    });

    test("requires unique root package requests", () => {
        expect(
            () =>
                new Blueprint({
                    meta: { name: "duplicate", version: new SemVer("1.0.0") },
                    packages: [install("same", "^1"), install("same", "^2")],
                    policies: PolicySet.empty(),
                    agents: []
                })
        ).toThrow(/root package IDs must be unique/);
        expect(() => new BlueprintMeta(" ", new SemVer("1.0.0"))).toThrow(/nonblank/);
        expect(
            () =>
                new Blueprint({
                    meta: { name: "invalid-agent", version: new SemVer("1.0.0") },
                    packages: [],
                    policies: PolicySet.empty(),
                    agents: [null]
                })
        ).toThrow(/object declaration/);
    });

    test("produces deterministic bytes for equivalent root and object ordering", () => {
        const left = new Blueprint({
            meta: { name: "deterministic", version: new SemVer("1.0.0") },
            packages: [
                install("zeta", "^2", { z: 2, a: 1 }),
                install("alpha", "^1", { enabled: true })
            ],
            policies: new PolicySet({ tiers: { execute: "mediated", observe: "direct" } }),
            agents: []
        });
        const right = new Blueprint({
            meta: { version: new SemVer("1.0.0"), name: "deterministic" },
            packages: [
                install("alpha", "^1", { enabled: true }),
                install("zeta", "^2", { a: 1, z: 2 })
            ],
            policies: new PolicySet({ tiers: { observe: "direct", execute: "mediated" } }),
            agents: []
        });

        expect(Blueprint.encode(left)).toEqual(Blueprint.encode(right));
        expect(left.packages.map((entry) => entry.request.id.value)).toEqual(["alpha", "zeta"]);
    });

    test("rejects unknown codec fields and malformed optional declarations", () => {
        const blueprint = new Blueprint({
            meta: { name: "strict", version: new SemVer("1.0.0") },
            packages: [],
            policies: PolicySet.empty(),
            agents: []
        });
        const envelope = requireObject(decodeCanonicalJson(Blueprint.encode(blueprint)));
        const payload = requireObject(envelope["payload"]!);

        expectCodecError(() =>
            Blueprint.decode(
                encodeCanonicalJson({
                    ...envelope,
                    payload: { ...payload, legacy: true }
                })
            )
        );
        expectCodecError(() =>
            Blueprint.decode(
                encodeCanonicalJson({
                    ...envelope,
                    payload: { ...payload, agents: ["not-a-declaration"] }
                })
            )
        );
        const { agents: _agents, ...withoutAgents } = payload;
        expectCodecError(() =>
            Blueprint.decode(
                encodeCanonicalJson({
                    ...envelope,
                    payload: withoutAgents
                })
            )
        );
    });
});

function install(
    id: string,
    range: string,
    config: { readonly [name: string]: JsonValue } = {}
): PackageInstall {
    return new PackageInstall({
        request: new PackageDependency(new PackageId(id), range),
        config: new Config(config)
    });
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function expectCodecError(action: () => unknown): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code: "codec.invalid" });
    }
}
