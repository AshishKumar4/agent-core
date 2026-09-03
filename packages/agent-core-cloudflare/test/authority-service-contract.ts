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
    type TenantAuthorityCapabilityChannel
} from "../src/index.js";
import { isPlatformObject, isText } from "../src/platform-value.js";

/**
 * The `tenant.authority` service contract from
 * `packages/agent-core/artifacts/service-contracts.json`.
 *
 * The runtime's seam onto a Tenant Actor's authority surface is a capability. The Tenant
 * mints a `TargetBoundTenantAuthority` for exactly one caller, hands that caller a stub
 * for it, and the caller reaches the Tenant through `CapabilityAuthorityPermitIssuance`,
 * `CapabilityAuthorityPermitRecords` and `CapabilityTargetLeaseEvidenceProjection`. The
 * bytes travel opaquely in both directions: SPEC section 10.3 places the issuance decision
 * in the Tenant Actor, so this profile authenticates who asked, carries what they sent, and
 * decides nothing about it.
 *
 * It is an external service in the sense that matters here — the Tenant is a different
 * Actor in a different Durable Object, reached over an RPC boundary the caller does not
 * control — and this module is the executable half of its protocol, shaped the way
 * `AgentCore.Substrate`'s law sets are: a closed operation vocabulary, a closed reply
 * vocabulary in which a service failure is a value rather than a throw, and one
 * parameterised body every implementation answers.
 *
 * One measured fact shapes the whole model. On workerd 1.20260708.1 an `AgentCoreError`
 * raised inside a Durable Object and propagated over RPC reaches the caller with its own
 * properties copied (`name`, `code`, plus a `remote` marker) but WITHOUT its class, so
 * `instanceof AgentCoreError` is false for every callee-side refusal the real transport
 * carries. `authorityServiceReply` is the correspondence between what the adapters throw
 * and what the contract says the service answered, and it classifies on the properties
 * that survive rather than on the class that does not.
 */

/**
 * The closed operation vocabulary: exactly the three methods a target-bound Tenant
 * capability offers, which is the whole surface `TenantAuthorityCapabilityStub` declares.
 * Exact-match membership only — a capability is unforgeable because the Tenant minted it,
 * not because its method names look a certain way.
 */
export const AUTHORITY_SERVICE_OPERATIONS = Object.freeze([
    "issuePermit",
    "issuedPermit",
    "projectLeaseEvidence"
] as const);

export type AuthorityServiceOperation = (typeof AUTHORITY_SERVICE_OPERATIONS)[number];

/**
 * The closed refusal vocabulary: the Tenant capability was reached and the answer is a
 * failure. Every code is a `CloudflareOperationalErrorCode`, because both halves of this
 * protocol raise through `operationalFailure` and the runtime's shared taxonomy is what a
 * caller can act on.
 *
 * Declared in the order the protocol owns them: the Tenant's own authority decision, then
 * the admission of an attacker-supplied request, then the shape of the reply that comes
 * back. `operation.invalid-output` is raised at two distinct sites — a stub of invalid
 * shape at construction and a reply that is not Tenant bytes at call time — and both are
 * the same claim, that the transport is broken rather than that the Tenant decided
 * something.
 */
export const AUTHORITY_SERVICE_REFUSALS = Object.freeze([
    "authority.denied",
    "operation.invalid-input",
    "operation.invalid-output"
] as const);

export type AuthorityServiceRefusalCode = (typeof AUTHORITY_SERVICE_REFUSALS)[number];

