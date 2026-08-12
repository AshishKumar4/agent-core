import { describe, expect, test } from "vitest";
import { JsonSchema, SemVer } from "../../src/core";
import {
    Blueprint,
    BlueprintMeta,
    BlueprintDeclarationCodecPort,
    Config,
    DeploymentId,
    DeploymentKey,
    MaterializationGenerationId,
    PlatformCompatibility,
    PlacementInput,
    PlacementPolicy,
    PlacementSelection,
    PolicySet,
    PackageDependency,
    PackageId,
    PackageInstall,
    RunPinEvidence,
    canonicalCompatibilityRange,
    compatibilityAdmits,
    evaluatePolicy
} from "../../src/definition";
import { SlotAuthorityPolicy, SlotDeclaration, SlotName } from "../../src/facets";
import { TenantId } from "../../src/identity";
import { AgentCoreError } from "../../src/errors";
import { definitionRevisionConflict, invalidDefinition } from "../../src/definition/error";
import { compareText } from "../../src/definition/order";

describe("definition value boundaries", () => {
    test("orders canonical text without locale-dependent collation", { tags: "p0" }, () => {
        expect(compareText("a", "a")).toBe(0);
        expect(compareText("a", "b")).toBe(-1);
        expect(compareText("b", "a")).toBe(1);
    });

    test(
        "derives stable Tenant-scoped deployment identities and rejects malformed IDs",
        { tags: "p1" },
        () => {
            const key = new DeploymentKey("platform");
            const first = DeploymentId.derive(new TenantId("tenant-a"), key);
            const same = DeploymentId.derive(
                new TenantId("tenant-a"),
                new DeploymentKey("platform")
            );
            const other = DeploymentId.derive(new TenantId("tenant-b"), key);
            expect(first.equals(same)).toBe(true);
            expect(first.equals(other)).toBe(false);
            expect(() => new DeploymentKey(" padded ")).toThrow(/canonical/);
            expect(() => new DeploymentId("not-a-digest")).toThrow(/SHA-256/);
            expect(new MaterializationGenerationId("0".repeat(64)).value).toBe("0".repeat(64));
            expect(() => new MaterializationGenerationId("not-a-digest")).toThrow(/SHA-256/);
        }
    );

    test(
        "requires one owner-published declaration codec and canonical owner output",
        { tags: "p1" },
        () => {
            expect(
                () =>
                    new BlueprintDeclarationCodecPort([
                        { field: "agents", canonicalize: (value) => value },
                        { field: "agents", canonicalize: (value) => value }
                    ])
            ).toThrow(/Duplicate/);
            const port = new BlueprintDeclarationCodecPort([
                { field: "agents", canonicalize: () => ({ name: "canonical" }) }
            ]);
            expect(port.canonicalize("agents", { name: "input" })).toEqual({ name: "canonical" });
            expect(() => port.canonicalize("environments", {})).toThrow(/Missing owner-published/);
        }
    );

    test(
        "validates canonical compatibility ranges and exact target admission",
        { tags: "p1" },
        () => {
            expect(canonicalCompatibilityRange("^1", "Range")).toBe(">=1.0.0 <2.0.0-0");
            expect(() => canonicalCompatibilityRange(" ", "Range")).toThrow(/nonblank/);
            expect(() => canonicalCompatibilityRange("not-semver", "Range")).toThrow(/valid/);
            const target = new PlatformCompatibility({
                spec: new SemVer("1.0.0"),
                host: new SemVer("2.0.0")
            });
            expect(compatibilityAdmits({ spec: "^1", host: ">=2" }, target)).toBe(true);
            expect(compatibilityAdmits({ spec: "^2", host: ">=2" }, target)).toBe(false);
        }
    );

    test("requires complete nonduplicated fail-closed RunPins evidence", { tags: "p0" }, () => {
        expect(RunPinEvidence.clear().permitsChange).toBe(true);
        expect(new RunPinEvidence("blocked", ["b", "a"]).blockers).toEqual(["a", "b"]);
        expect(new RunPinEvidence("blocked", ["run"]).permitsChange).toBe(false);
        expect(() => new RunPinEvidence("clear", ["run"])).toThrow(/Clear RunPins/);
        expect(() => new RunPinEvidence("unknown", [])).toThrow(/all other evidence/);
        expect(() => new RunPinEvidence("partial", ["same", "same"])).toThrow(/unique/);
    });

    test(
        "exercises strict Blueprint PackageInstall and root access boundaries",
        { tags: "p1" },
        () => {
            const install = new PackageInstall({
                request: new PackageDependency(new PackageId("package"), "^1"),
                config: new Config({ enabled: true })
            });
            const rawInstall = new PackageInstall({
                request: install.request,
                config: { enabled: true }
            });
            expect(new PackageInstall({ request: install.request }).config.toData()).toEqual({});
            expect(PackageInstall.fromData(install.toData()).toData()).toEqual(rawInstall.toData());
            const declaration = {
                toData: () =>
                    new SlotDeclaration(
                        new SlotName("custom.slot"),
                        new JsonSchema({ type: "object" }),
                        new SlotAuthorityPolicy(["installed"], ["scope.read"])
                    ).toData()
            };
            const blueprint = new Blueprint({
                meta: { name: "platform", version: new SemVer("1.0.0") },
                packages: [install],
                policies: PolicySet.empty(),
                agents: [],
                slots: [declaration]
            });
            expect(blueprint.root("package")).toBeDefined();
            expect(blueprint.root(new PackageId("package"))).toBeDefined();
            expect(blueprint.root("missing")).toBeUndefined();
            expect(
                () =>
                    new Blueprint({
                        meta: blueprint.meta,
                        packages: [],
                        policies: {} as never,
                        agents: []
                    })
            ).toThrow(/PolicySet/);
            expect(() =>
                PackageInstall.fromData({ request: install.request.toData() } as never)
            ).toThrow(/missing or unknown/);
            expect(() => BlueprintMeta.fromData(null)).toThrow(/object/);
            expect(() => BlueprintMeta.fromData({ name: 7, version: "1.0.0" })).toThrow(/string/);
            expect(() =>
                Blueprint.fromData({ ...(blueprint.toData() as object), agents: null })
            ).toThrow(/array/);
        }
    );

    test(
        "names each identifier subject and anchors digest identifiers end to end",
        { tags: "p1" },
        () => {
            expect(() => new PackageId("")).toThrow(
                /Package ID must contain between 1 and 256 characters/
            );
            expect(() => new MaterializationGenerationId("")).toThrow(
                /Materialization generation ID must contain between 1 and 256 characters/
            );
            expect(() => new DeploymentKey("")).toThrow(
                /Deployment key must contain between 1 and 256 characters/
            );
            expect(() => new DeploymentId("")).toThrow(
                /Deployment ID must contain between 1 and 256 characters/
            );
            const hex = "0".repeat(64);
            expect(() => new MaterializationGenerationId(`z${hex}`)).toThrow(/SHA-256/);
            expect(() => new MaterializationGenerationId(`${hex}z`)).toThrow(/SHA-256/);
            expect(() => new DeploymentId(`z${hex}`)).toThrow(/SHA-256/);
            expect(() => new DeploymentId(`${hex}z`)).toThrow(/SHA-256/);
        }
    );

    test("definition error helpers carry their exact taxonomy codes", { tags: "p1" }, () => {
        const invalid = invalidDefinition("Definition input rejected");
        expect(invalid).toBeInstanceOf(AgentCoreError);
        expect(invalid.code).toBe("operation.invalid-input");
        expect(invalid.message).toBe("Definition input rejected");
        const conflict = definitionRevisionConflict("Definition revision conflicted");
        expect(conflict).toBeInstanceOf(AgentCoreError);
        expect(conflict.code).toBe("protocol.revision-conflict");
        expect(conflict.message).toBe("Definition revision conflicted");
    });

    test(
        "rejects empty and padded compatibility ranges with their exact subjects",
        { tags: "p1" },
        () => {
            expect(() => canonicalCompatibilityRange("", "Range")).toThrow(
                /Range must be a nonblank canonical range/
            );
            expect(() => canonicalCompatibilityRange("1.0.0 ", "Range")).toThrow(
                /Range must be a nonblank canonical range/
            );
            const target = new PlatformCompatibility({
                spec: new SemVer("1.0.0"),
                host: new SemVer("1.0.0")
            });
            expect(() => compatibilityAdmits({ spec: " ", host: "*" }, target)).toThrow(
                /Spec compatibility range must be a nonblank canonical range/
            );
            expect(() => compatibilityAdmits({ spec: "*", host: " " }, target)).toThrow(
                /Host compatibility range must be a nonblank canonical range/
            );
        }
    );

    test(
        "rejects malformed placement and policy values at public constructors",
        { tags: "p1" },
        () => {
            const input = new PlacementInput({
                manifest: ["dynamic"],
                policy: ["dynamic"],
                substrate: ["dynamic"],
                trust: ["dynamic"]
            });
            expect(() => new PlacementSelection(input, "provider")).toThrow(/every admissible/);
            expect(() => PlacementPolicy.fromData(null)).toThrow(/object/);
            expect(() =>
                PlacementPolicy.fromData({ allowed: "dynamic", trusted: ["*"] })
            ).toThrow(/array/);
            expect(
                PlacementPolicy.fromData({ allowed: ["provider"], trusted: ["*"] }).allowed
            ).toEqual(["provider"]);
            expect(
                PlacementPolicy.fromData({ allowed: ["bundled"], trusted: ["*"] }).allowed
            ).toEqual(["bundled"]);
            expect(() => new PlacementPolicy(["invalid" as never])).toThrow(/unknown/);
            expect(() =>
                PolicySet.fromData({
                    approvals: [],
                    maxDirectRevocationWindowMs: null,
                    placement: { allowed: ["dynamic"], trusted: ["*"] },
                    tiers: {
                        execute: "invalid"
                    }
                })
            ).toThrow(/tier/);
            expect(() =>
                PolicySet.fromData({
                    approvals: "execute",
                    maxDirectRevocationWindowMs: null,
                    placement: { allowed: ["dynamic"], trusted: ["*"] },
                    tiers: {}
                })
            ).toThrow(/array/);
            expect(() => new PolicySet({ approvals: ["invalid" as never] })).toThrow(/impact/);
            expect(() => PolicySet.fromData(null)).toThrow(/object/);
            expect(() => new PolicySet({ tiers: { unknown: "direct" } as never })).toThrow(
                /unknown impact/
            );
            expect(() =>
                evaluatePolicy({
                    impact: "observe",
                    turnOwnedSession: true,
                    sessionFilesystemTarget: false,
                    placement: "invalid" as never
                })
            ).toThrow(/placement/);
        }
    );
});
