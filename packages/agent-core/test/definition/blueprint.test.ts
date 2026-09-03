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
import { recordData, requireObject } from "./record-data";

describe("Blueprint", () => {
    test(
        "[definition.blueprint] [definition.package-install] round-trips strict canonical declaration data",
        { tags: "p0" },
        () => {
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
                policies: new PolicySet({ placement: new PlacementPolicy(["dynamic"], ["*"]) }),
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
        }
    );

    test("requires unique root package requests", { tags: "p1" }, () => {
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

    test(
        "produces deterministic bytes for equivalent root and object ordering",
        { tags: "p0" },
        () => {
            const left = new Blueprint({
                meta: { name: "deterministic", version: new SemVer("1.0.0") },
                packages: [
                    install("zeta", "^2", { z: 2, a: 1 }),
                    install("alpha", "^1", { enabled: true })
                ],
                policies: new PolicySet({
                    placement: PlacementPolicy.all(),
                    tiers: { execute: "mediated", observe: "direct" }
                }),
                agents: []
            });
            const right = new Blueprint({
                meta: { version: new SemVer("1.0.0"), name: "deterministic" },
                packages: [
                    install("alpha", "^1", { enabled: true }),
                    install("zeta", "^2", { a: 1, z: 2 })
                ],
                policies: new PolicySet({
                    placement: PlacementPolicy.all(),
                    tiers: { observe: "direct", execute: "mediated" }
                }),
                agents: []
            });

            expect(Blueprint.encode(left)).toEqual(Blueprint.encode(right));
            expect(left.packages.map((entry) => entry.request.id.value)).toEqual(["alpha", "zeta"]);
        }
    );

    test("rejects unknown codec fields and malformed optional declarations", { tags: "p1" }, () => {
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

    test(
        "keeps every optional declaration group in canonical Blueprint data",
        { tags: "p1" },
        () => {
            const blueprint = new Blueprint({
                meta: { name: "complete", version: new SemVer("1.0.0") },
                packages: [],
                policies: PolicySet.empty(),
                scopes: { project: "default" },
                agents: [{ name: "helper" }],
                slots: [],
                subscriptions: [{ event: "task.created" }],
                environments: [{ name: "sandbox" }],
                surfaces: { primary: "owner.slot" }
            });
            const data = requireObject(blueprint.toData());
            expect(data["scopes"]).toEqual({ project: "default" });
            expect(data["subscriptions"]).toEqual([{ event: "task.created" }]);
            expect(data["environments"]).toEqual([{ name: "sandbox" }]);
            expect(data["surfaces"]).toEqual({ primary: "owner.slot" });
        }
    );

    test("names each malformed declaration subject at construction", { tags: "p1" }, () => {
        const meta = { name: "subjects", version: new SemVer("1.0.0") };
        const base = { meta, packages: [], policies: PolicySet.empty() };
        expect(() => new Blueprint({ ...base, agents: [], scopes: 7 })).toThrow(
            /Blueprint scope scaffold must be an object declaration/
        );
        expect(() => new Blueprint({ ...base, agents: [7] })).toThrow(
            /Blueprint agent must be an object declaration/
        );
        expect(() => new Blueprint({ ...base, agents: [[]] })).toThrow(
            /Blueprint agent must be an object declaration/
        );
        expect(() => new Blueprint({ ...base, agents: ["text"] })).toThrow(
            /Blueprint agent must be an object declaration/
        );
        expect(() => new Blueprint({ ...base, agents: [], slots: [7] })).toThrow(
            /Blueprint slot must be an object declaration/
        );
        expect(() => new Blueprint({ ...base, agents: [], surfaces: 7 })).toThrow(
            /Blueprint surface layout must be an object declaration/
        );
        const dataAgent = new Blueprint({ ...base, agents: [{ toData: 7 }] });
        expect(dataAgent.agents[0]).toEqual({ toData: 7 });
    });

    test(
        "rejects nonobject payloads, entry positions, and unknown metadata keys",
        { tags: "p1" },
        () => {
            expect(() => Blueprint.fromData([])).toThrow(/Blueprint must be an object/);
            expect(() => Blueprint.fromData("text")).toThrow(/Blueprint must be an object/);
            const valid = new Blueprint({
                meta: { name: "strict", version: new SemVer("1.0.0") },
                packages: [],
                policies: PolicySet.empty(),
                agents: []
            });
            expect(() => Blueprint.fromData({ ...recordData(valid), agents: [7] })).toThrow(
                /Blueprint agents entry 0 must be an object/
            );

            expect(() => BlueprintMeta.fromData({ name: 7, version: "1.0.0" })).toThrow(
                /Blueprint name must be a string/
            );
            expect(() => BlueprintMeta.fromData({ name: "x", version: 7 })).toThrow(
                /Blueprint version must be a string/
            );
            expect(() => new BlueprintMeta("", new SemVer("1.0.0"))).toThrow(
                /Blueprint name must be a nonblank canonical string/
            );
            expect(() => new BlueprintMeta("name ", new SemVer("1.0.0"))).toThrow(
                /Blueprint name must be a nonblank canonical string/
            );

            const request = { id: "package", range: ">=1.0.0 <2.0.0-0" };
            for (const unknown of ["legacy", "Stryker was here"]) {
                expect(() =>
                    BlueprintMeta.fromData({ name: "x", version: "1.0.0", [unknown]: true })
                ).toThrow(/Blueprint metadata contains missing or unknown fields/);
                expect(() =>
                    PackageInstall.fromData({ config: {}, request, [unknown]: true })
                ).toThrow(/Package install contains missing or unknown fields/);
            }
        }
    );
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

function expectCodecError(action: () => void): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code: "codec.invalid" });
    }
}
