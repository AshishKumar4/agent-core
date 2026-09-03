import { describe, expect, test } from "vitest";
import { AgentCoreError, Digest } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import {
    CapabilityAuthorityPermitIssuance,
    CapabilityAuthorityPermitRecords,
    CapabilityTargetLeaseEvidenceProjection,
    MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
    MAXIMUM_KEYED_CALLS,
    SQL_BLOB_LIMIT_BYTES,
    TargetBoundTenantAuthority,
    TenantAuthorityPermitSink,
    operationalFailure,
    type CloudflareErrorPort,
    type TenantAuthorityCapabilityStub
} from "../src/index.js";
import { isText } from "../src/platform-value.js";
import {
    AUTHORITY_SERVICE_OPERATIONS,
    AUTHORITY_SERVICE_REFUSALS,
    authorityServiceContract,
    authorityServiceReply,
    type AuthorityServiceImplementation,
    type AuthorityServiceScenario,
    type AuthorityServiceSite
} from "./authority-service-contract.js";

/**
 * The `tenant.authority` contract in the structural lane, run against both in-memory
 * implementations this package has: a reference capability that states the admission rules
 * the protocol declares, and the real `TargetBoundTenantAuthority` over the same Tenant.
 *
 * The reference is the control. It is what the contract would look like if the capability
 * were written from the protocol rather than from the adapter, so a case only the real
 * capability fails is a fact about the adapter and a case both fail is a fact about the
 * contract. The third implementation — the same protocol over a genuine Durable Object RPC
 * stub — runs in `test/cloudflare/authority-service.test.ts`, because a real stub exists
 * only on workerd.
 */

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

const tenantActor = new ActorRef("tenant", new ActorId("authority-service-tenant"));
const runActor = new ActorRef("run", new ActorId("authority-service-run"));
const BOUND_CALLER = `${runActor.kind}:${runActor.id.value}`;

const REQUEST_A = new TextEncoder().encode("permit-request-a");
const REQUEST_B = new TextEncoder().encode("permit-request-b-with-different-bytes");

interface KeyedCall {
    readonly caller: string;
    readonly payload: Uint8Array;
    readonly key: string;
}

/**
 * The Tenant, as this contract has to observe it. It records every arrival, and it holds
 * one durable decision per idempotency key, because the Tenant's own record — never the
 * transport, and never the capability — is what makes a redelivery idempotent.
 *
 * The scenario decides what this Tenant answers, and nothing here names a taxonomy code:
 * the adapters' own classification is what the contract measures, so this sink presents a
 * condition and lets them decide.
 */
class RecordingTenant extends TenantAuthorityPermitSink {
    /** Issuance arrivals only, because that is the arrival every lane can observe. */
    public readonly issues: KeyedCall[] = [];
    public readonly projections: KeyedCall[] = [];
    readonly #decisions = new Map<string, Uint8Array>();

    public constructor(private readonly scenario: AuthorityServiceScenario) {
        super();
    }

