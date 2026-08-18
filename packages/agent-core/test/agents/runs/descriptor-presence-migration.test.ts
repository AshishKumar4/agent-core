import { describe, expect, test } from "vitest";
import { MediaHint } from "../../../src/content";
import { AgentId, AgentPolicyId, ModelPolicyId } from "../../../src/agents/id";
import {
    BlueprintPin,
    RunPinDimension,
    RunPins,
    TurnBoundOperation,
    TurnModelInput,
    TurnOmission,
    TurnPromptSection,
    TurnPromptSectionName,
    TurnShownContent
} from "../../../src/agents/runs";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    encodeCanonicalJson,
    requireNonempty,
    type JsonValue
} from "../../../src/core";
import {
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageId,
    PackagePin,
    PackageRelease
} from "../../../src/definition";
import { EnvironmentId } from "../../../src/environments";
import { AgentCoreError } from "../../../src/errors";
import {
    BindingName,
    Contribution,
    Contributions,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    Operation,
    OperationDescriptor,
    OperationName,
    OperationRef,
    SlotName,
    type FacetData,
    type FacetDataMap
} from "../../../src/facets";
import { FacetCorrespondenceValidator } from "../../../src/operations";

const schema = new JsonSchema({ type: "object" });
const operationsSlot = new SlotName("operations");
const facetId = new FacetPackageId("acme.gateway");
const packageId = new PackageId("acme.gateway");
const encoder = new TextEncoder();

/**
 * The four fields every Operation declaration carries. The superseded encoding of a withheld
 * `interceptable` added a fifth, `interceptable: false`, which no constructor can produce
 * now — so a manifest carrying it has to be built from raw slot data, exactly as a
 * deployment that stored those bytes before the presence rule landed holds them.
 */
const declaredFields = {
    impact: "observe",
    input: { type: "object" },
    name: "read",
    output: { type: "object" }
} satisfies FacetDataMap;

function descriptor(interceptable?: true): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName("read"),
        "observe",
        schema,
        schema,
        undefined,
        interceptable
    );
}

function manifestOf(operations: readonly FacetData[]): FacetManifest {
    return new FacetManifest({
        id: facetId,
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: new Contributions([new Contribution(operationsSlot, operations)])
    });
}

function releaseOf(manifest: FacetManifest): PackageRelease {
    return new PackageRelease({
        id: packageId,
        version: new SemVer("1.0.0"),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests: requireNonempty([manifest], "Facet manifests"),
        codeManifest: new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [
                new PackageCodeModule({
                    specifier: "./main.js",
                    content: ContentRef.fromDigest(Digest.sha256(new Uint8Array([1]))),
                    media: new MediaHint("application/javascript")
                })
            ],
            entrypoints: requireNonempty(
                [
                    new PackageCodeEntrypoint({
                        facet: manifest.id,
                        version: manifest.version,
                        module: "./main.js"
                    })
                ],
                "code entrypoints"
            )
        }),
        provenance: { registry: "test" }
    });
}

function pinOf(release: PackageRelease): PackagePin {
    return new PackagePin(release.id, release.version, release.manifestDigest, release.codeDigest);
}

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

/** Run pins that differ from one another in the Package closure and nowhere else. */
function runPins(pin: PackagePin): RunPins {
    const revision = new Revision(3);
    return new RunPins({
        blueprint: new BlueprintPin("blueprint", new SemVer("1.2.3"), digest("e")),
        packages: [pin],
        agent: { id: new AgentId("agent"), revision, digest: digest("a") },
        effectivePolicy: { id: new AgentPolicyId("policy"), revision, digest: digest("b") },
        modelPolicy: { id: new ModelPolicyId("model"), revision, digest: digest("c") },
        environment: { id: new EnvironmentId("environment"), revision, digest: digest("d") }
    });
}

class StubOperation extends Operation {
    public constructor(public readonly descriptor: OperationDescriptor) {
        super();
    }