/**
 * The closed reply vocabulary, as values, so a suite can check that what it observed is
 * what the vocabulary declares and nothing else.
 *
 * `absent` earns its own kind rather than folding into `refused` or into `answered`: an
 * `issuedPermit` lookup answers `undefined` for a permit that was never issued, and
 * `CapabilityAuthorityPermitRecords.issued` returns that `undefined` before `requireReply`
 * ever sees it. A permit nobody issued is a fact the authenticator needs — it is what
 * makes a substituted permit detectable — and reporting it as a broken reply would hide
 * the very denial the authentication step exists to find.
 *
 * `indeterminate` earns its own kind because an undeclared throw means the runtime does
 * not know what happened, which is a different claim from "the Tenant refused". Its cause
 * travels whole and is never collapsed into a refusal code the Tenant never gave.
 */
export const AUTHORITY_SERVICE_REPLIES = Object.freeze([
    "answered",
    "absent",
    "refused",
    "indeterminate"
] as const);

export type AuthorityServiceReplyKind = (typeof AUTHORITY_SERVICE_REPLIES)[number];

export type AuthorityServiceReply =
    | { readonly kind: "answered"; readonly reply: Uint8Array }
    | { readonly kind: "absent" }
    | { readonly kind: "refused"; readonly code: AuthorityServiceRefusalCode }
    | { readonly kind: "indeterminate"; readonly cause: unknown };

/**
 * Membership over closed literal sets, so a code or a kind the union does not carry cannot
 * be classified. Records rather than Sets because both tables are static and string-keyed;
 * `provider-capability.ts#DISCLOSED_CODES` states its disclosed set the same way.
 */
const REFUSAL_CODES: Readonly<Record<string, true>> = Object.freeze(
    Object.fromEntries(AUTHORITY_SERVICE_REFUSALS.map((code) => [code, true as const]))
);
const REPLY_KINDS: Readonly<Record<string, true>> = Object.freeze(
    Object.fromEntries(AUTHORITY_SERVICE_REPLIES.map((kind) => [kind, true as const]))
);

/**
 * Whether a thrown value is one of the runtime's own operational failures, established by
 * the two properties that survive this service's transport instead of by a class that does
 * not. `AgentCoreError.name` rather than a literal, so the discriminator cannot drift from
 * the class it names.
 */
function isOperationalFailure(value: unknown): value is { readonly code: string } {
    return (
        isPlatformObject(value) &&
        "name" in value &&
        value.name === AgentCoreError.name &&
        "code" in value &&
        isText(value.code)
    );
}

/**
 * One call, one reply value. This is the whole correspondence between what the adapters
 * throw and what the contract says the service answered, and it is the only place in these
 * files that inspects a thrown value. Total: every failure the protocol declares becomes
 * exactly one reply, and anything undeclared becomes `indeterminate` rather than being
 * dressed up as a refusal the Tenant never gave.
 */
export async function authorityServiceReply(
    call: () => Promise<Uint8Array | undefined>
): Promise<AuthorityServiceReply> {
    try {
        const reply = await call();
        if (reply === undefined) return { kind: "absent" };
        return { kind: "answered", reply };
    } catch (cause) {
        if (isOperationalFailure(cause) && REFUSAL_CODES[cause.code] === true) {
            // SAFETY: REFUSAL_CODES holds exactly the keys of AUTHORITY_SERVICE_REFUSALS,
            // so a code it admits is one of that tuple's members and nothing else.
            return { kind: "refused", code: cause.code as AuthorityServiceRefusalCode };
        }
        return { kind: "indeterminate", cause };
    }
}

/**
 * What an implementation must be able to be put into. One member per reply the vocabulary
 * declares, so a suite that iterates the taxonomy cannot skip a case: an implementation
 * that cannot produce a declared refusal fails to compile.
 *
 * Two of the refusals are provoked by the call rather than by the capability — an
 * over-length key and a rebound key are things a holder does — so an implementation may
 * answer those scenarios with an ordinary capability. `operation.invalid-output` and
 * `faults` are conditions only the capability can present, and each implementation states
 * them in its own terms rather than being handed a code to echo.
 */
export type AuthorityServiceScenario =
    | { readonly kind: "answers" }
    | { readonly kind: "absent" }
    | { readonly kind: "refuses"; readonly code: AuthorityServiceRefusalCode }
    | { readonly kind: "faults" };