    public async issue(
        caller: ActorRef,
        request: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array> {
        this.issues.push({
            caller: `${caller.kind}:${caller.id.value}`,
            payload: request.slice(),
            key: idempotencyKey
        });
        if (this.scenario.kind === "faults") {
            throw new RangeError("This Tenant failed in a way the taxonomy does not name");
        }
        if (this.scenario.kind === "refuses" && this.scenario.code === "operation.invalid-output") {
            return new Uint8Array();
        }
        const held = this.#decisions.get(idempotencyKey);
        // A repeat of a key this Tenant already decided replays that decision rather than
        // deciding again, which is what makes the second delivery of one claim safe.
        if (held !== undefined) return held;
        const issued = new TextEncoder().encode(`permit:${Digest.sha256(request).value}`);
        this.#decisions.set(idempotencyKey, issued);
        return issued;
    }

    public async issued(
        _caller: ActorRef,
        nonce: string,
        digest: string
    ): Promise<Uint8Array | undefined> {
        const held = this.#decisions.get(nonce);
        // The Tenant answers only the record it actually holds under that digest, so a
        // lookup the record disagrees with is absent rather than substituted.
        if (held === undefined || Digest.sha256(held).value !== digest) return undefined;
        return held;
    }

    public async project(
        caller: ActorRef,
        evidence: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array> {
        this.projections.push({
            caller: `${caller.kind}:${caller.id.value}`,
            payload: evidence.slice(),
            key: idempotencyKey
        });
        if (this.scenario.kind === "faults") {
            throw new RangeError("This Tenant failed in a way the taxonomy does not name");
        }
        if (this.scenario.kind === "refuses" && this.scenario.code === "operation.invalid-output") {
            return new Uint8Array();
        }
        return evidence.slice();
    }

    /** The identity of the decision this Tenant retains under one key, if it holds one. */
    public decision(key: string): string | undefined {
        const held = this.#decisions.get(key);
        if (held === undefined) return undefined;
        return Digest.sha256(held).value;
    }
}

/**
 * The reference capability: the admission the protocol states, written over the Tenant
 * directly rather than by reusing the adapter under test. A capability is request-scoped
 * and its key guard is a bound on attacker-supplied state, so the reference states both
 * from the module's own constants — a second copy of the numbers here would be a second
 * source of truth that could drift from the capability the contract certifies.
 */
class ReferenceTenantCapability implements TenantAuthorityCapabilityStub {
    readonly #keyed = new Map<string, string>();

    public constructor(
        private readonly caller: ActorRef,
        private readonly sink: RecordingTenant
    ) {}

    public async issuePermit(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        this.#admit(request, idempotencyKey, "permit issuance");
        return this.sink.issue(this.caller, request.slice(), idempotencyKey);
    }

    public async issuedPermit(nonce: string, digest: string): Promise<Uint8Array | undefined> {
        if (nonce.length === 0 || digest.length === 0) {
            operationalFailure(
                errors,
                "operation.invalid-input",
                "An issued-permit lookup requires a non-empty nonce and digest"
            );
        }
        return this.sink.issued(this.caller, nonce, digest);
    }

    public async projectLeaseEvidence(
        evidence: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array> {
        this.#admit(evidence, idempotencyKey, "lease evidence projection");
        return this.sink.project(this.caller, evidence.slice(), idempotencyKey);
    }

    #admit(payload: Uint8Array, idempotencyKey: string, subject: string): void {
        if (
            idempotencyKey.length === 0 ||
            idempotencyKey.length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH ||
            payload.byteLength === 0 ||
            payload.byteLength > SQL_BLOB_LIMIT_BYTES
        ) {
            operationalFailure(
                errors,
                "operation.invalid-input",
                `A ${subject} requires a non-empty idempotency key inside ` +
                    `${MAXIMUM_IDEMPOTENCY_KEY_LENGTH} characters and a payload inside ` +
                    `${SQL_BLOB_LIMIT_BYTES} bytes`
            );
        }
        const digest = Digest.sha256(payload).value;
        const carried = this.#keyed.get(idempotencyKey);
        if (carried === undefined) {
            if (this.#keyed.size >= MAXIMUM_KEYED_CALLS) {
                operationalFailure(
                    errors,
                    "operation.invalid-input",
                    `A capability admits ${MAXIMUM_KEYED_CALLS} distinct idempotency keys ` +
                        "before it must be re-minted"
                );
            }
            this.#keyed.set(idempotencyKey, digest);
            return;
        }
        if (carried !== digest) {
            operationalFailure(
                errors,
                "authority.denied",
                `A ${subject} rebound idempotency key ${idempotencyKey} to different bytes`
            );
        }
    }
}

function siteOver(
    tenant: RecordingTenant,
    capability: TenantAuthorityCapabilityStub,
    release: () => void
): AuthorityServiceSite {
    return {
        channel: { issuer: tenantActor, capability, errors },
        requests: [
            { bytes: REQUEST_A, key: "authority-service-key-a" },
            { bytes: REQUEST_B, key: "authority-service-key-b" }
        ],
        boundCaller: BOUND_CALLER,
        async carried() {
            return tenant.issues.map((call) => call.payload);
        },
        async callers() {
            return tenant.issues.map((call) => call.caller);
        },
        async decisions(keys) {
            return keys.map((key) => tenant.decision(key)).filter(isText);
        },
        [Symbol.dispose]() {
            release();
        }
    };
}

const reference: AuthorityServiceImplementation = {
    async site(scenario) {
        const tenant = new RecordingTenant(scenario);
        // Nothing to release: the reference capability holds no platform handle, which is
        // the same position the declared stub interface takes.
        return siteOver(tenant, new ReferenceTenantCapability(runActor, tenant), () => {});
    }
};

const boundCapability: AuthorityServiceImplementation = {
    async site(scenario) {
        const tenant = new RecordingTenant(scenario);
        const capability = new TargetBoundTenantAuthority({
            tenantActor,
            caller: runActor,
            sink: tenant,
            errors
        });
        // The site minted it, so the site releases it. That is the whole of the lifetime
        // claim this contract makes about a capability.
        return siteOver(tenant, capability, () => capability[Symbol.dispose]());
    }
};

authorityServiceContract("reference", reference);
authorityServiceContract("in-memory target-bound capability", boundCapability);

describe("Tenant authority service protocol", () => {
    test("declares exactly the operations one capability has to serve", { tags: "p2" }, () => {
        expect([...AUTHORITY_SERVICE_OPERATIONS]).toEqual([
            "issuePermit",
            "issuedPermit",
            "projectLeaseEvidence"
        ]);
        // The reference serves the vocabulary and nothing else, which is the direction
        // that catches a vocabulary entry no implementation serves. The real capability
        // is only required to carry every declared operation: its `transport`, `issuer`
        // and `caller` members belong to the Tenant that mints it, not to the protocol
        // a holder speaks.
        expect(
            Object.getOwnPropertyNames(ReferenceTenantCapability.prototype)
                .filter((name) => name !== "constructor")
                .sort()
        ).toEqual([...AUTHORITY_SERVICE_OPERATIONS]);
        const offered = Object.getOwnPropertyNames(TargetBoundTenantAuthority.prototype);
        expect(AUTHORITY_SERVICE_OPERATIONS.every((name) => offered.includes(name))).toBe(true);
    });

    test("gives the transports no lifetime surface at all", { tags: "p0" }, () => {
        // A received stub is disposed by the platform when the call that delivered it
        // returns, so the transport must not release one. The strongest form of that
        // claim is structural: none of the three transports has a disposer to call.
        for (const transport of [
            CapabilityAuthorityPermitIssuance,
            CapabilityAuthorityPermitRecords,
            CapabilityTargetLeaseEvidenceProjection
        ]) {
            expect(Object.getOwnPropertySymbols(transport.prototype)).toEqual([]);
            expect(Object.getOwnPropertyNames(transport.prototype)).not.toContain("dispose");
        }
        // And the stub the target holds declares none either: the reference implements
        // the interface exactly, so a disposer on it would be a lifetime the protocol
        // does not have.
        expect(Object.getOwnPropertySymbols(ReferenceTenantCapability.prototype)).toEqual([]);
    });

    test(
        "classifies a code outside the service vocabulary as indeterminate",
        { tags: "p0" },
        async () => {
            // `codec.invalid` is a real operational code and not one this service's
            // vocabulary declares, so reporting it as a refusal would claim the Tenant
            // answered something it never said. The other direction of the same closure:
            // a value that merely carries a declared code is not core's failure at all.
            const foreign = await authorityServiceReply(() => {
                throw new AgentCoreError("codec.invalid", "A codec refused a Tenant reply");
            });
            const impostor = await authorityServiceReply(() => {
                throw Object.assign(new Error("not core's own failure"), {
                    code: "authority.denied"
                });
            });
            const declared: readonly string[] = AUTHORITY_SERVICE_REFUSALS;

            expect(foreign.kind).toBe("indeterminate");
            expect(impostor.kind).toBe("indeterminate");
            expect(declared).not.toContain("codec.invalid");
        }
    );

    test(
        "classifies a callee refusal by the properties that survive the transport",
        { tags: "p0" },
        async () => {
            // Measured on workerd 1.20260708.1: an AgentCoreError raised inside a Durable
            // Object and propagated over RPC arrives with `name`, `message` and `code`
            // copied onto a plain Error and its class gone. This is that value, built the
            // way the platform delivers it, so the structural lane holds the same claim the
            // workerd lane measures: classifying on `instanceof` would report every
            // callee-side refusal the real transport carries as indeterminate.
            const delivered = Object.assign(
                new Error("A capability admits 64 distinct idempotency keys"),
                { name: AgentCoreError.name, code: "operation.invalid-input", remote: true }
            );

            const reply = await authorityServiceReply(() => {
                throw delivered;
            });

            expect(reply).toEqual({ kind: "refused", code: "operation.invalid-input" });
            expect(delivered instanceof AgentCoreError).toBe(false);
        }
    );

    test(
        "reads an issued record back under the digest the Tenant keyed it with",
        { tags: "p1" },
        async () => {
            // The absent case in the contract body covers a permit nobody issued. This is
            // the other side of the same lookup: a record the Tenant does hold is answered
            // as bytes, so `absent` is a reply about the record and not about the seam.
            const tenant = new RecordingTenant({ kind: "answers" });
            using site = siteOver(
                tenant,
                new ReferenceTenantCapability(runActor, tenant),
                () => {}
            );
            const [first] = site.requests;
            await new CapabilityAuthorityPermitIssuance(site.channel).issue(first.bytes, first.key);
            const [held] = await site.decisions([first.key]);
            expect(held).toBeDefined();
            if (held === undefined) return;

            const found = await authorityServiceReply(() =>
                new CapabilityAuthorityPermitRecords(site.channel).issued(
                    tenantActor,
                    first.key,
                    new Digest(held)
                )
            );

            expect(found.kind).toBe("answered");
        }
    );

    test(
        "answers a channel whose issuer is not a Tenant as indeterminate",
        { tags: "p1" },
        async () => {
            // `requireCapability` refuses a non-Tenant issuer with a plain TypeError rather
            // than through the error port, which is the right shape — a channel wired to a
            // Run Actor is the runtime's own construction bug and not something a Tenant
            // answered — and the consequence the vocabulary has to own is that it carries no
            // code, so the contract reports it as indeterminate. A refusal code here would
            // claim a Tenant refused a call that was never made.
            const tenant = new RecordingTenant({ kind: "answers" });
            const capability = new ReferenceTenantCapability(runActor, tenant);

            const reply = await authorityServiceReply(() =>
                new CapabilityAuthorityPermitIssuance({
                    issuer: runActor,
                    capability,
                    errors
                }).issue(REQUEST_A, "never-sent")
            );

            expect(reply.kind).toBe("indeterminate");
            if (reply.kind !== "indeterminate") return;
            expect(reply.cause).toBeInstanceOf(TypeError);
            // Nothing crossed: the request never left the caller.
            expect(tenant.issues).toEqual([]);
        }
    );
});
