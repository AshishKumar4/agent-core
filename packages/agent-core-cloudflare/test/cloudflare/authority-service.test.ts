import { RpcStub, RpcTarget, env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AgentCoreError } from "@agent-core/core";
import {
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest
} from "@agent-core/core/protocol";
import {
    CapabilityAuthorityPermitIssuance,
    MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
    type CloudflareErrorPort,
    type TenantAuthorityCapabilityStub
} from "../../src/index.js";
import { isPlatformMessage, isText } from "../../src/platform-value.js";
import {
    authorityServiceContract,
    authorityServiceReply,
    type AuthorityServiceImplementation,
    type AuthorityServiceRequest,
    type AuthorityServiceSite
} from "../authority-service-contract.js";
import { BASE_PERMIT_SPEC, buildTargetRequest, tenantActorRef } from "./permit-fixture.js";
import type { PermitSpec } from "./permit-fixture.js";
import { malformedInput } from "../assertions.js";
import type { TenantAuthorityDurableObject } from "./worker.js";

/**
 * The `tenant.authority` contract against the real adapter: the same three transports, the
 * same `TargetBoundTenantAuthority`, reached through a genuine Durable Object RPC stub the
 * Tenant minted for one caller. The Tenant runs in its own object over a real
 * `SqliteAuthorityPermitStore` and a real `AuthorityPermitIssuer`, so every reply here is a
 * decision that object actually made and every refusal crosses a boundary the caller does
 * not control.
 *
 * The two in-memory implementations run in `test/authority-service.test.ts`. What this lane
 * adds is exactly what a stub adds: an isolate boundary. Measured on workerd 1.20260708.1,
 * an `AgentCoreError` raised inside the Tenant object arrives here with `name`, `message`
 * and `code` copied onto a plain `Error` and its class gone, which is why the contract's
 * one classifier reads those properties instead of `instanceof`.
 */

const TARGET_KIND = "run";
const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

const SPEC_B: PermitSpec = Object.freeze({
    ...BASE_PERMIT_SPEC,
    nonce: "nonce-authority-service-b",
    itemKey: "item-authority-service-b"
});

/**
 * The two requests this Tenant answers. Real encoded issuance requests, because the Tenant
 * decodes what it is sent and refuses a request whose target is not the caller its
 * capability was minted for: the idempotency key is the claim nonce inside the bytes, which
 * is the same pairing a mediated call makes.
 */
const REQUESTS: readonly [AuthorityServiceRequest, AuthorityServiceRequest] = Object.freeze([
    Object.freeze({
        bytes: AuthorityPermitIssuanceRequest.encode(
            new AuthorityPermitIssuanceRequest(buildTargetRequest(BASE_PERMIT_SPEC))
        ),
        key: BASE_PERMIT_SPEC.nonce
    }),
    Object.freeze({
        bytes: AuthorityPermitIssuanceRequest.encode(
            new AuthorityPermitIssuanceRequest(buildTargetRequest(SPEC_B))
        ),
        key: SPEC_B.nonce
    })
]);

const BOUND_CALLER = `${TARGET_KIND}:${BASE_PERMIT_SPEC.targetActor}`;

/** What one site reads to answer the contract's observations. */
interface TenantObservations {
    carried(): Promise<readonly Uint8Array[]>;
    callers(): Promise<readonly string[]>;
    decisions(keys: readonly string[]): Promise<readonly string[]>;
}

/**
 * A Tenant capability that answers no bytes. Reached through a real `RpcStub`, so the reply
 * crosses the RPC machinery — serialization, ownership, the whole handle — on its way to
 * `requireReply`. The cross-object Tenant cannot be asked for a broken reply without
 * changing what that object answers, and what it answers is the subject of another suite.
 */
class EmptyReplyTenantCapability extends RpcTarget {
    public readonly arrivals: Uint8Array[] = [];

    public async issuePermit(request: Uint8Array): Promise<Uint8Array> {
        this.arrivals.push(new Uint8Array(request));
        return new Uint8Array();
    }

    public async issuedPermit(): Promise<Uint8Array | undefined> {
        return undefined;
    }

    public async projectLeaseEvidence(evidence: Uint8Array): Promise<Uint8Array> {
        this.arrivals.push(new Uint8Array(evidence));
        return new Uint8Array();
    }
}

/** A Tenant capability that fails in a way this service's taxonomy does not name. */
class FaultingTenantCapability extends RpcTarget {
    public async issuePermit(): Promise<Uint8Array> {
        throw new RangeError("This Tenant failed in a way the taxonomy does not name");
    }

    public async issuedPermit(): Promise<Uint8Array | undefined> {
        throw new RangeError("This Tenant failed in a way the taxonomy does not name");
    }

