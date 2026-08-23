import { describe, expect, test } from "vitest";
import {
    Revision,
    SecretRef,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import { PackageInstallationProvenancePort } from "../../src/definition";
import type {
    AuthenticatedContribution,
    AuthenticatedPackageInstallation
} from "../../src/definition";
import {
    ContributionAttribution,
    FacetRef,
    FieldMove,
    IngressDeclaration,
    IngressVerification,
    ProvenanceMapping
} from "../../src/facets";
import { TenantId, ScopeRef, WorkspaceId as IdentityWorkspaceId } from "../../src/identity";
import {
    IngressEndpoint,
    IngressEndpointId,
    type IngressEndpointMaterializationInit
} from "../../src/workspaces/ingress-endpoint";
import {
    MemoryIngressEndpointStorage,
    WorkspaceIngressEndpointStore
} from "../../src/workspaces/ingress-store";
import { WorkspaceIngressEndpointMaterializer } from "../../src/workspaces/ingress-endpoint-materializer";
import { authenticatedInstallationFixture, tenant } from "./fixtures";
import { malformed } from "../helpers/malformed";
import { attribution } from "../w3/slot-store-contract";

const otherTenant = new TenantId("tenant-other");
const ownScope = ScopeRef.workspace(tenant, new IdentityWorkspaceId("workspace-scope"));
const foreignScope = ScopeRef.workspace(otherTenant, new IdentityWorkspaceId("workspace-foreign"));

class TestProvenance extends PackageInstallationProvenancePort<
    MemoryIngressEndpointStorage,
    object
> {
    public constructor(public installation: AuthenticatedPackageInstallation | undefined) {
        super();
    }

    protected authenticatedInstallation(): AuthenticatedPackageInstallation | undefined {
        return this.installation;
    }
}

function declared(path = "/hooks/test"): IngressDeclaration {
    return new IngressDeclaration(
        path,
        new IngressVerification("hmac", new SecretRef("env", "provider-test", `secret${path}`)),
        new ProvenanceMapping([new FieldMove("/identity", { literal: "external" })])
    );
}

function endpointFixture(
    suffix = "default",
    init: {
        readonly contribution?: ContributionAttribution;
        readonly retired?: true;
        readonly scope?: ScopeRef;
        readonly path?: string;
    } = {}
): IngressEndpoint {
    return new IngressEndpoint({
        id: new IngressEndpointId(`ingress-${suffix}`),
        revision: Revision.initial(),
        scope: init.scope ?? ownScope,
        declared: declared(init.path ?? `/hooks/${suffix}`),
        contribution: init.contribution,
        retired: init.retired
    });
}

function materializationInit(endpoint: IngressEndpoint): IngressEndpointMaterializationInit {
    return { id: endpoint.id, scope: endpoint.scope, declared: endpoint.declared };
}

function recordPayload(bytes: Uint8Array): JsonObject {
    const envelope = decodeCanonicalJson(bytes);
    if (!isJsonObject(envelope)) throw new TypeError("Record envelope must be an object");
    const payload = envelope["payload"];
    if (!isJsonObject(payload)) throw new TypeError("Record payload must be an object");
    return payload;
}

/** Re-encodes an endpoint envelope with one payload field replaced. */
function reencoded(bytes: Uint8Array, field: string, value: JsonValue): Uint8Array {
    const payload = recordPayload(bytes);
    return encodeCanonicalJson({
        kind: "workspace.ingress-endpoint",
        version: { major: 1, minor: 0 },
        payload: { ...payload, [field]: value }
    });
}

function forgedAuthenticatedContribution<TActual>(value: TActual): AuthenticatedContribution {
    // SAFETY: this value has no private WeakMap entry, and the boundary must reject it.
    return value as TActual & AuthenticatedContribution;
}

interface Harness {
    readonly storage: MemoryIngressEndpointStorage;
    readonly store: WorkspaceIngressEndpointStore<MemoryIngressEndpointStorage>;
    provenance(installation?: AuthenticatedPackageInstallation): TestProvenance;
    restart(): void;
}

function harness(): Harness {
    let storage = new MemoryIngressEndpointStorage();
    const store = new WorkspaceIngressEndpointStore<MemoryIngressEndpointStorage>(
        () => storage,
        tenant
    );
    return {
        storage,
        store,
        provenance: (installation) => new TestProvenance(installation),
        restart(): void {
            storage = MemoryIngressEndpointStorage.restore(storage.snapshot());
        }
    };
}

function prepareAndMaterialize(
    harnessState: Harness,
    installation: AuthenticatedPackageInstallation,
    init: IngressEndpointMaterializationInit
): IngressEndpoint {
    const materializer = new WorkspaceIngressEndpointMaterializer(
        harnessState.store,
        harnessState.provenance(installation)
    );
    const context = {};
    const prepared = materializer.prepareContribution(harnessState.storage, context);
    if (prepared === undefined) {
        throw new TypeError("Authenticated test installation did not prepare a contribution");
    }
    return materializer.materialize(harnessState.storage, context, prepared, init);
}

describe("ingress endpoint record", () => {
    test("round-trips byte-identically and encodes attribution and retirement by presence", () => {
        const contribution = attribution("workspace:ingress");
        const contributed = endpointFixture("wire", { contribution });
        const contributedBytes = IngressEndpoint.encode(contributed);
        expect(IngressEndpoint.decode(contributedBytes).contribution?.equals(contribution)).toBe(
            true
        );
        const payload = recordPayload(contributedBytes);
        expect(payload["contribution"]).toEqual(contribution.encodeFields());
        expect(Object.hasOwn(recordPayload(IngressEndpoint.encode(endpointFixture("direct"))), "contribution")).toBe(false);
        expect(Object.hasOwn(payload, "retired")).toBe(false);

        const retired = contributed.retire();
        const retiredBytes = IngressEndpoint.encode(retired);
        const retiredPayload = recordPayload(retiredBytes);
        expect(retiredPayload["retired"]).toBe(true);
        expect(retiredPayload["contribution"]).toEqual(contribution.encodeFields());
        const reopened = IngressEndpoint.decode(retiredBytes);
        expect(reopened.retired).toBe(true);
        expect(reopened.revision.value).toBe(1);
        expect(IngressEndpoint.encode(reopened)).toEqual(retiredBytes);
    });

    test("refuses a non-canonical or halved attribution at construction and decode", () => {
        const live = endpointFixture("shape");
        expect(
            () =>
                new IngressEndpoint({
                    ...live,
                    contribution: malformed<ContributionAttribution>({
                        contributor: "workspace:forged",
                        package: { id: "workspace:forged", version: "1.0.0" }
                    })
                })
        ).toThrow(new TypeError("Ingress endpoint contribution must carry canonical attribution"));

        const bytes = IngressEndpoint.encode(
            endpointFixture("halved", { contribution: attribution("workspace:halved") })
        );
        for (const halved of [
            null,
            "workspace:halved",
            { contributor: "workspace:halved" },
            { package: { id: "halved-package", version: "1.0.0" } },
            { contributor: "workspace:halved", package: {}, extra: true }
        ] as const) {
            expect(() => IngressEndpoint.decode(reencoded(bytes, "contribution", halved))).toThrow();
        }
        expect(() =>
            IngressEndpoint.decode(reencoded(bytes, "retired", false))
        ).toThrow();
    });

    test("retirement is a contributed-only transition that preserves the exact pair", () => {
        const direct = endpointFixture("unattributed");
        expect(() => direct.retire()).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Only a contributed Ingress endpoint is retired by withdrawal"
            })
        );

        const contribution = attribution("workspace:retiring");
        const contributed = endpointFixture("retiring", { contribution });
        const retired = contributed.retire();
        expect(retired.revision.value).toBe(contributed.revision.value + 1);
        expect(retired.contribution?.equals(contribution)).toBe(true);
        expect(IngressDeclaration.encode(retired.declared)).toEqual(
            IngressDeclaration.encode(contributed.declared)
        );
        expect(retired.scope.equals(contributed.scope)).toBe(true);
        expect(retired.retired).toBe(true);
        expect(contributed.retired).toBeUndefined();
    });
});