    public execute(): Promise<FacetData> {
        return Promise.resolve({});
    }
}

/** The smallest runtime install verification can compare against a pinned manifest. */
class StubFacet extends Facet {
    public readonly ref = new FacetRef("workspace:gateway");

    public constructor(
        public readonly manifest: FacetManifest,
        private readonly implemented: OperationDescriptor = descriptor()
    ) {
        super();
    }

    public operation(): Operation {
        return new StubOperation(this.implemented);
    }

    public surface(): undefined {
        return undefined;
    }

    public interceptor(): undefined {
        return undefined;
    }

    public children(): readonly Facet[] {
        return [];
    }

    public start(): Promise<void> {
        return Promise.resolve();
    }

    public stop(): Promise<void> {
        return Promise.resolve();
    }
}

function boundOperation(declared: OperationDescriptor): TurnBoundOperation {
    return new TurnBoundOperation(
        new BindingName("gateway"),
        new FacetRef("acme.gateway:primary"),
        new OperationRef("acme.gateway:read"),
        declared
    );
}

const promptSection = new TurnPromptSection(
    new TurnPromptSectionName("system"),
    TurnShownContent.inline(encoder.encode("system")),
    TurnOmission.none
);

function modelInput(catalog: readonly TurnBoundOperation[]): TurnModelInput {
    return new TurnModelInput({
        sections: [promptSection],
        catalog,
        admitted: [],
        admissionCut: 0,
        covers: []
    });
}

/** The content address the model input commit derives from (§5.6). */
function contentAddress(record: TurnModelInput): string {
    return Digest.sha256(TurnModelInput.encode(record)).value;
}