/** One request a Tenant will answer, under the idempotency key that keys it. */
export interface AuthorityServiceRequest {
    readonly bytes: Uint8Array;
    readonly key: string;
}

/**
 * One capability, one Tenant behind it, and the observables the invariants need. The
 * transport under test is always the real one: what an implementation supplies is the
 * capability the channel reaches the Tenant through.
 *
 * The site owns the handle it minted, and disposes it — which is exactly the claim the
 * transport must not make. Cloudflare disposes a stub received as an RPC parameter when
 * that call returns
 * (https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call),
 * so the minter owns the lifetime and `TenantAuthorityCapabilityStub` declares no disposer
 * at all.
 */
export interface AuthorityServiceSite extends Disposable {
    readonly channel: TenantAuthorityCapabilityChannel;
    /** Two distinct requests this Tenant answers, each under its own idempotency key. */
    readonly requests: readonly [AuthorityServiceRequest, AuthorityServiceRequest];
    /** The caller this capability was minted for, rendered `kind:id`. */
    readonly boundCaller: string;
    /**
     * The issuance request bytes the Tenant's own sink received, in arrival order.
     * Issuances only, because that is the arrival every implementation can report: a
     * Tenant is free to answer a projection without recording anything.
     */
    carried(): Promise<readonly Uint8Array[]>;
    /** The caller each of those arrivals was attributed to, in the same order. */
    callers(): Promise<readonly string[]>;
    /**
     * The durable decisions the Tenant retains under `keys`, absent ones dropped. The
     * identities are opaque: the transport cannot inspect a Tenant reply, so neither does
     * this contract, and only equality between them is ever asserted.
     */
    decisions(keys: readonly string[]): Promise<readonly string[]>;
}

export interface AuthorityServiceImplementation {
    site(scenario: AuthorityServiceScenario): Promise<AuthorityServiceSite>;
}

/**
 * A Tenant no capability in this contract reaches. A lookup that named it would ask a
 * target to authenticate a permit against a record it has no authority over.
 */
export const UNREACHABLE_TENANT = new ActorRef(
    "tenant",
    new ActorId("authority-service-unreachable-tenant")
);

/** A claim nonce no Tenant in this contract ever issued a permit under. */
export const UNISSUED_NONCE = "authority-service-nonce-never-issued";

