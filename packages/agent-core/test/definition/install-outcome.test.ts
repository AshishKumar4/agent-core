import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, SemVer } from "../../src/core";
import {
    DeploymentId,
    DeploymentKey,
    FacetInstallFailure,
    FacetInstallPhase,
    ManagedOrigin,
    PackageId,
    PackagePin,
    type FacetInstallFailureInit,
    type ManagedOriginInit,
    type MaterializationControlStore
} from "../../src/definition";
import { MemoryMaterializationControlStore } from "../../src/definition/memory";
import { ContributionAttribution, FacetPackageId, FacetRef } from "../../src/facets";
import { TenantId } from "../../src/identity";
import { SqliteMaterializationStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import { fieldWithoutValue, forged, recordData, tamperedRecord } from "./record-data";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const tenantActor = new ActorRef("tenant", new ActorId(tenantId.value));
const deploymentKey = new DeploymentKey("platform");
const deploymentId = DeploymentId.derive(tenantId, deploymentKey);
const packageFacet = new FacetPackageId("failing.package");
const contributor = new FacetRef("failing.package:instance");
const pin = new PackagePin(
    new PackageId("failing.package"),
    new SemVer("1.2.3"),
    digest("manifest"),
    digest("code")
);
const attribution = new ContributionAttribution(contributor, pin);

const BASE_ORIGIN: ManagedOriginInit = {
    tenantId,
    deploymentId,
    attestationDigest: digest("attestation"),
    blueprintDigest: digest("blueprint"),
    packageLockDigest: digest("lock"),
    configDigest: digest("config"),
    generation: 1
};
const materialization = new ManagedOrigin(BASE_ORIGIN);

const BASE_FAILURE: FacetInstallFailureInit = {
    attribution,
    packageFacet,
    manifestDigest: digest("manifest"),
    materialization,
    phase: FacetInstallPhase.start,
    reason: "start threw"
};

describe("failed Facet install evidence", () => {
    installEvidenceContract("memory", () => new MemoryMaterializationControlStore());
    installEvidenceContract("SQLite", () =>
        SqliteMaterializationStore.control(new TestSqlite(), tenantActor)
    );

    test(
        "[C13-FACET-START-ATOMIC] [definition.facet-install-failure] round-trips a failed install and refuses one whose ID is not its own contents",
        { tags: "p0" },
        () => {
            const failure = installFailure();
            const bytes = FacetInstallFailure.encode(failure);
            expect(FacetInstallFailure.encode(FacetInstallFailure.decode(bytes))).toEqual(bytes);
            expect(FacetInstallFailure.decode(bytes).toData()).toEqual(failure.toData());
            expect(FacetInstallFailure.codec.kind).toBe("definition.facet-install-failure");
            expect(FacetInstallFailure.codec.version).toEqual({ major: 1, minor: 0 });
            expect(failure.id.value).toMatch(/^facet-install-failure:[a-f0-9]{64}$/u);

            // Every declared field is digested, so no two of these name one record.
            const distinct = [
                failure,
                installFailure({ reason: "start threw twice" }),
                installFailure({ phase: FacetInstallPhase.materialization }),
                installFailure({ packageFacet: new FacetPackageId("other.package") }),
                installFailure({ manifestDigest: digest("other-manifest") }),
                installFailure({ materialization: originWith({ generation: 2 }) }),
                installFailure({
                    attribution: new ContributionAttribution(
                        new FacetRef("other.package:instance"),
                        pin
                    )
                })
            ].map((record) => record.id.value);
            expect(new Set(distinct).size).toBe(distinct.length);

            // An id the contents do not derive is refused through the data decoder and, because
            // the codec translates a malformed payload, through the encoded record as well.
            const other = installFailure({ reason: "another reason" });
            expect(() =>
                FacetInstallFailure.fromData({ ...recordData(failure), id: other.id.value })
            ).toThrow(/does not match its canonical contents/);
            expect(() =>
                FacetInstallFailure.decode(
                    FacetInstallFailure.encode(tamperedRecord(failure, { id: other.id }))
                )
            ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
            expect(() => FacetInstallFailure.fromData(null)).toThrow(/must be an object/);
            expect(() =>
                FacetInstallFailure.fromData({ ...recordData(failure), unknown: "field" })
            ).toThrow(/missing or unknown fields/);
            expect(() =>
                FacetInstallFailure.fromData(fieldWithoutValue(recordData(failure), "reason"))
            ).toThrow(/reason must be a string/);
            expect(() => installFailure({ reason: " padded " })).toThrow(/nonblank canonical/);
            expect(() => installFailure({ reason: "" })).toThrow(/nonblank canonical/);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] names the phase that can have left records and refuses any other",
        { tags: "p0" },
        () => {
            expect(FacetInstallPhase.start.materializedRecords).toBe(false);
            expect(FacetInstallPhase.materialization.materializedRecords).toBe(true);
            expect([
                FacetInstallPhase.start.label,
                FacetInstallPhase.materialization.label
            ]).toEqual(["start", "materialization"]);
            expect(FacetInstallPhase.fromData("start")).toBe(FacetInstallPhase.start);
            expect(FacetInstallPhase.fromData("materialization")).toBe(
                FacetInstallPhase.materialization
            );
            expect(FacetInstallPhase.start.equals(FacetInstallPhase.start)).toBe(true);
            expect(FacetInstallPhase.start.equals(FacetInstallPhase.materialization)).toBe(false);
            expect(() => FacetInstallPhase.fromData("stop")).toThrow(/Facet install phase must be/);
            expect(() => FacetInstallPhase.fromData(undefined)).toThrow(
                /Facet install phase must be/
            );

            const failure = installFailure({ phase: FacetInstallPhase.materialization });
            expect(FacetInstallFailure.decode(FacetInstallFailure.encode(failure)).phase).toBe(
                FacetInstallPhase.materialization
            );
            expect(() =>
                FacetInstallFailure.fromData({ ...recordData(failure), phase: "stop" })
            ).toThrow(/Facet install phase must be/);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] refuses a retry only against the same contribution and the same unchanged Scope",
        { tags: "p0" },
        () => {
            const failure = installFailure();
            expect(failure.refuses(attribution, materialization)).toBe(true);
            expect(
                failure.refuses(
                    new ContributionAttribution(contributor, pin),
                    new ManagedOrigin(BASE_ORIGIN)
                )
            ).toBe(true);

            expect(
                failure.refuses(
                    new ContributionAttribution(new FacetRef("failing.package:other"), pin),
                    materialization
                )
            ).toBe(false);
            expect(
                failure.refuses(
                    new ContributionAttribution(
                        contributor,
                        new PackagePin(pin.id, pin.version, digest("republished"), pin.codeDigest)
                    ),
                    materialization
                )
            ).toBe(false);
            expect(
                failure.refuses(
                    new ContributionAttribution(
                        contributor,
                        new PackagePin(
                            pin.id,
                            new SemVer("1.2.4"),
                            pin.manifestDigest,
                            pin.codeDigest
                        )
                    ),
                    materialization
                )
            ).toBe(false);

            // Each of the seven fields the ManagedOrigin names is part of the Scope, so changing
            // any one of them admits the retry. A bumped generation is the ordinary case: the
            // Scope moved on, so an older failure no longer speaks for it.
            const changed = {
                attestationDigest: originWith({ attestationDigest: digest("later-attestation") }),
                blueprintDigest: originWith({ blueprintDigest: digest("later-blueprint") }),
                configDigest: originWith({ configDigest: digest("later-config") }),
                deploymentId: originWith({
                    deploymentId: DeploymentId.derive(tenantId, new DeploymentKey("staging"))
                }),
                generation: originWith({ generation: 2 }),
                packageLockDigest: originWith({ packageLockDigest: digest("later-lock") }),
                tenantId: originWith({ tenantId: new TenantId("other-tenant") })
            };
            expect(
                Object.fromEntries(
                    Object.entries(changed).map(([field, origin]) => [
                        field,
                        failure.refuses(attribution, origin)
                    ])
                )
            ).toEqual({
                attestationDigest: false,
                blueprintDigest: false,
                configDigest: false,
                deploymentId: false,
                generation: false,
                packageLockDigest: false,
                tenantId: false
            });
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] restores recorded failed installs from a memory control snapshot",
        { tags: "p1" },
        () => {
            const store = new MemoryMaterializationControlStore();
            const failure = installFailure();
            store.transaction((transaction) => store.insertInstallFailure(transaction, failure));
            const restored = new MemoryMaterializationControlStore(store.snapshot());
            expect(
                refusals(restored, attribution, materialization).map((row) => row.reason)
            ).toEqual([failure.reason]);
            expect(new MemoryMaterializationControlStore().snapshot().installFailures).toEqual([]);
        }
    );

    test(
        "[C13-FACET-START-ATOMIC] refuses a failed install whose evidence is not the exact record it claims",
        { tags: "p0" },
        () => {
            // This record is what answers "is this Scope still refused" after the process that
            // failed is gone, and its ID is derived from these fields. A look-alike in any one
            // of them would derive an ID over contents the durable record does not have, so
            // each is refused where it is written rather than carried into the evidence.
            expect(() =>
                installFailure({
                    attribution: forged<ContributionAttribution>({
                        contributor: contributor.value,
                        package: pin.id.value
                    })
                })
            ).toThrow(/carries its contribution attribution/);
            expect(() =>
                installFailure({ packageFacet: forged<FacetPackageId>(packageFacet.value) })
            ).toThrow(/names the Facet package that failed/);
            expect(() =>
                installFailure({ manifestDigest: forged<Digest>(digest("manifest").value) })
            ).toThrow(/carries its manifest digest and its managed origin/);
            expect(() =>
                installFailure({
                    materialization: forged<ManagedOrigin>({ generation: 1 })
                })
            ).toThrow(/carries its manifest digest and its managed origin/);
            expect(() => installFailure({ phase: forged<FacetInstallPhase>("start") })).toThrow(
                /names the phase its activation stopped in/
            );

            // The refusals above are about the look-alikes: the same fixture with every field
            // exact still builds its record and derives its own ID.
            expect(installFailure().phase).toBe(FacetInstallPhase.start);
            expect(installFailure().id.equals(installFailure().id)).toBe(true);
        }
    );
});

function installEvidenceContract<Transaction>(
    name: string,
    create: () => MaterializationControlStore<Transaction>
): void {
    test(
        `${name} [C13-FACET-START-ATOMIC] [definition.facet-install-failure] records a failed install idempotently and refuses a divergent record under its ID`,
        { tags: "p0" },
        () => {
            const store = create();
            const failure = installFailure();
            store.transaction((transaction) => store.insertInstallFailure(transaction, failure));
            store.transaction((transaction) => store.insertInstallFailure(transaction, failure));
            expect(list(store, attribution).map((row) => row.toData())).toEqual([failure.toData()]);
            expect(refusals(store, attribution, materialization)).toHaveLength(1);
            expect(refusals(store, attribution, originWith({ generation: 2 }))).toHaveLength(0);

            // Same declared id, different contents: the store holds the first bytes and refuses
            // the rewrite rather than deciding which of two failures the id names.
            const divergent = tamperedRecord(failure, { reason: "a different failure entirely" });
            expect(() =>
                store.transaction((transaction) =>
                    store.insertInstallFailure(transaction, divergent)
                )
            ).toThrow(/immutable/);
            expect(list(store, attribution).map((row) => row.reason)).toEqual([failure.reason]);
        }
    );

    test(
        `${name} [C13-FACET-START-ATOMIC] answers only the named attribution, in canonical ID order`,
        { tags: "p0" },
        () => {
            const store = create();
            const republished = new ContributionAttribution(
                contributor,
                new PackagePin(pin.id, pin.version, digest("republished"), pin.codeDigest)
            );
            const foreign = new ContributionAttribution(
                new FacetRef("other.package:instance"),
                pin
            );
            // The order is derived rather than assumed: asserting a fixed order would make the
            // claim vacuous the moment one of these digests changes.
            const named = [
                installFailure(),
                installFailure({ reason: "start threw twice" }),
                installFailure({ phase: FacetInstallPhase.materialization })
            ].sort((left, right) => (left.id.value < right.id.value ? -1 : 1));
            const [republishedFailure, foreignFailure] = [
                installFailure({ attribution: republished }),
                installFailure({ attribution: foreign })
            ];
            store.transaction((transaction) => {
                for (const failure of [...named].reverse()) {
                    store.insertInstallFailure(transaction, failure);
                }
                for (const failure of [republishedFailure, foreignFailure]) {
                    store.insertInstallFailure(transaction, failure);
                }
            });

            expect(list(store, attribution).map((row) => row.id.value)).toEqual(
                named.map((row) => row.id.value)
            );
            expect(list(store, republished).map((row) => row.id.value)).toEqual([
                republishedFailure.id.value
            ]);
            expect(list(store, foreign).map((row) => row.id.value)).toEqual([
                foreignFailure.id.value
            ]);
            expect(
                list(
                    store,
                    new ContributionAttribution(new FacetRef("absent.package:instance"), pin)
                )
            ).toEqual([]);
        }
    );
}

function list<Transaction>(
    store: MaterializationControlStore<Transaction>,
    named: ContributionAttribution
): readonly FacetInstallFailure[] {
    return store.transaction((transaction) => store.listInstallFailures(transaction, named));
}

/** What `FacetInstallEvidencePort.refusals` answers: the failures that refuse one retry. */
function refusals<Transaction>(
    store: MaterializationControlStore<Transaction>,
    named: ContributionAttribution,
    scope: ManagedOrigin
): readonly FacetInstallFailure[] {
    return list(store, named).filter((failure) => failure.refuses(named, scope));
}

function installFailure(overrides: Partial<FacetInstallFailureInit> = {}): FacetInstallFailure {
    return new FacetInstallFailure({ ...BASE_FAILURE, ...overrides });
}

function originWith(overrides: Partial<ManagedOriginInit>): ManagedOrigin {
    return new ManagedOrigin({ ...BASE_ORIGIN, ...overrides });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