describe("ingress endpoint store", () => {
    test("creates direct endpoints and refuses laundered caller-supplied attribution", () => {
        const h = harness();
        const direct = endpointFixture("store-direct");
        h.store.createIngressEndpoint(h.storage, direct);
        expect(h.store.currentIngressEndpoint(h.storage, direct.id)?.id).toEqual(direct.id);
        expect(h.store.listIngressEndpoints(h.storage)).toEqual([direct]);

        const laundered = endpointFixture("laundered", {
            contribution: attribution("workspace:laundered")
        });
        expect(() => h.store.createIngressEndpoint(h.storage, laundered)).toThrow(
            expect.objectContaining({
                code: "authority.denied",
                message:
                    "Ingress endpoint attribution requires authenticated contribution materialization"
            })
        );
        expect(h.store.currentIngressEndpoint(h.storage, laundered.id)).toBeUndefined();
        expect(
            h.store.listContributedIngressEndpoints(h.storage, new FacetRef("workspace:laundered"))
        ).toEqual([]);
    });

    test("binds the endpoint to the store's own Tenant", () => {
        const h = harness();
        const foreign = endpointFixture("foreign", { scope: foreignScope });
        expect(() => h.store.createIngressEndpoint(h.storage, foreign)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Ingress endpoint belongs to another Tenant"
            })
        );
        expect(() =>
            prepareAndMaterialize(
                h,
                authenticatedInstallationFixture("workspace:foreign"),
                materializationInit(foreign)
            )
        ).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Ingress endpoint belongs to another Tenant"
            })
        );
        expect(h.store.currentIngressEndpoint(h.storage, foreign.id)).toBeUndefined();
    });

    test("admits one live binding per path and frees the path on retirement", () => {
        const h = harness();
        const sharedPath = "/hooks/shared";
        // A contributed occupant holds its path while it is live.
        const occupant = prepareAndMaterialize(
            h,
            authenticatedInstallationFixture("workspace:occupant"),
            materializationInit(endpointFixture("occupant", { path: sharedPath }))
        );
        expect(() =>
            h.store.createIngressEndpoint(h.storage, endpointFixture("path-a", { path: sharedPath }))
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
        expect(() =>
            prepareAndMaterialize(
                h,
                authenticatedInstallationFixture("workspace:occupant"),
                materializationInit(endpointFixture("path-b", { path: sharedPath }))
            )
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));
        h.store.createIngressEndpoint(h.storage, endpointFixture("path-c", { path: "/hooks/other" }));
        expect(h.store.listIngressEndpoints(h.storage).map((endpoint) => endpoint.id.value)).toEqual([
            "ingress-occupant",
            "ingress-path-c"
        ]);

        // Withdrawal retires the occupant and frees exactly its path.
        h.store.retireIngressEndpoint(h.storage, occupant.id);
        expect(h.store.currentIngressEndpoint(h.storage, occupant.id)?.retired).toBe(true);
        expect(
            () => h.store.createIngressEndpoint(h.storage, endpointFixture("path-d", { path: sharedPath }))
        ).not.toThrow();
    });

    test("materializes exact attribution only through trusted provenance and refuses every forgery", () => {
        const h = harness();
        const init = materializationInit(endpointFixture("materialized"));

        for (const forged of [
            malformed<AuthenticatedContribution>({}),
            forgedAuthenticatedContribution({ stale: true })
        ]) {
            expect(() => h.store.materializeIngressEndpoint(h.storage, forged, init)).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message:
                        "Ingress endpoint materialization requires authenticated contribution provenance"
                })
            );
        }

        expect(() =>
            h.store.materializeIngressEndpoint(h.storage, forgedAuthenticatedContribution(new Date()), {
                ...init,
                contribution: attribution("workspace:supplied")
            } as IngressEndpointMaterializationInit)
        ).toThrow(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Ingress endpoint materialization input must not supply record state"
            })
        );

        const installation = authenticatedInstallationFixture("workspace:endpoints");
        const contributed = prepareAndMaterialize(h, installation, init);
        expect(contributed.revision.value).toBe(0);
        expect(contributed.contribution?.contributor.equals(installation.facet)).toBe(true);
        expect(contributed.contribution?.package.equals(installation.package)).toBe(true);
        expect(h.store.listContributedIngressEndpoints(h.storage, installation.facet)).toEqual([
            contributed
        ]);
    });

    test("refuses replayed, re-bound, and drifted provenance", () => {
        const h = harness();
        const context = {};
        const port = h.provenance(authenticatedInstallationFixture("workspace:replay"));
        const materializer = new WorkspaceIngressEndpointMaterializer(h.store, port);
        const prepared = materializer.prepareContribution(h.storage, context);
        if (prepared === undefined) {
            throw new TypeError("Authenticated test installation did not prepare a contribution");
        }

        // One successful provenance check authorizes exactly one materialization.
        const first = materializationInit(endpointFixture("replay-first"));
        materializer.materialize(h.storage, context, prepared, first);
        const replayed = materializationInit(endpointFixture("replay-second"));
        expect(() =>
            materializer.materialize(h.storage, context, prepared, replayed)
        ).toThrow(expect.objectContaining({ code: "authority.denied" }));

        // Fresh provenance cannot re-bind the same desired state either.
        expect(() =>
            prepareAndMaterialize(
                h,
                authenticatedInstallationFixture("workspace:replay"),
                materializationInit(endpointFixture("replay-first"))
            )
        ).toThrow(expect.objectContaining({ code: "protocol.duplicate" }));

        // Provenance that changed between prepare and apply authorizes nothing.
        const driftInstallation = authenticatedInstallationFixture("workspace:drift");
        const driftPort = h.provenance(driftInstallation);
        const driftMaterializer = new WorkspaceIngressEndpointMaterializer(h.store, driftPort);
        const driftPrepared = driftMaterializer.prepareContribution(h.storage, context);
        if (driftPrepared === undefined) {
            throw new TypeError("Authenticated test installation did not prepare a contribution");
        }
        driftPort.installation = Object.freeze({
            ...driftInstallation,
            facet: new FacetRef("workspace:substituted")
        });
        expect(() =>
            driftMaterializer.materialize(
                h.storage,
                context,
                driftPrepared,
                materializationInit(endpointFixture("drifted"))
            )
        ).toThrow(
            expect.objectContaining({
                code: "authority.denied",
                message:
                    "Ingress endpoint contributor installation provenance changed before materialization"
            })
        );
    });

    test("withdrawal retires exactly the contributor's live endpoints", () => {
        const h = harness();
        const withdrawnFacet = "workspace:withdrawn";
        const contributedA = prepareAndMaterialize(
            h,
            authenticatedInstallationFixture(withdrawnFacet),
            materializationInit(endpointFixture("withdraw-a"))
        );
        const contributedA2 = prepareAndMaterialize(
            h,
            authenticatedInstallationFixture(withdrawnFacet),
            materializationInit(endpointFixture("withdraw-a2"))
        );
        const keptByOtherFacet = prepareAndMaterialize(
            h,
            authenticatedInstallationFixture("workspace:keeper"),
            materializationInit(endpointFixture("kept"))
        );
        const direct = endpointFixture("still-direct");
        h.store.createIngressEndpoint(h.storage, direct);

        const selected = h.store.listContributedIngressEndpoints(
            h.storage,
            new FacetRef(withdrawnFacet)
        );
        expect(selected.map((endpoint) => endpoint.id.value)).toEqual([
            "ingress-withdraw-a",
            "ingress-withdraw-a2"
        ]);
        for (const endpoint of selected) h.store.retireIngressEndpoint(h.storage, endpoint.id);

        expect(h.store.currentIngressEndpoint(h.storage, contributedA.id)?.retired).toBe(true);
        expect(h.store.currentIngressEndpoint(h.storage, contributedA2.id)?.retired).toBe(true);
        expect(h.store.currentIngressEndpoint(h.storage, keptByOtherFacet.id)?.retired).toBeUndefined();
        expect(h.store.currentIngressEndpoint(h.storage, direct.id)?.retired).toBeUndefined();
        expect(h.store.listContributedIngressEndpoints(h.storage, new FacetRef(withdrawnFacet))).toEqual([]);
        expect(
            h.store.listIngressEndpoints(h.storage).map((endpoint) => endpoint.id.value)
        ).toEqual(["ingress-kept", "ingress-still-direct"]);

        // A retired endpoint is terminal: no further retirement and no re-creation.
        expect(() => h.store.retireIngressEndpoint(h.storage, contributedA.id)).toThrow(
            expect.objectContaining({ code: "protocol.invalid-state" })
        );
        // Re-creating the retired record directly is a laundering attempt before it is
        // anything else: attribution never re-enters through creation.
        expect(() => h.store.createIngressEndpoint(h.storage, contributedA)).toThrow(
            expect.objectContaining({ code: "authority.denied" })
        );
    });

    test("survives a restart with attribution and retirement intact", () => {
        const h = harness();
        const installation = authenticatedInstallationFixture("workspace:persistent");
        const contributed = prepareAndMaterialize(
            h,
            installation,
            materializationInit(endpointFixture("persistent"))
        );
        const direct = endpointFixture("persistent-direct");
        h.store.createIngressEndpoint(h.storage, direct);
        h.restart();

        const reopened = h.store.currentIngressEndpoint(h.storage, contributed.id);
        expect(reopened?.contribution?.contributor.equals(installation.facet)).toBe(true);
        expect(reopened?.contribution?.package.equals(installation.package)).toBe(true);
        expect(h.store.currentIngressEndpoint(h.storage, direct.id)?.contribution).toBeUndefined();

        h.store.retireIngressEndpoint(h.storage, contributed.id);
        h.restart();
        expect(h.store.currentIngressEndpoint(h.storage, contributed.id)?.retired).toBe(true);
        expect(h.store.listContributedIngressEndpoints(h.storage, installation.facet)).toEqual([]);
    });
});
