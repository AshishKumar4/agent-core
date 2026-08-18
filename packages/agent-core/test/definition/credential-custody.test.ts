import { describe, expect, test } from "vitest";
import { Binding, BindingCredentialCustody, GrantId } from "../../src/authority";
import { SecretRef } from "../../src/core";
import {
    CredentialConsumerRef,
    CredentialCustody,
    CredentialCustodyFact,
    CredentialIsolationSeam,
    CredentialProvider,
    CredentialResolution,
    CredentialResolutionRequest,
    RecordedCustodySeam,
    type CredentialTransport
} from "../../src/definition/credential-custody";
import { BindingName, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ProjectId,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";

const tenantId = new TenantId("tenant-custody");
const otherTenantId = new TenantId("tenant-outsider");
const workspaceScope = ScopeRef.workspace(
    tenantId,
    new ProjectId("project-custody"),
    new WorkspaceId("workspace-custody")
);
const endpoint = "https://integration.example/v1/requests";
const repointed = "https://integration.example/v2/requests";
const credential = new SecretRef(tenantId.value, "vault", "deploy-token");
const consumer = new CredentialConsumerRef("binding", "binding:deploy");

/**
 * Records every value handed to transport, so a refusal that leaked the credential is
 * distinguishable from one that produced nothing.
 */
class RecordingTransport implements CredentialTransport {
    public readonly injected: string[] = [];

    public injectCredential(field: string, value: string): void {
        this.injected.push(`${field}=${value}`);
    }
}

/** Holds one credential and counts how often custody let the seam reach it. */
class HeldCredential extends CredentialProvider {
    public asked = 0;

    public constructor(private readonly held: SecretRef | undefined) {
        super();
    }

    public present(fact: CredentialCustodyFact, transport: CredentialTransport): boolean {
        this.asked += 1;
        if (this.held === undefined || !this.held.equals(fact.secret)) return false;
        transport.injectCredential("authorization", `Bearer raw-${fact.secret.id}`);
        return true;
    }
}

function custodyFor(
    facts: readonly CredentialCustodyFact[] = [new CredentialCustodyFact(credential, endpoint)],
    resolves = true,
    holder: CredentialConsumerRef = consumer,
    tenant: string = tenantId.value
): CredentialCustody {
    return new CredentialCustody(tenant, holder, resolves, facts);
}

function seamFor(
    custody: CredentialCustody = custodyFor(),
    provider: CredentialProvider = new HeldCredential(credential)
): CredentialIsolationSeam {
    return new RecordedCustodySeam(custody, provider);
}

function boundWith(custody: readonly BindingCredentialCustody[]): Binding {
    return Binding.active(
        workspaceScope,
        SubjectRef.principal(new PrincipalRef(tenantId, new PrincipalId("principal-custody"))),
        new ProtectionDomain("backend", "custody", "may-hold-secrets"),
        new BindingName("deploy"),
        new GrantId("custody-grant"),
        new FacetRef("workspace:deploy"),
        custody
    );
}

/** The projection a Tenant-owned consumer performs from its own record (§3.5). */
function custodyOf(binding: Binding): CredentialCustody {
    return new CredentialCustody(
        binding.scope.tenantId.value,
        new CredentialConsumerRef("binding", binding.key),
        binding.resolves,
        binding.credentialCustody.map(
            (fact) => new CredentialCustodyFact(fact.secret, fact.endpoint)
        )
    );
}

describe("SecretRef custody", () => {
    test(
        "[C13-CONFIG-SECRET-CUSTODY] refuses a triple no custody record authorizes and never reaches the provider",
        { tags: "p0" },
        () => {
            const provider = new HeldCredential(credential);
            const transport = new RecordingTransport();
            const seam = seamFor(custodyFor(), provider);

            const unrecorded = seam.resolve(
                new CredentialResolutionRequest(
                    new SecretRef(tenantId.value, "vault", "never-accepted"),
                    consumer,
                    endpoint
                ),
                transport
            );
            expect(unrecorded.outcome).toBe("refused");
            expect(unrecorded.refusal).toBe("secret-unrecorded");

            const foreignConsumer = seam.resolve(
                new CredentialResolutionRequest(
                    credential,
                    new CredentialConsumerRef("binding", "binding:other"),
                    endpoint
                ),
                transport
            );
            expect(foreignConsumer.refusal).toBe("consumer-unrecorded");

            // Checked BEFORE returning a value: the provider holding raw material is
            // never consulted at all, so no implementation can refuse after reading one.
            expect(provider.asked).toBe(0);
            expect(transport.injected).toEqual([]);

            // The recorded triple still resolves, so the refusals above discriminate the
            // triple rather than disabling the seam.
            const allowed = seam.resolve(
                new CredentialResolutionRequest(credential, consumer, endpoint),
                transport
            );
            expect(allowed.outcome).toBe("presented");
            expect(allowed.refusal).toBeUndefined();
            expect(transport.injected).toEqual(["authorization=Bearer raw-deploy-token"]);
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] refuses every resolution once the recorded consumer stops resolving",
        { tags: "p0" },
        () => {
            const provider = new HeldCredential(credential);
            const transport = new RecordingTransport();
            const request = new CredentialResolutionRequest(credential, consumer, endpoint);

            expect(seamFor(custodyFor(), provider).resolve(request, transport).outcome).toBe(
                "presented"
            );
            expect(transport.injected).toHaveLength(1);

            const revoked = new RecordingTransport();
            const afterRevocation = seamFor(
                custodyFor([new CredentialCustodyFact(credential, endpoint)], false),
                provider
            ).resolve(request, revoked);
            expect(afterRevocation.outcome).toBe("refused");
            expect(afterRevocation.refusal).toBe("consumer-revoked");
            expect(revoked.injected).toEqual([]);
            expect(provider.asked).toBe(1);

            // Revocation travels with the consumer's own record: deactivating the Binding
            // is what withdraws its custody, with no second record to revoke.
            const binding = boundWith([new BindingCredentialCustody(credential, endpoint)]);
            expect(binding.hasCredentialCustody(credential, endpoint)).toBe(true);
            const deactivated = binding.deactivate();
            expect(deactivated.hasCredentialCustody(credential, endpoint)).toBe(true);
            const throughRecord = new RecordingTransport();
            const projected = new RecordedCustodySeam(
                custodyOf(deactivated),
                new HeldCredential(credential)
            ).resolve(
                new CredentialResolutionRequest(
                    credential,
                    new CredentialConsumerRef("binding", deactivated.key),
                    endpoint
                ),
                throughRecord
            );
            expect(projected.refusal).toBe("consumer-revoked");
            expect(throughRecord.injected).toEqual([]);
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] refuses a cross-Tenant presentation and refuses to record a foreign source",
        { tags: "p0" },
        () => {
            const foreign = new SecretRef(otherTenantId.value, "vault", "deploy-token");
            const provider = new HeldCredential(foreign);
            const transport = new RecordingTransport();

            // A ref whose source names another Tenant cannot be recorded here at all:
            // `source` must equal the exact canonical TenantId of whoever records custody.
            expect(() => custodyFor([new CredentialCustodyFact(foreign, endpoint)])).toThrow(
                /SecretRef source must equal its Tenant ID/u
            );
            expect(() =>
                boundWith([new BindingCredentialCustody(foreign, endpoint)])
            ).toThrowError();

            // And a Tenant that did record custody cannot be made to present it for a
            // foreign ref, so a cross-tenant reservation carries the ref and never a value.
            const crossTenant = seamFor(custodyFor(), provider).resolve(
                new CredentialResolutionRequest(foreign, consumer, endpoint),
                transport
            );
            expect(crossTenant.outcome).toBe("refused");
            expect(crossTenant.refusal).toBe("foreign-tenant");
            expect(provider.asked).toBe(0);
            expect(transport.injected).toEqual([]);

            // The same custody read through the other Tenant refuses identically rather
            // than resolving under a relabelled owner.
            const relabelled = new RecordingTransport();
            const outsider = new RecordedCustodySeam(
                new CredentialCustody(otherTenantId.value, consumer, true, [
                    new CredentialCustodyFact(foreign, endpoint)
                ]),
                provider
            ).resolve(new CredentialResolutionRequest(credential, consumer, endpoint), relabelled);
            expect(outsider.refusal).toBe("foreign-tenant");
            expect(relabelled.injected).toEqual([]);
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] invalidates a ref presented outside the endpoint and generation that recorded it",
        { tags: "p0" },
        () => {
            const provider = new HeldCredential(credential);
            const transport = new RecordingTransport();

            // Repointing at a new endpoint invalidates the old resolution rather than
            // presenting the old credential to the new place — and that is a different
            // answer from a ref custody never accepted, because the ref is still held.
            const moved = seamFor(custodyFor(), provider).resolve(
                new CredentialResolutionRequest(credential, consumer, repointed),
                transport
            );
            expect(moved.outcome).toBe("refused");
            expect(moved.refusal).toBe("endpoint-unrecorded");
            expect(provider.asked).toBe(0);
            expect(transport.injected).toEqual([]);

            // A ref outlives its scope when the consumer's record rotates past it: the
            // Tenant repoints its own Binding and the retained ref stops resolving at the
            // endpoint it was accepted for, with no separate revocation step.
            const original = boundWith([new BindingCredentialCustody(credential, endpoint)]);
            const rotated = original.replace(original.grantId, original.facet, [
                new BindingCredentialCustody(credential, repointed)
            ]);
            expect(rotated.generation).toBe(original.generation + 1);

            const retained = new CredentialResolutionRequest(credential, consumer, endpoint);
            const beforeRotation = new RecordingTransport();
            expect(
                new RecordedCustodySeam(custodyOf(original), provider).resolve(
                    retained,
                    beforeRotation
                ).outcome
            ).toBe("refused");
            // custodyOf keys on the Binding's own key, so the retained consumer ref is
            // stale first; the rotation itself is what the endpoint answer proves.
            const holder = new CredentialConsumerRef("binding", original.key);
            const afterRotation = new RecordingTransport();
            const stale = new RecordedCustodySeam(custodyOf(rotated), provider).resolve(
                new CredentialResolutionRequest(credential, holder, endpoint),
                afterRotation
            );
            expect(stale.refusal).toBe("endpoint-unrecorded");
            expect(afterRotation.injected).toEqual([]);

            const current = new RecordingTransport();
            expect(
                new RecordedCustodySeam(custodyOf(rotated), provider).resolve(
                    new CredentialResolutionRequest(credential, holder, repointed),
                    current
                ).outcome
            ).toBe("presented");
            expect(current.injected).toEqual(["authorization=Bearer raw-deploy-token"]);
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] decides from the triple alone and refuses a key carrying any further discriminant",
        { tags: "p0" },
        () => {
            const seam = seamFor();
            const transport = new RecordingTransport();
            const request = new CredentialResolutionRequest(credential, consumer, endpoint);

            // A presenting Principal is not ignored, it is absent, and at two independent
            // points. A key that carries one as its own field cannot be constructed at
            // all, because the triple freezes itself.
            class PrincipalFieldRequest extends CredentialResolutionRequest {
                public readonly principal = "principal-custody";
            }
            expect(() => new PrincipalFieldRequest(credential, consumer, endpoint)).toThrow(
                /Cannot define property principal/u
            );

            // And a key that hides one behind its prototype is constructible, so the seam
            // refuses an inexact triple rather than honoring it as a narrower scope.
            class PrincipalScopedRequest extends CredentialResolutionRequest {
                public get principal(): string {
                    return "principal-custody";
                }
            }
            const widened = new PrincipalScopedRequest(credential, consumer, endpoint);
            expect(widened.principal).toBe("principal-custody");
            expect(() => seam.resolve(widened, transport)).toThrow(
                expect.objectContaining({ code: "operation.invalid-input" })
            );
            expect(transport.injected).toEqual([]);

            // Two presentations of one triple observe the identical outcome, so no asker
            // can narrow or widen what a ref means.
            const first = seam.resolve(request, transport);
            const second = seam.resolve(
                new CredentialResolutionRequest(credential, consumer, endpoint),
                transport
            );
            expect([first.outcome, first.refusal]).toEqual([second.outcome, second.refusal]);

            // Consumer identity is the kind paired with the id, so custody recorded for a
            // Binding is not presentable by an Environment sharing its name.
            const collision = new RecordingTransport();
            const colliding = seam.resolve(
                new CredentialResolutionRequest(
                    credential,
                    new CredentialConsumerRef("environment", consumer.id),
                    endpoint
                ),
                collision
            );
            expect(colliding.refusal).toBe("consumer-unrecorded");
            expect(collision.injected).toEqual([]);
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] separates a confirmed custody refusal from a provider outcome it does not hold",
        { tags: "p0" },
        () => {
            const request = new CredentialResolutionRequest(credential, consumer, endpoint);

            // Custody authorized the triple, so a provider that does not hold the
            // credential settles nothing: indeterminate, never a refusal a Tenant made.
            const empty = new HeldCredential(undefined);
            const transport = new RecordingTransport();
            const unheld = seamFor(custodyFor(), empty).resolve(request, transport);
            expect(unheld.outcome).toBe("indeterminate");
            expect(unheld.refusal).toBeUndefined();
            expect(empty.asked).toBe(1);
            expect(transport.injected).toEqual([]);

            // And the converse: a refusal is never softened into indeterminate, so a
            // caller cannot read a Tenant's denial as an unsettled attempt.
            const refused = seamFor(custodyFor([], true), empty).resolve(request, transport);
            expect(refused.outcome).toBe("refused");
            expect(refused.refusal).toBe("secret-unrecorded");

            // The three outcomes are distinct values rather than one nullable result, and
            // a presentation carries no credential back to its caller.
            const presented = seamFor().resolve(request, new RecordingTransport());
            expect([presented.outcome, unheld.outcome, refused.outcome]).toEqual([
                "presented",
                "indeterminate",
                "refused"
            ]);
            // A resolution carries an outcome and a custody reason and nothing else, so
            // there is no member a credential could travel back to a caller in, and the
            // three answers are three shapes of one contract rather than one nullable
            // value the caller has to interpret.
            expect(Object.keys(presented).sort()).toEqual(["outcome", "refusal"]);
            expect(Object.keys(refused).sort()).toEqual(["outcome", "refusal"]);
            expect(Object.isFrozen(presented)).toBe(true);
            expect(Object.isFrozen(unheld)).toBe(true);
            for (const outcome of [presented, unheld, refused]) {
                expect(outcome).toBeInstanceOf(CredentialResolution);
            }
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] reads custody from the consumer's own durable record and adds no store of its own",
        { tags: "p0" },
        () => {
            const binding = boundWith([new BindingCredentialCustody(credential, endpoint)]);
            const restored = Binding.decode(Binding.encode(binding));
            const holder = new CredentialConsumerRef("binding", restored.key);
            const transport = new RecordingTransport();

            // The seam's authority is exactly what the consumer's record already carries,
            // so custody survives a codec round-trip with no second durable record.
            expect(restored.credentialCustody).toHaveLength(1);
            expect(
                new RecordedCustodySeam(
                    custodyOf(restored),
                    new HeldCredential(credential)
                ).resolve(new CredentialResolutionRequest(credential, holder, endpoint), transport)
                    .outcome
            ).toBe("presented");
            expect(transport.injected).toEqual(["authorization=Bearer raw-deploy-token"]);

            // Every pair the record answers, the seam answers identically — the seam adds
            // no custody the Tenant did not record and withholds none it did.
            for (const [secret, target] of [
                [credential, endpoint],
                [credential, repointed],
                [new SecretRef(tenantId.value, "vault", "other"), endpoint]
            ] as const) {
                const probe = new RecordingTransport();
                const outcome = new RecordedCustodySeam(
                    custodyOf(restored),
                    new HeldCredential(secret)
                ).resolve(new CredentialResolutionRequest(secret, holder, target), probe);
                expect(outcome.outcome === "presented").toBe(
                    restored.hasCredentialCustody(secret, target)
                );
            }
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] refuses every inexact or non-canonical custody value where it is written",
        { tags: "p0" },
        () => {
            // §3.5 makes `source` the exact canonical TenantId and the consumer and
            // endpoint the exact ones the Tenant recorded. Exactness is only enforceable
            // if the values carrying it cannot be approximated, so each of these refusals
            // is a reviewed throw site rather than defensive programming: a subtype, a
            // structural look-alike, or a free-form label is rejected where it is written
            // and never carried into a custody decision.
            class WiderSecret extends SecretRef {}
            const wider = new WiderSecret(tenantId.value, "vault", "deploy-token");
            // SAFETY: a structural counterfeit is the only way to reach the exactness guards,
            // which compare `constructor` rather than shape — a real CredentialConsumerRef
            // cannot fail them, and a subclass instance is the separate case `wider` covers.
            // The narrowing never reaches a custody decision: both uses below hand it to a
            // constructor that refuses it at the guard before reading either field.
            const lookAlike = { kind: "binding", id: consumer.id } as CredentialConsumerRef;
            const fact = new CredentialCustodyFact(credential, endpoint);

            for (const [subject, construct] of [
                ["consumer kind is not canonical", () => new CredentialConsumerRef("Binding", "x")],
                ["consumer ID is blank", () => new CredentialConsumerRef("binding", "  ")],
                [
                    "custody fact secret is not exact",
                    () => new CredentialCustodyFact(wider, endpoint)
                ],
                [
                    "custody tenant is not canonical",
                    () => new CredentialCustody(" tenant-custody ", consumer, true, [])
                ],
                [
                    "custody consumer is not exact",
                    () => new CredentialCustody(tenantId.value, lookAlike, true, [])
                ],
                [
                    "custody fact is not exact",
                    () =>
                        new CredentialCustody(tenantId.value, consumer, true, [
                            // SAFETY: the same counterfeit one level down. CredentialCustody
                            // rejects a fact whose constructor is not CredentialCustodyFact
                            // before it reads `secret`, so this literal is refused at that
                            // guard and never becomes a recorded custody fact.
                            { secret: credential, endpoint } as CredentialCustodyFact
                        ])
                ],
                [
                    "request secret is not exact",
                    () => new CredentialResolutionRequest(wider, consumer, endpoint)
                ],
                [
                    "request consumer is not exact",
                    () => new CredentialResolutionRequest(credential, lookAlike, endpoint)
                ],
                [
                    "endpoint is blank",
                    () => new CredentialResolutionRequest(credential, consumer, " ")
                ]
            ] as const) {
                expect(construct, subject).toThrow(TypeError);
            }

            // The exact values these refusals protect still construct, so the guards
            // discriminate the inexact case rather than rejecting the shape outright.
            expect(
                new CredentialCustody(tenantId.value, consumer, true, [fact]).facts
            ).toHaveLength(1);
            expect(new CredentialResolutionRequest(credential, consumer, endpoint).endpoint).toBe(
                endpoint
            );
        }
    );
});