    public async projectLeaseEvidence(): Promise<Uint8Array> {
        throw new RangeError("This Tenant failed in a way the taxonomy does not name");
    }
}

/** One Tenant object per site, so no site inherits another's storage or call log. */
let minted = 0;

function tenantObservations(
    tenant: DurableObjectStub<TenantAuthorityDurableObject>
): TenantObservations {
    return {
        async carried() {
            return (await tenant.forwarded()).map((call) => new Uint8Array(call.bytes));
        },
        async callers() {
            return (await tenant.forwarded()).map((call) => call.caller);
        },
        async decisions(keys) {
            // The Tenant's own permit record, read out of its SQLite. It is keyed by the
            // claim nonce, which is the key a mediated call carries, so this is the durable
            // effect of one keyed request and not a count of arrivals.
            return (await Promise.all(keys.map(async (key) => tenant.heldDigest(key)))).filter(
                isText
            );
        }
    };
}

function siteOver(
    capability: TenantAuthorityCapabilityStub,
    observations: TenantObservations,
    release: () => void
): AuthorityServiceSite {
    return {
        channel: { issuer: tenantActorRef(BASE_PERMIT_SPEC), capability, errors },
        requests: REQUESTS,
        boundCaller: BOUND_CALLER,
        carried: observations.carried,
        callers: observations.callers,
        decisions: observations.decisions,
        [Symbol.dispose]() {
            release();
        }
    };
}

const durableObjectRpc: AuthorityServiceImplementation = {
    async site(scenario) {
        minted += 1;
        const name = `authority-service-${minted}`;
        if (scenario.kind === "refuses" && scenario.code === "operation.invalid-output") {
            const tenant = new EmptyReplyTenantCapability();
            const stub = new RpcStub(tenant);
            return siteOver(
                stub,
                {
                    async carried() {
                        return tenant.arrivals;
                    },
                    async callers() {
                        return tenant.arrivals.map(() => BOUND_CALLER);
                    },
                    async decisions() {
                        return [];
                    }
                },
                () => stub[Symbol.dispose]()
            );
        }
        if (scenario.kind === "faults") {
            // A real stub whose receiver implements none of the operations: the shape the
            // declared interface forbids and a live RPC parameter can still deliver. The
            // guard admits it — see the case below — so the fault arrives at the call,
            // which is the undeclared failure this transport actually meets here.
            const bare = env.TENANT_AUTHORITY.getByName(name);
            return siteOver(malformedInput(bare), tenantObservations(bare), () => {});
        }
        const tenant = env.TENANT_AUTHORITY.getByName(name);
        // Ownership of a stub passed over RPC transfers to the recipient and the platform
        // disposes it when that call returns, so this lane mints one and holds it for the
        // whole site rather than sending it anywhere: the caller half runs here, in the
        // isolate that holds the handle, and the site is what releases it.
        const capability = await tenant.bindTarget(TARGET_KIND, BASE_PERMIT_SPEC.targetActor);
        return siteOver(capability, tenantObservations(tenant), () => capability[Symbol.dispose]());
    }
};

authorityServiceContract("workerd Durable Object RPC", durableObjectRpc);