export function authorityServiceContract(
    name: string,
    implementation: AuthorityServiceImplementation
): void {
    describe(`${name} Tenant authority service contract`, () => {
        test(
            "answers a Tenant reply as opaque bytes and carries the request unchanged",
            { tags: "p0" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first] = site.requests;

                const reply = await authorityServiceReply(() =>
                    new CapabilityAuthorityPermitIssuance(site.channel).issue(
                        first.bytes,
                        first.key
                    )
                );

                expect(reply.kind).toBe("answered");
                if (reply.kind !== "answered") return;
                // Bytes, not a decoded decision: the transport hands core something core
                // can decode and takes no view on what it says.
                expect(reply.reply).toBeInstanceOf(Uint8Array);
                expect(reply.reply.byteLength).toBeGreaterThan(0);
                // The request arrived at the Tenant exactly as it was sent.
                expect(await site.carried()).toEqual([first.bytes]);
            }
        );

        test(
            "answers every refusal the taxonomy declares, and declares every refusal it answers",
            { tags: "p0" },
            async () => {
                const answered: string[] = [];
                for (const code of AUTHORITY_SERVICE_REFUSALS) {
                    using site = await implementation.site({ kind: "refuses", code });
                    const [first, second] = site.requests;
                    const issuance = new CapabilityAuthorityPermitIssuance(site.channel);
                    let reply: AuthorityServiceReply;
                    if (code === "authority.denied") {
                        // The Tenant's own authority refusal: one key that already carried
                        // bytes, asked to carry different ones, would bind one claim to two
                        // requests.
                        await issuance.issue(first.bytes, first.key);
                        reply = await authorityServiceReply(() =>
                            issuance.issue(second.bytes, first.key)
                        );
                    } else if (code === "operation.invalid-input") {
                        reply = await authorityServiceReply(() =>
                            issuance.issue(
                                first.bytes,
                                "k".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH + 1)
                            )
                        );
                    } else {
                        // The capability answers, and answers something that is not Tenant
                        // reply bytes. Nothing here names the code: the adapter's own
                        // classification is what this case measures.
                        reply = await authorityServiceReply(() =>
                            issuance.issue(first.bytes, first.key)
                        );
                    }

                    expect(reply).toEqual({ kind: "refused", code });
                    answered.push(code);
                }

                // Both directions: the taxonomy has no code this implementation cannot
                // produce, and this implementation produced no code outside it.
                expect(answered).toEqual([...AUTHORITY_SERVICE_REFUSALS]);
                expect(answered.every((code) => REFUSAL_CODES[code] === true)).toBe(true);
            }
        );

        test(
            "answers a reply the vocabulary declares for every operation the service declares",
            { tags: "p1" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first, other] = site.requests;

                const observed = {
                    issuePermit: (
                        await authorityServiceReply(() =>
                            new CapabilityAuthorityPermitIssuance(site.channel).issue(
                                first.bytes,
                                first.key
                            )
                        )
                    ).kind,
                    issuedPermit: (
                        await authorityServiceReply(() =>
                            new CapabilityAuthorityPermitRecords(site.channel).issued(
                                site.channel.issuer,
                                UNISSUED_NONCE,
                                Digest.sha256(first.bytes)
                            )
                        )
                    ).kind,
                    projectLeaseEvidence: (
                        await authorityServiceReply(() =>
                            new CapabilityTargetLeaseEvidenceProjection(site.channel).project(
                                other.bytes,
                                other.key
                            )
                        )
                    ).kind
                } satisfies Record<AuthorityServiceOperation, AuthorityServiceReplyKind>;

                expect(Object.keys(observed).sort()).toEqual([...AUTHORITY_SERVICE_OPERATIONS]);
                expect(observed.issuePermit).toBe("answered");
                expect(observed.issuedPermit).toBe("absent");
                expect(observed.projectLeaseEvidence).toBe("answered");
                expect(Object.values(observed).every((kind) => REPLY_KINDS[kind] === true)).toBe(
                    true
                );
            }
        );

        test(
            "reports a denial and a permit that was never issued as different replies",
            { tags: "p0" },
            async () => {
                using site = await implementation.site({ kind: "absent" });
                const [first] = site.requests;
                const records = new CapabilityAuthorityPermitRecords(site.channel);

                const denied = await authorityServiceReply(() =>
                    records.issued(UNREACHABLE_TENANT, first.key, Digest.sha256(first.bytes))
                );
                const missing = await authorityServiceReply(() =>
                    records.issued(site.channel.issuer, UNISSUED_NONCE, Digest.sha256(first.bytes))
                );

                // A capability reaches exactly one Tenant, so a lookup naming another one is
                // refused before anything crosses.
                expect(denied).toEqual({ kind: "refused", code: "authority.denied" });
                // And a permit that was never issued is a fact, not a failure. Collapsing
                // the two would hide a denial behind a transport error, or an absent record
                // behind an authority decision.
                expect(missing).toEqual({ kind: "absent" });
            }
        );

        test(
            "keeps one Tenant decision under one idempotency key while forwarding the redelivery",
            { tags: "p0" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first] = site.requests;
                const issuance = new CapabilityAuthorityPermitIssuance(site.channel);

                const initial = await authorityServiceReply(() =>
                    issuance.issue(first.bytes, first.key)
                );
                const decided = await site.decisions([first.key]);
                const redelivered = await authorityServiceReply(() =>
                    issuance.issue(first.bytes, first.key)
                );

                expect(initial.kind).toBe("answered");
                expect(redelivered).toEqual(initial);
                // One effect: the Tenant holds exactly one decision under that key, and the
                // redelivery did not move it. This is the claim the equal replies alone
                // cannot make, because a capability that cached its own answer would give
                // equal replies for an issuance the Tenant never recorded.
                expect(decided).toHaveLength(1);
                expect(await site.decisions([first.key])).toEqual(decided);
                // The redelivery still reached the Tenant. That is deliberate: the key is a
                // guard against rebinding and never a cache, because the Tenant's own record
                // is the single source of truth for whether the issuance already happened.
                expect(await site.carried()).toEqual([first.bytes, first.bytes]);
            }
        );

        test(
            "treats a different idempotency key with different bytes as a different call",
            { tags: "p1" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first, other] = site.requests;
                const issuance = new CapabilityAuthorityPermitIssuance(site.channel);

                await issuance.issue(first.bytes, first.key);
                const next = await authorityServiceReply(() =>
                    issuance.issue(other.bytes, other.key)
                );

                expect(next.kind).toBe("answered");
                expect(await site.carried()).toEqual([first.bytes, other.bytes]);
                // Two claims, two decisions the Tenant retains separately: redelivery
                // safety cannot come from collapsing distinct requests.
                const decisions = await site.decisions([first.key, other.key]);
                expect(decisions).toHaveLength(2);
                expect(decisions[0]).not.toBe(decisions[1]);
            }
        );

        test(
            "refuses a key rebound to different bytes without reaching the Tenant",
            { tags: "p1" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first, other] = site.requests;
                const issuance = new CapabilityAuthorityPermitIssuance(site.channel);
                await issuance.issue(first.bytes, first.key);

                const rebound = await authorityServiceReply(() =>
                    issuance.issue(other.bytes, first.key)
                );

                expect(rebound).toEqual({ kind: "refused", code: "authority.denied" });
                // The refusal happened before the Tenant: a rebinding attempt is not a
                // decision the Tenant should ever be asked to make.
                expect(await site.carried()).toEqual([first.bytes]);
            }
        );

        test(
            "refuses an over-length key and an over-limit payload before the Tenant sees either",
            { tags: "p1" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first] = site.requests;
                const issuance = new CapabilityAuthorityPermitIssuance(site.channel);

                const overLength = await authorityServiceReply(() =>
                    issuance.issue(first.bytes, "k".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH + 1))
                );
                const overLimit = await authorityServiceReply(() =>
                    issuance.issue(new Uint8Array(SQL_BLOB_LIMIT_BYTES + 1), first.key)
                );

                expect(overLength).toEqual({ kind: "refused", code: "operation.invalid-input" });
                expect(overLimit).toEqual({ kind: "refused", code: "operation.invalid-input" });
                expect(await site.carried()).toEqual([]);
                // Neither refusal consumed the key it named, so an attacker cannot spend a
                // legitimate holder's claim by sending something the guard refuses.
                const answered = await authorityServiceReply(() =>
                    issuance.issue(first.bytes, first.key)
                );
                expect(answered.kind).toBe("answered");
            }
        );

        test(
            `admits ${MAXIMUM_KEYED_CALLS} distinct idempotency keys and refuses the next`,
            { tags: "p0" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first] = site.requests;
                const issuance = new CapabilityAuthorityPermitIssuance(site.channel);

                for (let index = 0; index < MAXIMUM_KEYED_CALLS; index += 1) {
                    const reply = await authorityServiceReply(() =>
                        issuance.issue(first.bytes, `budget-${index}`)
                    );
                    expect(reply.kind).toBe("answered");
                }
                const refused = await authorityServiceReply(() =>
                    issuance.issue(first.bytes, `budget-${MAXIMUM_KEYED_CALLS}`)
                );

                // The bound is the constant the capability declares, never a literal: the
                // key is attacker-supplied and the guard that remembers it must not grow
                // without one.
                expect(refused).toEqual({ kind: "refused", code: "operation.invalid-input" });
                expect(await site.carried()).toHaveLength(MAXIMUM_KEYED_CALLS);
                // The ceiling bounds distinct keys and does not stop a retry, so exhausting
                // it cannot cost a holder the redelivery of a call it already made.
                const redelivered = await authorityServiceReply(() =>
                    issuance.issue(first.bytes, "budget-0")
                );
                expect(redelivered.kind).toBe("answered");
                expect(await site.carried()).toHaveLength(MAXIMUM_KEYED_CALLS + 1);
            }
        );

        test(
            "refuses a reply it cannot decode rather than handing it to core",
            { tags: "p1" },
            async () => {
                using site = await implementation.site({
                    kind: "refuses",
                    code: "operation.invalid-output"
                });
                const [first] = site.requests;

                const reply = await authorityServiceReply(() =>
                    new CapabilityAuthorityPermitIssuance(site.channel).issue(
                        first.bytes,
                        first.key
                    )
                );

                // Core refuses a substituted decision, and it can only do that on a reply
                // it can decode, so a reply that is not Tenant bytes is a broken transport
                // rather than a Tenant decision.
                expect(reply).toEqual({ kind: "refused", code: "operation.invalid-output" });
                // The request did reach the Tenant: what is refused here is the reply, and
                // reporting it as a request-side failure would misplace the fault.
                expect(await site.carried()).toEqual([first.bytes]);
            }
        );

        test(
            "answers an undeclared transport failure as indeterminate rather than as a refusal",
            { tags: "p1" },
            async () => {
                using site = await implementation.site({ kind: "faults" });
                const [first] = site.requests;

                const reply = await authorityServiceReply(() =>
                    new CapabilityAuthorityPermitIssuance(site.channel).issue(
                        first.bytes,
                        first.key
                    )
                );

                expect(reply.kind).toBe("indeterminate");
                if (reply.kind !== "indeterminate") return;
                // The cause travels whole. A refusal code invented here would be the
                // runtime claiming to know an answer the Tenant never gave.
                expect(reply.cause).toBeDefined();
                expect(isOperationalFailure(reply.cause)).toBe(false);
            }
        );

        test(
            "attributes every call to the caller the capability was minted for",
            { tags: "p0" },
            async () => {
                using site = await implementation.site({ kind: "answers" });
                const [first] = site.requests;

                await new CapabilityAuthorityPermitIssuance(site.channel).issue(
                    first.bytes,
                    first.key
                );

                // None of the three operations takes a caller, so the identity a request is
                // judged under is the one the Tenant fixed at mint time and is not
                // reachable from the holder at all.
                expect(await site.callers()).toEqual([site.boundCaller]);
            }
        );

        test("never releases a capability handle it did not create", { tags: "p0" }, async () => {
            using site = await implementation.site({ kind: "answers" });
            const [first, other] = site.requests;

            await new CapabilityAuthorityPermitIssuance(site.channel).issue(first.bytes, first.key);
            await new CapabilityAuthorityPermitRecords(site.channel).issued(
                site.channel.issuer,
                UNISSUED_NONCE,
                Digest.sha256(first.bytes)
            );
            await new CapabilityTargetLeaseEvidenceProjection(site.channel).project(
                other.bytes,
                other.key
            );

            // A full round of every operation, and the capability still answers. The
            // platform releases a stub received as an RPC parameter when the call
            // returns, so a transport that released one would be severing a handle its
            // minter still owns.
            const after = await authorityServiceReply(() =>
                new CapabilityAuthorityPermitIssuance(site.channel).issue(first.bytes, first.key)
            );
            expect(after.kind).toBe("answered");
        });
    });
}
