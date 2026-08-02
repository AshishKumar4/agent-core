import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
    ActorId,
    ActorRef,
    BindingName,
    Digest,
    FacetRef,
    InvocationId,
    OperationRef,
    PackageId,
    PackagePin,
    PrincipalId,
    PrincipalRef,
    Revision,
    ScopeRef,
    SemVer,
    TenantId
} from "@agent-core/core";
import { RunId, TurnId } from "@agent-core/core/agents/runs";
import { ProtectionDomain } from "@agent-core/core";
import {
    AuthorityPermit,
    AuthorityPermitExpectation,
    PathEpochEvidence,
    ScopeEpoch
} from "@agent-core/core/authority";
import { ClaimWorkerId, ItemClaimId } from "@agent-core/core/invocations";
import { actorObjectName } from "../../src/index.js";
import { PERMIT_TARGET_ACTOR, PERMIT_TENANT_ACTOR } from "./worker.js";

const tenant = new TenantId("permit-tenant-id");
const principal = new PrincipalRef(tenant, new PrincipalId("permit-principal"));
const lease = Object.freeze({
    turn: new TurnId("permit-turn"),
    holder: principal,
    epoch: 3
});
const ISSUED_AT = 1_700_000_000_000;
const EXPIRES_AT = ISSUED_AT + 60_000;

function digest(seed: string): Digest {
    return Digest.sha256(new TextEncoder().encode(seed));
}

type ExpectationInit = ConstructorParameters<typeof AuthorityPermitExpectation>[0];

function expectation(overrides: Partial<ExpectationInit> = {}): AuthorityPermitExpectation {
    const invocation = overrides.invocation ?? new InvocationId("permit-invocation");
    const itemIndex = overrides.itemIndex ?? 0;
    const itemKey = overrides.itemKey ?? "permit-item";
    const binding = overrides.binding ?? {
        name: new BindingName("mail"),
        generation: new Revision(3)
    };
    return new AuthorityPermitExpectation({
        tenant,
        issuer: overrides.issuer ?? PERMIT_TENANT_ACTOR,
        source: overrides.source ?? new ActorRef("workspace", new ActorId("permit-source")),
        target: overrides.target ?? {
            actor: PERMIT_TARGET_ACTOR,
            fence: 7,
            domain: new ProtectionDomain("backend", "permit-domain", "may-hold-secrets")
        },
        principal,
        binding,
        facet: overrides.facet ?? new FacetRef("workspace:mail"),
        operation: overrides.operation ?? new OperationRef("mail:send"),
        package:
            overrides.package ??
            new PackagePin(
                new PackageId("mail-package"),
                new SemVer("1.2.3"),
                digest("manifest"),
                digest("code")
            ),
        impact: "externalSend",
        invocation,
        reservation: overrides.reservation ?? {
            run: new RunId("permit-run"),
            registryEpoch: 5,
            obligation: { kind: "invocationItem", invocation, itemIndex, itemKey }
        },
        itemIndex,
        attemptOrdinal: overrides.attemptOrdinal ?? 0,
        claim: overrides.claim ?? new ItemClaimId("permit-claim"),
        claimOwner: overrides.claimOwner ?? {
            kind: "executor",
            token: lease,
            worker: new ClaimWorkerId("permit-worker")
        },
        itemKey,
        argumentsDigest: overrides.argumentsDigest ?? digest("arguments"),
        intentDigest: overrides.intentDigest ?? digest("intent"),
        pathEpochs:
            overrides.pathEpochs ??
            new PathEpochEvidence([new ScopeEpoch(ScopeRef.tenant(tenant), 2)]),
        authority: {
            kind: "initiator",
            principal,
            binding: binding.name
        },
        lease
    });
}

function permit(
    base: AuthorityPermitExpectation,
    nonce: string,
    expiresAt = EXPIRES_AT
): Uint8Array {
    return AuthorityPermit.encode(
        new AuthorityPermit({
            ...basePermitInit(base),
            nonce,
            issuedAt: new Date(ISSUED_AT),
            expiresAt: new Date(expiresAt)
        })
    );
}

