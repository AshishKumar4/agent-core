import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    SemVer,
    encodeCanonicalJson,
    requireNonempty,
    type JsonValue
} from "../../src/core";
import {
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageId,
    PackageRelease
} from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import {
    Contribution,
    Contributions,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    Operation,
    OperationDescriptor,
    OperationName,
    SlotName,
    type FacetData
} from "../../src/facets";
import { FacetCorrespondenceValidator } from "../../src/operations";

const schema = new JsonSchema({ type: "object" });
const operationsSlot = new SlotName("operations");
const facetId = new FacetPackageId("acme.gateway");

/**
 * The four fields an Operation descriptor always declares. `interceptable` is deliberately
 * not among them: SPEC §4.1 makes it present exactly when the capability is offered, so a
 * withheld capability has no key here to carry a value.
 */
const withheldData: Readonly<Record<string, FacetData>> = {
    impact: "observe",
    input: { type: "object" },
    name: "read",
    output: { type: "object" }
};

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

function manifestOf(descriptors: readonly OperationDescriptor[]): FacetManifest {
    return new FacetManifest({
        id: facetId,
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(
                operationsSlot,
                descriptors.map((entry) => entry.toData())
            )
        ])
    });
}

function releaseOf(manifest: FacetManifest): PackageRelease {
    return new PackageRelease({
        id: new PackageId("acme.gateway"),
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

/**
 * A manifest whose sole `operations` entry carries the negative encoding. Built as raw slot
 * data because that is the only way it can exist: OperationDescriptor refuses to construct
 * one, so nothing downstream of the class can produce these bytes by accident.
 */
function negativeManifest(): FacetManifest {
    return new FacetManifest({
        id: facetId,
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(operationsSlot, [{ ...withheldData, interceptable: false }])
        ])
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

/** The smallest runtime that answers install verification for one declared Operation. */
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

describe("W3 capability declarations", () => {
    test(
        "[C13-FACET-CAPABILITY-ABSENCE] withholds a capability by absence and refuses every present negative form",
        { tags: "p1" },
        () => {
            const withheld = descriptor();
            const offered = descriptor(true);

            // Absence is the withheld form all the way down: the field, the canonical data,
            // and the bytes. A decoder that read absence as `false` and re-emitted it would
            // produce a key here, and would then be refused by its own decoder below.
            expect(withheld.interceptable).toBeUndefined();
            expect(Object.keys(withheld.toData() as object).sort()).toEqual([
                "impact",
                "input",
                "name",
                "output"
            ]);
            expect(
                OperationDescriptor.decode(OperationDescriptor.encode(withheld)).interceptable
            ).toBeUndefined();

            // Presence is the offered form, and it survives the same round trip. Without this
            // half, dropping the declaration entirely would satisfy the clause above.
            expect(offered.interceptable).toBe(true);
            expect(offered.toData()).toEqual({ ...withheldData, interceptable: true });
            expect(
                OperationDescriptor.decode(OperationDescriptor.encode(offered)).interceptable
            ).toBe(true);

            // Every negative encoding of the withheld meaning, collected before asserting so one
            // run describes the whole shape of the gap rather than its first edge.
            const negatives: readonly JsonValue[] = [false, null, 0, "", "false", "no", []];
            const refused = negatives.map((value) => {
                try {
                    OperationDescriptor.fromData({ ...withheldData, interceptable: value });
                    return { value, refused: false, message: "" };
                } catch (error) {
                    return {
                        value,
                        refused: true,
                        message: error instanceof Error ? error.message : String(error)
                    };
                }
            });
            expect(refused.filter((outcome) => !outcome.refused)).toEqual([]);
            expect(
                refused.filter((outcome) =>
                    /must be absent rather than a negative or null value/.test(outcome.message)
                ).length
            ).toBe(negatives.length);

            // The class refuses the same form the decoder does, so no construction path exists
            // on which the negative encoding survives.
            // @ts-expect-error A withheld capability has no negative value to pass.
            expect(() => descriptor(false)).toThrow(
                /Operation interceptable declaration must be absent/
            );

            // Across the codec envelope the refusal keeps a code a caller can branch on.
            const negativeBytes = encodeCanonicalJson({
                kind: "facet.operation-descriptor",
                version: { major: 1, minor: 0 },
                payload: { ...withheldData, interceptable: false }
            });
            const decoded = ((): AgentCoreError | undefined => {
                try {
                    OperationDescriptor.decode(negativeBytes);
                    return undefined;
                } catch (error) {
                    return error instanceof AgentCoreError ? error : undefined;
                }
            })();
            expect(decoded?.code).toBe("codec.invalid");
        }
    );

    test(
        "[C13-FACET-CAPABILITY-ABSENCE] gives a withheld capability one manifest digest and refuses the negative form at install verification",
        { tags: "p1" },
        () => {
            const withheldRelease = releaseOf(manifestOf([descriptor()]));
            const offeredRelease = releaseOf(manifestOf([descriptor(true)]));

            // One meaning, one digest: the withheld manifest built from objects and the same
            // manifest read back from its own canonical data pin the same release.
            const reread = releaseOf(FacetManifest.fromData(withheldRelease.manifests[0].toData()));
            expect(reread.manifestDigest.value).toBe(withheldRelease.manifestDigest.value);

            // And the declaration still moves the digest when it is present, so the equality
            // above is one encoding of the withheld meaning rather than a field the digest
            // stopped reading. Without this half, deleting `interceptable` from the digest
            // input would satisfy the clause above while answering a different question.
            expect(offeredRelease.manifestDigest.value).not.toBe(
                withheldRelease.manifestDigest.value
            );

            // The negative form is refused where a contribution entry is DECODED, which is
            // install verification (C13-FACET-INSTALL-VERIFICATION) and not the manifest
            // codec: `operations` travels through FacetManifest as opaque slot data, because
            // the manifest cannot own the codec of every slot the `slots` meta-contribution
            // may declare. So the manifest and release reads accept the bytes — asserted
            // here rather than left implied, so no later reader mistakes the manifest codec
            // for the gate — and the install refuses them before any lifecycle code runs.
            const negative = negativeManifest();
            expect(FacetManifest.decode(FacetManifest.encode(negative)).id.value).toBe(
                facetId.value
            );
            const validator = new FacetCorrespondenceValidator();
            expect(() => validator.validate([negative], [new StubFacet(negative)])).toThrow(
                /must be absent rather than a negative or null value/
            );

            // The control that makes the refusal about the negative form rather than about the
            // harness: the same runtime installs cleanly once the capability is withheld by
            // absence, and again once it is offered by presence.
            const controls = [undefined, true].map((offered) => {
                const declared = descriptor(offered === true ? true : undefined);
                const manifest = manifestOf([declared]);
                return validator.validate([manifest], [new StubFacet(manifest, declared)]).facets
                    .length;
            });
            expect(controls).toEqual([1, 1]);
        }
    );
});