describe("Descriptor presence migration", () => {
    test(
        "[MIGRATE-OPERATION-DESCRIPTOR-PRESENCE] carries the declaration inside the Package pin, so the presence change reaches a Run only as a pin divergence",
        { tags: "p0" },
        () => {
            const withheld = releaseOf(manifestOf([descriptor().toData()]));
            const offered = releaseOf(manifestOf([descriptor(true).toData()]));
            const superseded = releaseOf(
                manifestOf([{ ...declaredFields, interceptable: false }])
            );

            // The declaration is inside the release digest, and the pin is that digest: the
            // three encodings of one Operation pin three different Packages. Without this the
            // rest of the chain would be about some other field.
            const digests = [withheld, offered, superseded].map(
                (release) => release.manifestDigest.value
            );
            expect(new Set(digests).size).toBe(3);
            expect(pinOf(withheld).manifestDigest.value).toBe(withheld.manifestDigest.value);
            expect(pinOf(withheld).equals(pinOf(superseded))).toBe(false);
            expect(pinOf(withheld).equals(pinOf(offered))).toBe(false);

            // So the superseded encoding cannot appear inside a Run's pins without the pins
            // themselves diverging, in the one dimension SPEC §5.2's migration commit names.
            // `divergence` is what a merge refuses on, so this is the platform's own reading
            // of the difference rather than a comparison written for this test.
            const divergence = runPins(pinOf(withheld)).divergence(runPins(pinOf(superseded)));
            expect(divergence.map((entry) => entry.dimension.label)).toEqual(["packages"]);
            expect(divergence[0]?.dimension.equals(RunPinDimension.packages)).toBe(true);
            expect(divergence[0]?.identities).toEqual([packageId.value]);
            expect(runPins(pinOf(withheld)).equals(runPins(pinOf(superseded)))).toBe(false);

            // The control that makes the divergence about the declaration rather than about
            // rebuilding a pin: two independently built pin sets over the same release agree
            // in every dimension, so an equal-pins merge stays a merge.
            expect(runPins(pinOf(withheld)).equals(runPins(pinOf(withheld)))).toBe(true);
            expect(runPins(pinOf(withheld)).divergence(runPins(pinOf(withheld)))).toEqual([]);
        }
    );

    test(
        "[MIGRATE-OPERATION-DESCRIPTOR-PRESENCE] refuses every install that mixes a pinned declaration with a runtime that encodes it differently",
        { tags: "p0" },
        () => {
            const validator = new FacetCorrespondenceValidator();
            const withheldManifest = manifestOf([descriptor().toData()]);
            const supersededManifest = manifestOf([{ ...declaredFields, interceptable: false }]);

            // A deployment holding the superseded bytes cannot activate the current runtime:
            // install verification compares the runtime manifest against the pinned one, and
            // absence and a present negative are different bytes. This is the reason the two
            // durable derivations below cannot be crossed silently — nothing resolves an
            // Operation, so nothing mints an Invocation or a modelInput commit.
            expect(() =>
                validator.validate([supersededManifest], [new StubFacet(withheldManifest)])
            ).toThrow(/does not match a pinned manifest/);

            // And the mirror: a runtime still emitting the superseded bytes cannot install
            // against a pin that withholds by absence. Both directions of the boundary refuse,
            // so neither half of a partially upgraded deployment runs.
            expect(() =>
                validator.validate([withheldManifest], [new StubFacet(supersededManifest)])
            ).toThrow(/does not match a pinned manifest/);

            // The control: the pin and the runtime that agree install, once by absence and
            // once by presence, so the refusals above are about the mixed encodings and not
            // about this fixture.
            const installed = [undefined, true].map((offered) => {
                const declared = descriptor(offered === true ? true : undefined);
                const manifest = manifestOf([declared.toData()]);
                return validator.validate([manifest], [new StubFacet(manifest, declared)]).facets
                    .length;
            });
            expect(installed).toEqual([1, 1]);
        }
    );

    test(
        "[MIGRATE-OPERATION-DESCRIPTOR-PRESENCE] refuses a stored model input that carries the superseded declaration and moves its content address with the declaration",
        { tags: "p0" },
        () => {
            const withheld = modelInput([boundOperation(descriptor())]);
            const offered = modelInput([boundOperation(descriptor(true))]);

            // §5.6 settles an unknown outcome by re-reading the commit its content derives,
            // and the content is this record. So the declaration moves the content address,
            // which is what makes a descriptor change a migration question for a modelInput
            // commit rather than a refactor.
            expect(contentAddress(withheld)).not.toBe(contentAddress(offered));

            // The stability half: the same catalog assembled twice derives one address, so the
            // inequality above is the declaration and not incidental encoding order.
            expect(contentAddress(modelInput([boundOperation(descriptor())]))).toBe(
                contentAddress(withheld)
            );

            // A stored record carrying the superseded declaration is refused rather than read
            // as a withheld one. Without this a reconstruction would silently rebuild a
            // catalog the current rule cannot express, and derive an address for it.
            const supersededCatalog: JsonValue = {
                admissionCut: 0,
                admitted: [],
                catalog: [
                    {
                        binding: "gateway",
                        descriptor: { ...declaredFields, interceptable: false },
                        facet: "acme.gateway:primary",
                        operation: "acme.gateway:read"
                    }
                ],
                covers: [],
                sections: [promptSection.toData()]
            };
            expect(() => TurnModelInput.fromData(supersededCatalog)).toThrow(
                /must be absent rather than a negative or null value/
            );

            // Across the codec envelope the refusal keeps a code a caller can branch on, so a
            // substrate read reports a decode failure rather than a missing commit.
            const decoded = ((): AgentCoreError | undefined => {
                try {
                    TurnModelInput.decode(
                        encodeCanonicalJson({
                            kind: "turn.model-input",
                            version: { major: 1, minor: 0 },
                            payload: supersededCatalog
                        })
                    );
                    return undefined;
                } catch (error) {
                    return error instanceof AgentCoreError ? error : undefined;
                }
            })();
            expect(decoded?.code).toBe("codec.invalid");
        }
    );
});