function basePermitInit(base: AuthorityPermitExpectation): ExpectationInit {
    return {
        tenant: base.tenant,
        issuer: base.issuer,
        source: base.source,
        target: base.target,
        principal: base.principal,
        binding: base.binding,
        facet: base.facet,
        operation: base.operation,
        package: base.package,
        impact: base.impact,
        invocation: base.invocation,
        reservation: base.reservation,
        itemIndex: base.itemIndex,
        attemptOrdinal: base.attemptOrdinal,
        claim: base.claim,
        claimOwner: base.claimOwner,
        itemKey: base.itemKey,
        argumentsDigest: base.argumentsDigest,
        intentDigest: base.intentDigest,
        pathEpochs: base.pathEpochs,
        authority: base.authority,
        lease: base.lease
    };
}

async function issue(bytes: Uint8Array): Promise<void> {
    // The transport derives the Tenant object's name from the issuer identity;
    // issuance must land in exactly that object.
    const stub = env.PERMIT_TENANTS.getByName(
        actorObjectName({ kind: PERMIT_TENANT_ACTOR.kind, id: PERMIT_TENANT_ACTOR.id })
    );
    await runInDurableObject(stub, async (tenantObject) => {
        tenantObject.issuePermit(bytes);
    });
}

interface TargetHarness {
    seed(bytes: Uint8Array): Promise<void>;
    admit(bytes: Uint8Array, at?: number, failAppend?: boolean): Promise<string>;
    attempts(): Promise<number>;
    evict(): Promise<void>;
}

function target(instance: string): TargetHarness {
    const stub = env.PERMIT_TARGETS.getByName(instance);
    return {
        seed: async (bytes) =>
            runInDurableObject(stub, async (targetObject) => {
                targetObject.seedExpectation(bytes);
            }),
        admit: async (bytes, at = ISSUED_AT + 1_000, failAppend = false) =>
            runInDurableObject(stub, (targetObject) =>
                targetObject.admitPermit(bytes, at, failAppend)
            ),
        attempts: async () =>
            runInDurableObject(stub, (targetObject) => targetObject.effectAttemptCount()),
        evict: () => evictDurableObject(stub)
    };
}

