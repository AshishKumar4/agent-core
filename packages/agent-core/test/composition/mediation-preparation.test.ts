import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Binding, GrantId, PathEpochEvidence, ScopeEpoch } from "../../src/authority";
import { Digest, JsonSchema, SemVer, type JsonValue } from "../../src/core";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import {
    BindingName,
    FacetRef,
    OperationDescriptor,
    OperationName,
    ProtectionDomain
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import {
    InvocationPlacementPin,
    AuditRecordId,
    MemoryInvocationPersistence,
    PreparedInvocation,
    RouteReservationId,
    cloneInvocationMemoryState,
    createInvocationMemoryState,
    type InvocationMemoryState,
    type InvocationTransactionPort
} from "../../src/invocations";
import { OperationRequestKey, type MediatedInvocationRequest } from "../../src/operations";
import { TurnId } from "../../src/execution-references";
import {
    CanonicalMediationPreparation,
    DerivedMediationIdentities,
    DerivedPreparationAdmission,
    MediatedAuthorityIntent,
    authorityReferenceCodec,
    domainReference,
    domainReferenceCodec,
    leaseReference,
    leaseReferenceCodec,
    leaseToken,
    mediationInvocationCodecs,
    mediationPreparedCodecs,
    pathEpochReference,
    pathEpochReferenceCodec,
    sameLeaseReference,
    type FacetActivationPinPort,
    type MediationAuthorityReference,
    type MediationDomainReference,
    type MediationLeaseReference,
    type MediationPathEpochReference,
    type MediationPreparedInvocation
} from "../../src/composition";
import type { LeaseToken } from "../../src/agents";

const tenant = new TenantId("preparation-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("preparation-principal"));
const owner = new ActorRef("run", new ActorId("preparation-run"));
const facet = new FacetRef("memory:primary");
const bindingName = new BindingName("recall");
const domain = new ProtectionDomain("backend", "memory", "may-hold-secrets");
const scope = ScopeRef.workspace(tenant, new WorkspaceId("preparation-workspace"));
const turnId = new TurnId("preparation-turn");
const token: LeaseToken = Object.freeze({ turn: turnId, holder: principal, epoch: 3 });
const schema = new JsonSchema({ type: "object" });

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

function descriptor(): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName("recall"),
        "observe",
        schema,
        schema,
        "Perform recall."
    );
}

function pathEpochs(): PathEpochEvidence {
    return new PathEpochEvidence([
        ScopeEpoch.initial(ScopeRef.tenant(tenant)),
        ScopeEpoch.initial(scope)
    ]);
}

function binding(): Binding {
    return Binding.active(
        scope,
        SubjectRef.principal(principal),
        domain,
        bindingName,
        new GrantId("preparation-grant"),
        facet
    );
}

function intent(
    overrides: {
        readonly lease?: LeaseToken | undefined;
        readonly route?: RouteReservationId | undefined;
    } = {}
): MediatedAuthorityIntent {
    return new MediatedAuthorityIntent(
        principal,
        binding(),
        pathEpochs(),
        domain,
        new PackagePin(new PackageId("memory"), new SemVer("1.0.0"), digest("f"), digest("1")),
        new InvocationPlacementPin({
            manifest: ["provider"],
            policy: ["provider"],
            substrate: ["provider"],
            trust: ["provider"],
            selected: "provider"
        }),
        owner,
        "lease" in overrides ? overrides.lease : token,
        overrides.route,
        [new PolicySet({})]
    );
}

interface RequestOverrides {
    readonly authorization?: MediatedAuthorityIntent;
    readonly facet?: FacetRef;
    readonly inputs?: readonly Record<string, JsonValue>[];
    readonly shape?: MediatedInvocationRequest<MediatedAuthorityIntent>["shape"];
}

function request(overrides: RequestOverrides = {}) {
    const invocationRequest: MediatedInvocationRequest<MediatedAuthorityIntent> = {
        requestKey: new OperationRequestKey("preparation-request"),
        facet: overrides.facet ?? facet,
        descriptor: descriptor(),
        shape: overrides.shape ?? { kind: "single" },
        inputs: overrides.inputs ?? [{ query: "parking" }],
        authorization: overrides.authorization ?? intent(),
        interceptions: [],
        execute: async () => ({})
    };
    return {
        invocation: identities.invocation({ ...invocationRequest, replayBinding }),
        request: invocationRequest
    };
}