describe("Tenant authority service protocol on workerd", () => {
    it(
        "answers a reply core can decode as the Tenant's own recorded decision",
        { tags: "p0" },
        async () => {
            const tenant = env.TENANT_AUTHORITY.getByName("authority-service-decodable");
            using capability = await tenant.bindTarget(TARGET_KIND, BASE_PERMIT_SPEC.targetActor);
            const [first] = REQUESTS;

            const reply = await authorityServiceReply(() =>
                new CapabilityAuthorityPermitIssuance({
                    issuer: tenantActorRef(BASE_PERMIT_SPEC),
                    capability,
                    errors
                }).issue(first.bytes, first.key)
            );

            expect(reply.kind).toBe("answered");
            if (reply.kind !== "answered") return;
            // The contract refuses a reply it cannot decode because core can only refuse a
            // substituted decision on a reply it can decode. This is the other half of that
            // claim: what the transport carried is byte-for-byte the decision the Tenant
            // recorded in its own storage, so nothing between them substituted anything.
            const decoded = AuthorityPermitIssuanceReply.decode(reply.reply);
            expect(decoded.kind).toBe("issued");
            expect(decoded.requirePermit().digest().value).toBe(await tenant.heldDigest(first.key));
        }
    );

    it(
        "admits a stub whose receiver implements none of the operations and faults at the call",
        { tags: "p1" },
        async () => {
            const bare = env.TENANT_AUTHORITY.getByName("authority-service-bare");
            const capability: TenantAuthorityCapabilityStub = malformedInput(bare);
            const [first] = REQUESTS;

            // Finding, recorded rather than fixed: `requireCapability` proves each method
            // exists with `in` and `typeof`, and on a real stub every property access is a
            // lazily resolved RPC method, so the guard passes for a receiver that implements
            // none of them. The check is meaningful for a malformed local object and vacuous
            // across the boundary it exists to guard.
            expect(
                () =>
                    new CapabilityAuthorityPermitIssuance({
                        issuer: tenantActorRef(BASE_PERMIT_SPEC),
                        capability,
                        errors
                    })
            ).not.toThrow();

            const reply = await authorityServiceReply(() =>
                new CapabilityAuthorityPermitIssuance({
                    issuer: tenantActorRef(BASE_PERMIT_SPEC),
                    capability,
                    errors
                }).issue(first.bytes, first.key)
            );

            // The platform's own refusal carries no code, so the runtime does not know what
            // happened: that is indeterminate, not `operation.invalid-output`, and calling
            // it a refusal would attribute a broken binding to a Tenant decision.
            expect(reply.kind).toBe("indeterminate");
            if (reply.kind !== "indeterminate") return;
            expect(isPlatformMessage(reply.cause) && reply.cause.message).toContain("issuePermit");
        }
    );

    it(
        "carries an undeclared Tenant failure back as indeterminate with its cause",
        { tags: "p1" },
        async () => {
            using stub = new RpcStub(new FaultingTenantCapability());
            const [first] = REQUESTS;

            const reply = await authorityServiceReply(() =>
                new CapabilityAuthorityPermitIssuance({
                    issuer: tenantActorRef(BASE_PERMIT_SPEC),
                    capability: stub,
                    errors
                }).issue(first.bytes, first.key)
            );

            expect(reply.kind).toBe("indeterminate");
            if (reply.kind !== "indeterminate") return;
            // A throw the taxonomy does not name crosses the boundary as itself, with no
            // code to classify it by, and the cause travels whole.
            expect(isPlatformMessage(reply.cause) && reply.cause.message).toBe(
                "This Tenant failed in a way the taxonomy does not name"
            );
        }
    );

    it(
        "keeps a refusal raised in the Tenant object classifiable at the caller",
        { tags: "p0" },
        async () => {
            const tenant = env.TENANT_AUTHORITY.getByName("authority-service-crossing");
            using capability = await tenant.bindTarget(TARGET_KIND, BASE_PERMIT_SPEC.targetActor);
            const [first] = REQUESTS;
            const issuance = new CapabilityAuthorityPermitIssuance({
                issuer: tenantActorRef(BASE_PERMIT_SPEC),
                capability,
                errors
            });

            const refused = await authorityServiceReply(() =>
                issuance.issue(first.bytes, "k".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH + 1))
            );

            // The refusal was raised by `TargetBoundTenantAuthority` inside another isolate
            // and arrives here without its class. That it still classifies is the whole
            // reason the contract's one classifier reads `name` and `code`: an
            // `instanceof AgentCoreError` test would have made this indeterminate, and the
            // runtime would have lost a refusal the Tenant actually gave.
            expect(refused).toEqual({ kind: "refused", code: "operation.invalid-input" });
            expect(await tenant.forwarded()).toEqual([]);
        }
    );

    it(
        "leaves the platform's own disposer on a received stub uncalled",
        { tags: "p1" },
        async () => {
            const tenant = env.TENANT_AUTHORITY.getByName("authority-service-lifetime");
            using capability = await tenant.bindTarget(TARGET_KIND, BASE_PERMIT_SPEC.targetActor);
            const [first] = REQUESTS;

            // The handle the platform hands a target IS disposable, even though
            // `TenantAuthorityCapabilityStub` declares no disposer: the means to sever it is
            // right there on the value the transport holds. That is what makes the claim
            // worth asserting rather than assuming.
            expect(typeof capability[Symbol.dispose]).toBe("function");

            const issuance = new CapabilityAuthorityPermitIssuance({
                issuer: tenantActorRef(BASE_PERMIT_SPEC),
                capability,
                errors
            });
            await issuance.issue(first.bytes, first.key);
            const after = await authorityServiceReply(() => issuance.issue(first.bytes, first.key));

            // Still answering, so the transport did not call it. A disposed stub refuses
            // every later call with a platform error that carries no code at all, which the
            // contract would have had to report as indeterminate — the runtime losing a
            // Tenant it could still reach.
            expect(after.kind).toBe("answered");
            expect(await tenant.disposals()).toBe(0);
        }
    );
});