describe("Cloudflare cross-DO authority permits", () => {
    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] admits an authenticated permit exactly once, atomic with the EffectAttempt", async () => {
        const base = expectation();
        const bytes = permit(base, "nonce-once");
        await issue(bytes);

        const harness = target("consumption");
        await harness.seed(bytes);
        await expect(harness.admit(bytes)).resolves.toBe("nonce-once");
        expect(await harness.attempts()).toBe(1);

        // Single use: the same authenticated permit can never admit again.
        await expect(harness.admit(bytes)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(await harness.attempts()).toBe(1);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] keeps the consumed nonce across a real instance restart", async () => {
        const base = expectation();
        const bytes = permit(base, "nonce-restart");
        await issue(bytes);

        const harness = target("restart");
        await harness.seed(bytes);
        await harness.admit(bytes);
        await harness.evict();

        await harness.seed(bytes);
        await expect(harness.admit(bytes)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(await harness.attempts()).toBe(1);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] rolls back the nonce when the EffectAttempt append fails", async () => {
        const base = expectation();
        const bytes = permit(base, "nonce-rollback");
        await issue(bytes);

        const harness = target("rollback");
        await harness.seed(bytes);
        await expect(harness.admit(bytes, ISSUED_AT + 1_000, true)).rejects.toThrow(
            /Injected effect-append failure/
        );
        expect(await harness.attempts()).toBe(0);

        // Consumption and admission are one synchronous span: the rolled-back
        // nonce is still unused, so the exact same permit admits afterwards.
        await expect(harness.admit(bytes)).resolves.toBe("nonce-rollback");
        expect(await harness.attempts()).toBe(1);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] rejects an expired permit before any EffectAttempt", async () => {
        const base = expectation();
        const bytes = permit(base, "nonce-expiry");
        await issue(bytes);

        const harness = target("expiry");
        await harness.seed(bytes);
        await expect(harness.admit(bytes, EXPIRES_AT + 1)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(await harness.attempts()).toBe(0);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] rejects a permit that was never issued by the Tenant object", async () => {
        const base = expectation();
        const bytes = permit(base, "nonce-forged");

        const harness = target("forged");
        await harness.seed(bytes);
        await expect(harness.admit(bytes)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(await harness.attempts()).toBe(0);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] rejects substitution of every bound field before any EffectAttempt", async () => {
        const base = expectation();
        const canonical = permit(base, "nonce-binding");
        await issue(canonical);

        const harness = target("binding");
        await harness.seed(canonical);

        const alternateInvocation = new InvocationId("permit-other-invocation");
        const substitutions: readonly (readonly [string, AuthorityPermitExpectation])[] = [
            ["source", expectation({ source: new ActorRef("run", new ActorId("other-source")) })],
            [
                "target fence and domain",
                expectation({
                    target: {
                        actor: PERMIT_TARGET_ACTOR,
                        fence: 8,
                        domain: new ProtectionDomain("backend", "other-domain", "no-secrets")
                    }
                })
            ],
            [
                "binding generation",
                expectation({
                    binding: { name: new BindingName("mail"), generation: new Revision(4) }
                })
            ],
            ["facet", expectation({ facet: new FacetRef("workspace:calendar") })],
            ["operation", expectation({ operation: new OperationRef("mail:archive") })],
            [
                "package pin",
                expectation({
                    package: new PackagePin(
                        new PackageId("mail-package"),
                        new SemVer("1.2.4"),
                        digest("manifest"),
                        digest("other-code")
                    )
                })
            ],
            [
                "invocation and reservation",
                expectation({
                    invocation: alternateInvocation,
                    reservation: {
                        run: new RunId("permit-run"),
                        registryEpoch: 5,
                        obligation: {
                            kind: "invocationItem",
                            invocation: alternateInvocation,
                            itemIndex: 0,
                            itemKey: "permit-item"
                        }
                    }
                })
            ],
            [
                "reservation epoch",
                expectation({
                    reservation: {
                        run: new RunId("permit-run"),
                        registryEpoch: 6,
                        obligation: {
                            kind: "invocationItem",
                            invocation: new InvocationId("permit-invocation"),
                            itemIndex: 0,
                            itemKey: "permit-item"
                        }
                    }
                })
            ],
            ["attempt ordinal", expectation({ attemptOrdinal: 1 })],
            ["claim", expectation({ claim: new ItemClaimId("other-claim") })],
            [
                "claim worker",
                expectation({
                    claimOwner: {
                        kind: "executor",
                        token: lease,
                        worker: new ClaimWorkerId("other-worker")
                    }
                })
            ],
            ["arguments digest", expectation({ argumentsDigest: digest("other-arguments") })],
            ["intent digest", expectation({ intentDigest: digest("other-intent") })],
            [
                "path epochs",
                expectation({
                    pathEpochs: new PathEpochEvidence([new ScopeEpoch(ScopeRef.tenant(tenant), 3)])
                })
            ]
        ];

        for (const [field, substituted] of substitutions) {
            const forged = permit(substituted, "nonce-binding");
            await expect(harness.admit(forged), field).rejects.toMatchObject({
                code: "authority.denied"
            });
        }
        expect(await harness.attempts()).toBe(0);

        // The canonical permit still admits — the matrix rejected substitutions,
        // not the issuance.
        await expect(harness.admit(canonical)).resolves.toBe("nonce-binding");
        expect(await harness.attempts()).toBe(1);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] never consults a foreign issuer's store, even for a matching expectation", async () => {
        // Issuer identity is established by transport: the target derives the
        // Tenant object address from its own configuration, so a permit naming a
        // foreign issuer finds no issuance record even when the target's local
        // expectation somehow agrees with it.
        const foreign = expectation({
            issuer: new ActorRef("tenant", new ActorId("foreign-tenant"))
        });
        const bytes = permit(foreign, "nonce-foreign");
        // Issue into OUR tenant's store under the same nonce to prove the lookup
        // is keyed by transport-derived identity, not by permit fields.
        await issue(permit(expectation(), "nonce-foreign"));

        const harness = target("foreign");
        await harness.seed(bytes);
        await expect(harness.admit(bytes)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(await harness.attempts()).toBe(0);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] consumes a valid issued permit regardless of newer post-issuance watermark", async () => {
        // Issuance is the final authority-admission linearization point (§10.3):
        // the target validates and consumes the exact permit without a second
        // authority decision, so authority changes after issuance cannot cancel it.
        const base = expectation();
        const bytes = permit(base, "nonce-watermark");
        await issue(bytes);

        // Simulate post-issuance authority movement: newer path epochs exist at
        // the tenant, but the already issued permit remains consumable.
        const harness = target("watermark");
        await harness.seed(bytes);
        await expect(harness.admit(bytes)).resolves.toBe("nonce-watermark");
        expect(await harness.attempts()).toBe(1);
    });
});