const replayBinding = {
    principal,
    authorityIdentity: digest("a"),
    packageOperationPin: digest("b"),
    execution: { kind: "lease", digest: digest("c") }
} as const;

const identities = new DerivedMediationIdentities("preparation-scope");

const activations: FacetActivationPinPort = {
    pin: (target) =>
        target.equals(facet)
            ? {
                  configurationDigest: digest("2"),
                  runtimeDigest: digest("3"),
                  activationGeneration: "generation-1",
                  registration: "registration-1"
              }
            : undefined
};

class MemoryTransactions implements InvocationTransactionPort<InvocationMemoryState> {
    #state: InvocationMemoryState = createInvocationMemoryState();

    public transact<Result>(operation: (transaction: InvocationMemoryState) => Result): Result {
        const draft = cloneInvocationMemoryState(this.#state);
        const result = operation(draft);
        this.#state = cloneInvocationMemoryState(draft);
        return result;
    }

    public read(): InvocationMemoryState {
        return cloneInvocationMemoryState(this.#state);
    }
}

const admissionCodec = Object.freeze({
    encode: (value: string): JsonValue => value,
    decode: (value: JsonValue): string => String(value)
});

function preparation() {
    const transactions = new MemoryTransactions();
    const persistence = new MemoryInvocationPersistence(mediationInvocationCodecs(admissionCodec));
    const port = new CanonicalMediationPreparation(
        identities,
        activations,
        transactions,
        persistence
    );
    return { port, transactions, persistence };
}

describe("structural references cross the invocations boundary as data", () => {
    test("carries a Lease token through its reference unchanged", { tags: "p0" }, () => {
        // The invocations context never interprets a Lease; it persists the reference and
        // hands it back. A field the reference drops is a fencing token the ledger can no
        // longer check, so the round trip is the contract.
        const restored = leaseToken(leaseReference(token));
        expect(restored.turn.equals(token.turn)).toBe(true);
        expect(restored.holder.tenantId.equals(token.holder.tenantId)).toBe(true);
        expect(restored.holder.principalId.equals(token.holder.principalId)).toBe(true);
        expect(restored.epoch).toBe(token.epoch);
        expect(leaseReference(restored)).toEqual(leaseReference(token));
    });

    test("compares Lease references on every field", { tags: "p0" }, () => {
        // This is the executor fencing check of §5.3: an EffectAttempt is admitted only
        // under the exact token its claim was taken with. A field left out of the
        // comparison is a token a different holder, Turn, or epoch could pass.
        const reference = leaseReference(token);
        expect(sameLeaseReference(reference, leaseReference(token))).toBe(true);
        const variants: readonly MediationLeaseReference[] = [
            { ...reference, turn: "other-turn" },
            { ...reference, tenant: "other-tenant" },
            { ...reference, principal: "other-principal" },
            { ...reference, epoch: reference.epoch + 1 }
        ];
        for (const variant of variants) {
            expect(sameLeaseReference(reference, variant), JSON.stringify(variant)).toBe(false);
            expect(sameLeaseReference(variant, reference), JSON.stringify(variant)).toBe(false);
        }
    });

    test("round-trips every structural reference through its codec", { tags: "p0" }, () => {
        const lease = leaseReference(token);
        expect(leaseReferenceCodec.decode(leaseReferenceCodec.encode(lease))).toEqual(lease);

        const authority = {
            kind: "delegated",
            tenant: tenant.value,
            principal: "preparation-principal",
            binding: bindingName.value
        } as const;
        expect(authorityReferenceCodec.decode(authorityReferenceCodec.encode(authority))).toEqual(
            authority
        );

        const reference = domainReference(domain);
        expect(reference).toEqual({
            kind: "backend",
            label: "memory",
            secretPolicy: "may-hold-secrets"
        });
        expect(domainReferenceCodec.decode(domainReferenceCodec.encode(reference))).toEqual(
            reference
        );

        const epochs = pathEpochReference(pathEpochs());
        expect(pathEpochReferenceCodec.decode(pathEpochReferenceCodec.encode(epochs))).toEqual(
            epochs
        );
    });

    test("admits both Invocation authority kinds and no others", { tags: "p0" }, () => {
        // §7.3 distinguishes an initiator's own authority from a delegated one. Both are
        // valid on the wire and anything else is a record this context cannot interpret,
        // so the codec has to accept exactly two values — a decoder that took only one
        // would make delegated Invocations undecodable after a restart.
        const encoded = (kind: string): JsonValue => ({
            binding: bindingName.value,
            kind,
            principal: "preparation-principal",
            tenant: tenant.value
        });
        expect(authorityReferenceCodec.decode(encoded("initiator")).kind).toBe("initiator");
        expect(authorityReferenceCodec.decode(encoded("delegated")).kind).toBe("delegated");
        for (const kind of ["", "initiator ", "Delegated", "system"]) {
            expect(() => authorityReferenceCodec.decode(encoded(kind)), kind).toThrow(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    });

    test("admits both protection domain kinds and both secret policies", { tags: "p0" }, () => {
        // The secret policy is what decides whether a domain may hold raw credentials
        // (§3.4), and the kind is what decides whether it may hold them at all. A decoder
        // that rejected a valid combination would make a domain undecodable; one that
        // accepted an invalid string would reconstruct a domain whose policy nothing in
        // this context ever checked again.
        const encoded = (kind: string, secretPolicy: string): JsonValue => ({
            kind,
            label: "memory",
            secretPolicy
        });
        for (const kind of ["frontend", "backend"] as const) {
            for (const secretPolicy of ["no-secrets", "may-hold-secrets"] as const) {
                const decoded = domainReferenceCodec.decode(encoded(kind, secretPolicy));
                expect(decoded.kind).toBe(kind);
                expect(decoded.secretPolicy).toBe(secretPolicy);
            }
        }
        const rejected: readonly (readonly [string, string])[] = [
            ["backend", "no-secret"],
            ["backend", ""],
            ["backend", "may-hold-secret"],
            ["back-end", "no-secrets"],
            ["", "no-secrets"],
            ["Backend", "no-secrets"]
        ];
        for (const [kind, secretPolicy] of rejected) {
            expect(
                () => domainReferenceCodec.decode(encoded(kind, secretPolicy)),
                `${kind}/${secretPolicy}`
            ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
        }
    });

    test("separates a malformed field set from a malformed value", { tags: "p1" }, () => {
        // Two different refusals meet here and only one belongs to this module. A record
        // whose field set is wrong is refused by the shared codec helper as a TypeError;
        // a record whose fields are all present but whose kind or policy is not one this
        // context defines is refused by this module, which is what `codec.invalid` names.
        // Asserting only "it throws" would let either check stand in for the other.
        expect(() => leaseReferenceCodec.decode({ epoch: 1, principal: "p", tenant: "t" })).toThrow(
            TypeError
        );
        expect(() =>
            domainReferenceCodec.decode({ kind: "backend", secretPolicy: "no-secrets" })
        ).toThrow(TypeError);
        expect(() =>
            domainReferenceCodec.decode({
                kind: "sideways",
                label: "l",
                secretPolicy: "no-secrets"
            })
        ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
    });
});

describe("mediated preparation freezes the effect intent", () => {
    test("freezes the resolved authority into the record", { tags: "p0" }, () => {
        const { port } = preparation();
        const record = port.prepare(request());
        expect(record.header.authority).toEqual({
            kind: "initiator",
            tenant: tenant.value,
            principal: "preparation-principal",
            binding: bindingName.value
        });
        expect(record.header.lease).toEqual(leaseReference(token));
        expect(record.header.domain).toEqual(domainReference(domain));
        expect(record.header.pathEpochs).toEqual(pathEpochReference(pathEpochs()));
        expect(record.header.operation.operation.value).toBe("memory:recall");
        expect(record.header.auditCause.equals(identities.invocationAudit(record.header.id))).toBe(
            true
        );
        expect(record.header.idempotencySeed).toBe(identities.idempotencySeed(record.header.id));
    });

    test("refuses a header carrying neither a lease nor a route", { tags: "p0" }, () => {
        // §7.3 admits exactly two ways to authorize a mediated Invocation. Without the
        // guard the record is built with `lease: undefined`, which the ledger reads as a
        // system claim — an unfenced attempt taken on behalf of a caller who presented
        // no fencing at all.
        const { port } = preparation();
        expect(() =>
            port.prepare(request({ authorization: intent({ lease: undefined }) }))
        ).toThrow(
            expect.objectContaining({
                code: "invocation.invalid",
                message: "Mediated preparation requires an exact lease or a routed reservation"
            })
        );
    });

    test("returns the RouteReservation's own durable record", { tags: "p0" }, () => {
        // A routed Invocation is prepared by RoutedInvocationAdmissionPort, not here.
        // Deriving a second record would disagree with the durable one on the audit
        // cause and projection digest the reservation already committed, so this port
        // reads rather than derives — and reading the wrong Invocation is not visible
        // unless the durable record differs from what this port would have built.
        const { port, transactions, persistence } = preparation();
        const routed = request({
            authorization: intent({ route: new RouteReservationId("route-1") })
        });
        const durable = PreparedInvocation.create(
            {
                id: routed.invocation,
                operation: port.prepare(request()).header.operation,
                domain: domainReference(domain),
                actor: owner,
                authority: {
                    kind: "delegated" as const,
                    tenant: tenant.value,
                    principal: "preparation-principal",
                    binding: bindingName.value
                },
                pathEpochs: pathEpochReference(pathEpochs()),
                route: new RouteReservationId("route-1"),
                projectionDigest: digest("7"),
                auditCause: identities.invocationAudit(routed.invocation),
                idempotencySeed: identities.idempotencySeed(routed.invocation)
            },
            { kind: "single", item: { query: "parking" } },
            mediationPreparedCodecs
        );
        transactions.transact((transaction) => {
            persistence.insertPrepared(transaction, durable);
        });

        const record = port.prepare(routed);
        expect(record.header.id.equals(durable.header.id)).toBe(true);
        expect(record.header.route?.value).toBe("route-1");
        expect(record.header.projectionDigest?.value).toBe(digest("7").value);
        expect(record.header.authority.kind).toBe("delegated");
        expect(record.header.lease).toBeUndefined();
    });

    test("refuses a routed Invocation with no durable reservation", { tags: "p0" }, () => {
        // The reservation is the authority for a routed Invocation. If it is missing this
        // port must refuse rather than fall through and mint one from the header, which
        // would forge the record the authenticated route was supposed to have committed.
        const { port } = preparation();
        expect(() =>
            port.prepare(
                request({ authorization: intent({ route: new RouteReservationId("route-2") }) })
            )
        ).toThrow(
            expect.objectContaining({
                code: "invocation.invalid",
                message:
                    "Routed mediation requires the RouteReservation's durable PreparedInvocation"
            })
        );
    });

    test("refuses a Facet the host never activated", { tags: "p0" }, () => {
        // Only the component that activated the Facet knows which runtime it activated,
        // so preparation is told rather than guessing. No pin means no honest OperationPin.
        const { port } = preparation();
        expect(() => port.prepare(request({ facet: new FacetRef("memory:absent") }))).toThrow(
            expect.objectContaining({ code: "invocation.invalid" })
        );
    });

    test("prepares each payload shape as the shape it was asked for", { tags: "p0" }, () => {
        const { port } = preparation();
        const single = port.prepare(request());
        expect(single.itemCount).toBe(1);

        const batch = port.prepare(
            request({
                shape: { kind: "batch", itemCount: 2 },
                inputs: [{ query: "parking" }, { query: "garage" }]
            })
        );
        expect(batch.itemCount).toBe(2);
        expect(batch.item(0).arguments).toEqual({ query: "parking" });
        expect(batch.item(1).arguments).toEqual({ query: "garage" });

        // A one-item batch stays a batch: the shape is what the caller asked for, not
        // what the input count happens to allow.
        const one = port.prepare(request({ shape: { kind: "batch", itemCount: 1 } }));
        expect(one.itemCount).toBe(1);
        expect(one.header.id.equals(single.header.id)).toBe(false);
    });

    test("refuses a payload the shape does not describe", { tags: "p0" }, () => {
        // Both refusals carry the ledger's own code rather than a TypeError from the
        // record layer: an empty payload otherwise reaches PreparedInvocation as an
        // undefined item, and extra items under a single shape are silently dropped.
        const { port } = preparation();
        expect(() => port.prepare(request({ inputs: [] }))).toThrow(
            expect.objectContaining({
                code: "invocation.invalid",
                message: "A mediated payload must be nonempty"
            })
        );
        expect(() =>
            port.prepare(request({ inputs: [{ query: "parking" }, { query: "garage" }] }))
        ).toThrow(
            expect.objectContaining({
                code: "invocation.invalid",
                message: "A single mediated payload carries one item"
            })
        );
    });
});

describe("the ledger's preparation gate", () => {
    const admission = new DerivedPreparationAdmission<InvocationMemoryState>(identities);
    const transaction = createInvocationMemoryState();

    function locallyPrepared(): MediationPreparedInvocation {
        return preparation().port.prepare(request());
    }

    function rebuilt(header: {
        readonly auditCause?: AuditRecordId;
        readonly idempotencySeed?: string;
        readonly lease?: MediationLeaseReference | undefined;
    }): MediationPreparedInvocation {
        const record = locallyPrepared();
        const lease = "lease" in header ? header.lease : record.header.lease;
        return PreparedInvocation.create<
            MediationLeaseReference,
            MediationAuthorityReference,
            MediationDomainReference,
            MediationPathEpochReference
        >(
            {
                id: record.header.id,
                operation: record.header.operation,
                domain: record.header.domain,
                actor: record.header.actor,
                authority: record.header.authority,
                pathEpochs: record.header.pathEpochs,
                ...(lease === undefined ? {} : { lease }),
                auditCause: header.auditCause ?? record.header.auditCause,
                idempotencySeed: header.idempotencySeed ?? record.header.idempotencySeed
            },
            { kind: "single", item: { query: "parking" } },
            mediationPreparedCodecs
        );
    }

    test(
        "admits a locally prepared Invocation with its own derived identity",
        { tags: "p0" },
        () => {
            expect(admission.admits(transaction, locallyPrepared())).toBe(true);
        }
    );

    test("refuses an audit cause or seed this Invocation does not derive", { tags: "p0" }, () => {
        // The audit cause and idempotency seed are functions of the InvocationId, so a
        // record carrying another Invocation's roots its audit chain under a cause no
        // record in this chain caused, and takes item keys that collide with the
        // Invocation those values do belong to.
        //
        // The other Invocation is minted from a different request rather than a different
        // mediation scope: both derivations read only the InvocationId, which already
        // commits the scope, so a second scope would derive the identical values here.
        const elsewhere = request({ facet: new FacetRef("memory:secondary") }).invocation;
        expect(
            admission.admits(
                transaction,
                rebuilt({ auditCause: identities.invocationAudit(elsewhere) })
            )
        ).toBe(false);
        expect(
            admission.admits(
                transaction,
                rebuilt({ idempotencySeed: identities.idempotencySeed(elsewhere) })
            )
        ).toBe(false);
    });

    test("refuses a locally prepared Invocation carrying no lease", { tags: "p0" }, () => {
        expect(admission.admits(transaction, rebuilt({ lease: undefined }))).toBe(false);
    });

    test("gates a routed Invocation on its reservation, not this scope", { tags: "p0" }, () => {
        // A routed record's identity belongs to the RouteReservation that already made it
        // durable, so the derived-identity check cannot apply to it: it carries no lease,
        // and its audit cause is the reservation's. Running it through the local branch
        // would refuse every routed Invocation this port exists to admit.
        //
        // The branch is not therefore ungated — it returns whether the record carries a
        // projection digest — but PreparedInvocationHeader already refuses a route
        // without one, so that operand cannot be observed false and is registered as
        // equivalent rather than asserted here.
        const record = locallyPrepared();
        const elsewhere = request({ facet: new FacetRef("memory:secondary") }).invocation;
        const routed = PreparedInvocation.create<
            MediationLeaseReference,
            MediationAuthorityReference,
            MediationDomainReference,
            MediationPathEpochReference
        >(
            {
                id: record.header.id,
                operation: record.header.operation,
                domain: record.header.domain,
                actor: record.header.actor,
                authority: record.header.authority,
                pathEpochs: record.header.pathEpochs,
                route: new RouteReservationId("route-3"),
                projectionDigest: digest("8"),
                auditCause: identities.invocationAudit(elsewhere),
                idempotencySeed: identities.idempotencySeed(elsewhere)
            },
            { kind: "single", item: { query: "parking" } },
            mediationPreparedCodecs
        );
        expect(admission.admits(transaction, routed)).toBe(true);
    });
});
