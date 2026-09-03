import { describe, expect, test } from "vitest";
import { Digest } from "../../../src/core";
import type { AgentCoreErrorCode } from "../../../src/errors";
import {
    EffectDispatch,
    EffectDispatchAttempt,
    WebBackend,
    WebPolicyError,
    type WebPolicyErrorCode,
    type WebRequest,
    type WebResponse,
    type WebTransport,
    type WebTransportLimits,
    type WebTransportRequest
} from "../../../src/facets";
import { EffectAttemptId } from "../../../src/invocations";

/**
 * The `web.egress` service contract from `packages/agent-core/artifacts/service-contracts.json`.
 *
 * The runtime's seam onto the public internet is `WebBackend` over a `WebTransport`: the
 * backend decides whether a request may leave and on what terms, the transport carries it
 * across the trust boundary, and the backend decides whether the reply may be admitted.
 * This module is the executable half of that contract, shaped the way the substrate
 * contracts are: a closed operation vocabulary, a closed reply vocabulary in which a
 * service failure is a value rather than a throw, and one parameterised body every
 * implementation answers.
 *
 * Two facts about this service the contract states rather than hides.
 *
 * First, there is no implementation of `WebTransport` anywhere in this repository's
 * `src/`, and no `src/` module constructs a `WebBackend` either: the protocol is declared
 * and unbound. Nor is the transport the only unbound port — of the five collaborators the
 * backend takes, only `WebRatePolicy` has an implementation (`FixedWindowRatePolicy`);
 * `WebUrlPolicy`, `WebCallerHeaderPolicy`, `WebCredentialPolicy` and `WebResponseCache`
 * are declared and type-exported and nothing implements them. So the SSRF and allowlist
 * decision P11-WEB-URL-SAFETY rests on is a decision no code in this repository makes
 * yet; what the facet enforces is that the decision was asked for, that its answer has
 * the right shape, and that it is asked again on every hop. This contract asserts exactly
 * that and no more.
 *
 * So the contract runs against reference implementations only, and it does not invent an
 * adapter to pretend otherwise. What would discharge the premise is a `WebTransport` in
 * `src/` — a `fetch`-backed one in the harness, a `fetch`-binding one in the Cloudflare
 * package — at which point this same body is run against it unchanged.
 *
 * Second, a refusal here is two-level. `WebPolicyError` extends `DetailedProfileError`, so
 * it carries an `AgentCoreErrorCode` that the kernel's closed error vocabulary already
 * had — `operation.invalid-input` — and a `WebPolicyErrorCode` detail code that says which
 * policy decided. All seven detail codes carry that same kernel code, so a caller reading
 * only the kernel level cannot tell an SSRF refusal from a stale cache key. The taxonomy
 * below states both levels for exactly that reason.
 *
 * `test/profiles/facets/web.test.ts` already owns the mediation and policy-unit cases for
 * this facet, along with fixtures named `createWebBackend`, `authorization`, `response`,
 * `DISPATCH` and `DedupWebTransport`. That file is not this writer's to edit, so the
 * scaffolding this contract needs is restated here rather than shared, and its cases stay
 * its own: nothing below re-runs a case that file already makes. Where this contract makes
 * a claim that file also makes, it makes it about the reply *value* the protocol produces,
 * which is the thing that file has no vocabulary for.
 */

/**
 * The closed operation vocabulary: exactly the three operations
 * `WEB_OPERATION_CONTRACTS` declares. `fetch` and `search` cross the trust boundary and
 * carry `externalSend` impact (SPEC P11-WEB-FETCH, P11-WEB-SEARCH); `readCached` reads
 * what a previous crossing left behind and carries `observe` (SPEC P11-WEB-CACHED).
 */
export const WEB_EGRESS_OPERATIONS = Object.freeze(["fetch", "search", "readCached"] as const);

export type WebEgressOperation = (typeof WEB_EGRESS_OPERATIONS)[number];

/**
 * The closed refusal vocabulary: every member of `WebPolicyErrorCode`. The service was
 * asked for something the policy chain will not do, and the answer is a refusal rather
 * than an outage.
 */
export const WEB_EGRESS_REFUSALS = Object.freeze([
    "url.denied",
    "credential.denied",
    "rate.exceeded",
    "size.exceeded",
    "redirect.denied",
    "search.invalid",
    "cache.invalid"
] as const);

export type WebEgressRefusalCode = (typeof WEB_EGRESS_REFUSALS)[number];

/**
 * The one kernel code all seven refusals carry (`WebPolicyError`'s constructor passes it
 * for every detail code). Named once here because it is the level a caller outside the
 * facet sees, and the level at which the seven refusals are indistinguishable.
 */
export const WEB_EGRESS_KERNEL_CODE: AgentCoreErrorCode = "operation.invalid-input";

/**
 * Where in the protocol a refusal can be decided. The distinction is not cosmetic: a
 * `before-send` refusal is a promise that nothing crossed the trust boundary, which is
 * what SPEC P11-WEB-URL-SAFETY, P11-WEB-CREDENTIAL-POLICY and P11-WEB-LIMIT-POLICY
 * actually claim, while an `after-send` refusal admits that bytes left and only the reply
 * was rejected.
 */
export const WEB_EGRESS_POSITIONS = Object.freeze(["before-send", "after-send"] as const);

export type WebEgressPosition = (typeof WEB_EGRESS_POSITIONS)[number];

export interface WebEgressRefusalFacts {
    /**
     * The sites in `src/facets/web/facet.ts` that raise this detail code, by symbol and
     * decision. More than one site per code is the norm rather than the exception, which
     * is the second reason the kernel code alone is not a diagnosis.
     */
    readonly sites: readonly string[];
    /** The kernel code the refusal carries out of the facet. */
    readonly kernelCode: AgentCoreErrorCode;
    /**
     * Every position in which the contract can provoke this code. `WebBackend.fetch` runs
     * its whole policy chain again on each redirect hop, so four of the seven can be
     * decided after a request has already left.
     */
    readonly positions: readonly WebEgressPosition[];
}

/**
 * The taxonomy: every failure this service can answer with, mapped to its stable codes and
 * its sites. Keyed by `WebPolicyErrorCode` rather than by this module's own tuple, so a
 * detail code added to or removed from the facet breaks compilation here instead of
 * quietly escaping the vocabulary.
 */
export const WEB_EGRESS_TAXONOMY: Readonly<Record<WebPolicyErrorCode, WebEgressRefusalFacts>> =
    Object.freeze({
        "url.denied": Object.freeze({
            sites: Object.freeze([
                "WebBackend.safeUrl: the URL does not parse",
                "WebBackend.safeUrl: the scheme is neither http: nor https:, or the URL carries an embedded username or password",
                "WebBackend.authorizeTarget: WebUrlPolicy.authorize refused the target",
                "WebBackend.authorizeTarget: the authorization does not match the target, names no resolved target, or carries a non-object token",
                "WebBackend.fetch: the hop's Location resolves to a URL safeUrl refuses"
            ]),
            kernelCode: WEB_EGRESS_KERNEL_CODE,
            positions: WEB_EGRESS_POSITIONS
        }),
        "credential.denied": Object.freeze({
            sites: Object.freeze([
                "WebBackend.fetch: the caller's own headers include a credential header, which only WebCredentialPolicy may attach"
            ]),
            kernelCode: WEB_EGRESS_KERNEL_CODE,
            // The caller's headers are fixed for the whole call, so a chain that reached a
            // second hop already passed this gate on the first.
            positions: Object.freeze(["before-send"] as const)
        }),
        "rate.exceeded": Object.freeze({
            sites: Object.freeze([
                "WebBackend.fetch: WebRatePolicy.consume refused this hop's origin"
            ]),
            kernelCode: WEB_EGRESS_KERNEL_CODE,
            positions: WEB_EGRESS_POSITIONS
        }),
        "size.exceeded": Object.freeze({
            sites: Object.freeze([
                "WebBackend.fetch: the request body is longer than WebFacetConfig.maxRequestBytes",
                "WebBackend.fetch: the transport's reply is longer than WebFacetConfig.maxResponseBytes"
            ]),
            kernelCode: WEB_EGRESS_KERNEL_CODE,
            positions: WEB_EGRESS_POSITIONS
        }),
        "redirect.denied": Object.freeze({
            sites: Object.freeze([
                "WebBackend.fetch: the reply redirects and the hop count has reached WebFacetConfig.maxRedirects"
            ]),
            kernelCode: WEB_EGRESS_KERNEL_CODE,
            // A redirect cannot be refused before one has arrived, so this code has no
            // before-send position at all.
            positions: Object.freeze(["after-send"] as const)
        }),
        "search.invalid": Object.freeze({
            sites: Object.freeze([
                "WebBackend.search: the query is blank",
                "WebBackend.search: the limit is not a positive safe integer"
            ]),
            kernelCode: WEB_EGRESS_KERNEL_CODE,
            positions: Object.freeze(["before-send"] as const)
        }),
        "cache.invalid": Object.freeze({
            sites: Object.freeze([
                "WebBackend.readCached: the key is empty or not its own trimmed form"
            ]),
            kernelCode: WEB_EGRESS_KERNEL_CODE,
            // `readCached` has no transport at all, so nothing can have left.
            positions: Object.freeze(["before-send"] as const)
        })
    });

/**
 * The closed reply vocabulary. Four kinds, and the two the exemplar would call optional
 * are the ones that keep this honest.
 *
 * `unsent` is a refusal that came with a promise: no byte of this call crossed the
 * boundary. Collapsing it into `refused` would throw away the only part of
 * P11-WEB-URL-SAFETY that matters — an SSRF target that was refused *after* the request
 * left is not a defence.
 *
 * `indeterminate` is not a refusal at all. An undeclared throw means the runtime does not
 * know whether the request happened, which is a different claim from "the service refused
 * it", and the retry-safety case below is exactly the position where the difference is the
 * whole point: the same call that answers `indeterminate` answers `answered` on retry
 * without a second delivery.
 */
export type WebEgressReply =
    | { readonly kind: "answered"; readonly response: WebResponse | undefined }
    | {
          readonly kind: "unsent";
          readonly code: WebEgressRefusalCode;
          readonly kernelCode: AgentCoreErrorCode;
      }
    | {
          readonly kind: "refused";
          readonly code: WebEgressRefusalCode;
          readonly kernelCode: AgentCoreErrorCode;
      }
    | { readonly kind: "indeterminate"; readonly cause: unknown };

/**
 * Membership over the closed literal set, as a self-map: the lookup both tests membership
 * and produces the literal-typed code, so a detail code the vocabulary does not carry
 * cannot be classified and no type assertion is needed to classify one that is. A record
 * rather than a Set because the table is static and string-keyed, the way
 * `provider-capability.ts#DISCLOSED_CODES` states its disclosed set.
 */
const REFUSAL_CODES: Readonly<Record<string, WebEgressRefusalCode>> = Object.freeze(
    Object.fromEntries(
        WEB_EGRESS_REFUSALS.map((code): readonly [string, WebEgressRefusalCode] => [code, code])
    )
);

/**
 * The bounds this contract holds its services to. Named because each one is a decision
 * site: the backend compares a body, a reply and a hop count against them, and a bare
 * literal at the call site would leave the assertions describing a number rather than a
 * bound.
 */
export const WEB_EGRESS_BOUNDS = Object.freeze({
    /** Bytes a request body may carry. */
    maxRequestBytes: 4,
    /** Bytes a reply may carry. */
    maxResponseBytes: 4,
    /** Redirect hops the loop follows before refusing. */
    maxRedirects: 1,
    /** Rate permits a service starts with, unless the scenario withholds them. */
    ratePermits: 4,
    /** Permits enough for the first hop only. */
    oneHopPermits: 1,
    /** No permits at all. */
    noPermits: 0
});

/**
 * The wire vocabulary a transport implementing this contract has to speak. It names
 * conditions, never taxonomy codes: what the reply means is the backend's decision, and a
 * transport that classified its own refusals would be measuring the contract instead of
 * answering it.
 */
export const WEB_EGRESS_WIRE = Object.freeze({
    /** The status a reference answers with. */
    status: 200,
    /** A redirect target inside this contract's allowlist. */
    redirect: "https://second.test/final",
    /** A redirect target `WebBackend.safeUrl` refuses on the next hop. */
    refusedRedirect: "ftp://allowed.test/next"
});

/** The hosts this contract's URL policy authorizes. Anything else is off the allowlist. */
const ALLOWED_HOSTS: Readonly<Record<string, true>> = Object.freeze({
    "allowed.test": true,
    "second.test": true
});

/**
 * The header names only `WebCredentialPolicy` may set. Restated from the module-private
 * `CREDENTIAL_HEADERS` in `src/facets/web/facet.ts`, which is neither exported nor
 * reachable from a test; a contract cannot assert over a table it cannot see, so this
 * list is the contract's own copy and drifts if that one changes.
 */
const CREDENTIAL_HEADER_NAMES = Object.freeze([
    "authorization",
    "cookie",
    "proxy-authorization"
] as const);

const CONTRACT_TARGET = "https://allowed.test/page";
const REFUSED_SCHEME_TARGET = "ftp://allowed.test/page";
const USER_CREDENTIAL_TARGET = "https://user@allowed.test/page";
const PASSWORD_CREDENTIAL_TARGET = "https://:secret@allowed.test/page";
const BLOCKED_TARGET = "https://blocked.test/page";
const CONTRACT_SEARCH_ENDPOINT = "https://allowed.test/search";
const CONTRACT_QUERY = "two words";
const BLANK_QUERY = " ";
const CONTRACT_CACHE_KEY = "contract-cached";
const UNCACHED_KEY = "contract-uncached";
const NONCANONICAL_CACHE_KEY = " contract-cached";
const CALLER_SECRET = "caller-secret";
/** One byte past the request bound, so the refusal is the bound's and not the encoding's. */
const OVERSIZED_BODY = new Uint8Array(WEB_EGRESS_BOUNDS.maxRequestBytes + 1);
const CACHED_RESPONSE: WebResponse = Object.freeze({
    url: "https://allowed.test/cached",
    status: WEB_EGRESS_WIRE.status,
    headers: Object.freeze({ "x-cached": "1" }),
    body: new Uint8Array([7])
});
/** The fields a `WebResponse` carries, which is the whole reply grammar. */
const RESPONSE_FIELDS = Object.freeze(["body", "headers", "status", "url"] as const);

/**
 * One canonical effect identity, reused deliberately: the retry-safety case depends on two
 * calls carrying the identical dispatch, which is what a crash-after-send retry does.
 */
export const WEB_EGRESS_DISPATCH = new EffectDispatch(
    "web-egress-contract-key",
    new EffectDispatchAttempt(
        new EffectAttemptId("web-egress-contract-attempt"),
        0,
        Digest.sha256(new TextEncoder().encode("web-egress-contract"))
    )
);

/**
 * A second identity, differing in both the dedup key and the attempt, so that either
 * provider mechanism reads it as a new effect rather than a retry of the first.
 */
export const WEB_EGRESS_SECOND_DISPATCH = new EffectDispatch(
    "web-egress-contract-key-second",
    new EffectDispatchAttempt(
        new EffectAttemptId("web-egress-contract-attempt-second"),
        1,
        Digest.sha256(new TextEncoder().encode("web-egress-contract-second"))
    )
);

/**
 * What an implementation must be able to be put into. One member per reply the vocabulary
 * declares, plus the two positions the protocol genuinely distinguishes, so a suite
 * iterating the taxonomy cannot skip a case: an implementation that cannot be put in one
 * of these positions fails to compile.
 */
export type WebEgressScenario =
    | { readonly kind: "answers" }
    | { readonly kind: "answers-after-redirect" }
    | {
          readonly kind: "refuses";
          readonly code: WebEgressRefusalCode;
          readonly position: WebEgressPosition;
      }
    | { readonly kind: "crashes-after-send" }
    | { readonly kind: "faults" };

/**
 * One call, as the seam takes it. `readCached` carries no `EffectDispatch` because it
 * carries no effect: an operation that never crosses the boundary has no identity a
 * provider could dedup on, and the protocol says so by not offering one.
 */
export type WebEgressCall =
    | {
          readonly operation: "fetch";
          readonly dispatch: EffectDispatch;
          readonly request: WebRequest;
      }
    | {
          readonly operation: "search";
          readonly dispatch: EffectDispatch;
          readonly query: string;
          readonly limit?: number;
      }
    | { readonly operation: "readCached"; readonly key: string };

/**
 * The provider transport under contract, plus what an observer standing at the trust
 * boundary can count. Every field here is something the runtime is entitled to know:
 * whether bytes left, under what identity, and what bound the provider was told.
 */
export interface WebEgressTransport extends WebTransport {
    /** Every request handed across the boundary, in order. */
    readonly requests: readonly WebTransportRequest[];
    /** Every effect identity handed across the boundary, in order. */
    readonly dispatches: readonly EffectDispatch[];
    /** Every response bound the boundary was told to respect, in order. */
    readonly limits: readonly WebTransportLimits[];
    /** Requests actually delivered. A reconciled retry is not a delivery. */
    readonly deliveries: number;
}

/** One implementation of the protocol, as the contract reaches it. */
export interface WebEgressImplementation {
    /** The transport, in the position the scenario names. */
    transport(scenario: WebEgressScenario): WebEgressTransport;
}

/**
 * The service as this contract assembles it: the backend under contract, the transport it
 * speaks to, and the three policy ledgers that make "before the request leaves" an
 * observable claim rather than a hope.
 */
export interface WebEgressService {
    readonly backend: WebBackend;
    readonly transport: WebEgressTransport;
    /** Origins the rate policy was asked about, in order. */
    readonly consumed: readonly string[];
    /** Targets the URL policy was asked to authorize, in order. */
    readonly authorized: readonly string[];
    /** Targets the credential policy was asked to supply headers for, in order. */
    readonly credentialed: readonly string[];
}

/**
 * One call, one reply value. This is the whole correspondence between what the backend
 * throws and what the contract says the service answered, and it is the only place in
 * these files that inspects a thrown value.
 *
 * The three operations are invoked inside the same `try` on purpose: `WebBackend.search`
 * declares `Promise<WebResponse>` but raises `search.invalid` synchronously, and
 * `readCached` is synchronous throughout, so a correspondence that attached `.catch` to a
 * returned promise would miss two of the seven refusals entirely.
 */
export async function webEgressReply(
    service: WebEgressService,
    call: WebEgressCall
): Promise<WebEgressReply> {
    const crossedBefore = service.transport.requests.length;
    try {
        const response =
            call.operation === "fetch"
                ? await service.backend.fetch(call.request, call.dispatch)
                : call.operation === "search"
                  ? await service.backend.search(call.query, call.limit, call.dispatch)
                  : service.backend.readCached(call.key);
        return { kind: "answered", response };
    } catch (cause) {
        const crossed = service.transport.requests.length > crossedBefore;
        if (cause instanceof WebPolicyError) {
            const code = REFUSAL_CODES[cause.detailCode];
            if (code !== undefined) {
                return crossed
                    ? { kind: "refused", code, kernelCode: cause.code }
                    : { kind: "unsent", code, kernelCode: cause.code };
            }
        }
        // Undeclared. The contract's position is that the runtime does not know what
        // happened, which is a different claim from "the service refused".
        return { kind: "indeterminate", cause };
    }
}

/**
 * The service, assembled over one implementation's transport. This restates
 * `web.test.ts`'s `createWebBackend` and `authorization` fixtures because that file is not
 * this writer's to edit; the difference is the three ledgers, which are what let the
 * before-the-request-leaves claims be asserted rather than assumed.
 */
function serviceOver(
    implementation: WebEgressImplementation,
    scenario: WebEgressScenario,
    permits: number
): WebEgressService {
    const transport = implementation.transport(scenario);
    const consumed: string[] = [];
    const authorized: string[] = [];
    const credentialed: string[] = [];
    let remaining = permits;
    const backend = new WebBackend(
        {
            maxRequestBytes: WEB_EGRESS_BOUNDS.maxRequestBytes,
            maxResponseBytes: WEB_EGRESS_BOUNDS.maxResponseBytes,
            maxRedirects: WEB_EGRESS_BOUNDS.maxRedirects,
            searchEndpoint: CONTRACT_SEARCH_ENDPOINT
        },
        {
            authorize: (url) => {
                authorized.push(url.href);
                if (ALLOWED_HOSTS[url.hostname] !== true) {
                    throw new WebPolicyError(
                        "url.denied",
                        "Host is outside the contract allowlist"
                    );
                }
                return Object.freeze({
                    requestedUrl: url.href,
                    resolvedTarget: `resolved:${url.hostname}`,
                    token: Object.freeze({ target: url.hostname })
                });
            }
        },
        { headersFor: (_url, requested) => requested },
        {
            headersFor: (url) => {
                credentialed.push(url.href);
                return Object.freeze({ authorization: `policy-${url.hostname}` });
            }
        },
        {
            consume: (origin) => {
                consumed.push(origin);
                remaining -= 1;
                return remaining >= 0;
            }
        },
        transport,
        { read: (key) => (key === CONTRACT_CACHE_KEY ? CACHED_RESPONSE : undefined) }
    );
    return { backend, transport, consumed, authorized, credentialed };
}

interface WebEgressProvocation {
    readonly service: WebEgressService;
    readonly call: WebEgressCall;
}

/**
 * The service and the call that together put the protocol in one position. The policy
 * configuration lives here rather than in the implementation because it belongs to the
 * backend, which is the same for every implementation: what varies between
 * implementations is the transport, which is where this protocol's provider obligations
 * are.
 */
function provoke(
    implementation: WebEgressImplementation,
    scenario: WebEgressScenario
): WebEgressProvocation {
    const fetchTarget: WebEgressCall = {
        operation: "fetch",
        dispatch: WEB_EGRESS_DISPATCH,
        request: { url: CONTRACT_TARGET }
    };
    if (scenario.kind !== "refuses") {
        return {
            service: serviceOver(implementation, scenario, WEB_EGRESS_BOUNDS.ratePermits),
            call: fetchTarget
        };
    }
    if (scenario.code === "credential.denied") {
        return {
            service: serviceOver(implementation, scenario, WEB_EGRESS_BOUNDS.ratePermits),
            call: {
                operation: "fetch",
                dispatch: WEB_EGRESS_DISPATCH,
                request: { url: CONTRACT_TARGET, headers: { Authorization: CALLER_SECRET } }
            }
        };
    }
    if (scenario.code === "search.invalid") {
        return {
            service: serviceOver(implementation, scenario, WEB_EGRESS_BOUNDS.ratePermits),
            call: { operation: "search", dispatch: WEB_EGRESS_DISPATCH, query: BLANK_QUERY }
        };
    }
    if (scenario.code === "cache.invalid") {
        return {
            service: serviceOver(implementation, scenario, WEB_EGRESS_BOUNDS.ratePermits),
            call: { operation: "readCached", key: NONCANONICAL_CACHE_KEY }
        };
    }
    if (scenario.code === "rate.exceeded") {
        // Before the send: no permits at all. After it: enough for the first hop, so the
        // second hop of a redirect is what the policy refuses.
        const permits =
            scenario.position === "before-send"
                ? WEB_EGRESS_BOUNDS.noPermits
                : WEB_EGRESS_BOUNDS.oneHopPermits;
        return { service: serviceOver(implementation, scenario, permits), call: fetchTarget };
    }
    if (scenario.code === "size.exceeded" && scenario.position === "before-send") {
        return {
            service: serviceOver(implementation, scenario, WEB_EGRESS_BOUNDS.ratePermits),
            call: {
                operation: "fetch",
                dispatch: WEB_EGRESS_DISPATCH,
                request: { url: CONTRACT_TARGET, body: OVERSIZED_BODY }
            }
        };
    }
    if (scenario.code === "url.denied" && scenario.position === "before-send") {
        return {
            service: serviceOver(implementation, scenario, WEB_EGRESS_BOUNDS.ratePermits),
            call: {
                operation: "fetch",
                dispatch: WEB_EGRESS_DISPATCH,
                request: { url: REFUSED_SCHEME_TARGET }
            }
        };
    }
    // The rest are decided by what the transport answers: an oversized reply, a redirect
    // to a scheme the next hop refuses, or a redirect that outlasts the hop bound.
    return {
        service: serviceOver(implementation, scenario, WEB_EGRESS_BOUNDS.ratePermits),
        call: fetchTarget
    };
}

export function webEgressContract(name: string, implementation: WebEgressImplementation): void {
    describe(`${name} web egress service contract`, () => {
        test("answers a fetch as one whole response the caller owns", { tags: "p1" }, async () => {
            const { service, call } = provoke(implementation, { kind: "answers" });
            const reply = await webEgressReply(service, call);

            expect(reply.kind).toBe("answered");
            if (reply.kind !== "answered") return;
            expect(reply.response?.status).toBe(WEB_EGRESS_WIRE.status);
            expect(reply.response?.url).toBe(CONTRACT_TARGET);
            expect(service.transport.requests).toHaveLength(1);
            // The provider is told the bound it will be held to, rather than being
            // left to discover it from a refusal.
            expect(service.transport.limits).toEqual([
                { maxResponseBytes: WEB_EGRESS_BOUNDS.maxResponseBytes }
            ]);
        });

        test(
            "answers every refusal the taxonomy declares in every position it declares, and answers none outside it",
            { tags: "p0" },
            async () => {
                const answered: string[] = [];
                const positions: string[] = [];
                // Derived from the taxonomy rather than written out, so a row that loses
                // a position loses its case along with it.
                const declared: string[] = [];
                for (const code of WEB_EGRESS_REFUSALS) {
                    for (const position of WEB_EGRESS_TAXONOMY[code].positions) {
                        declared.push(`${code}@${position}`);
                    }
                }
                for (const code of WEB_EGRESS_REFUSALS) {
                    const facts = WEB_EGRESS_TAXONOMY[code];
                    for (const position of facts.positions) {
                        const { service, call } = provoke(implementation, {
                            kind: "refuses",
                            code,
                            position
                        });
                        const reply = await webEgressReply(service, call);

                        // A before-send refusal is a promise that nothing crossed; an
                        // after-send refusal admits that something did. The reply kind is
                        // where that promise is either kept or broken.
                        expect(reply).toEqual({
                            kind: position === "before-send" ? "unsent" : "refused",
                            code,
                            kernelCode: facts.kernelCode
                        });
                        expect(service.transport.requests.length === 0).toBe(
                            position === "before-send"
                        );
                        if (reply.kind === "unsent" || reply.kind === "refused") {
                            answered.push(reply.code);
                            positions.push(`${reply.code}@${position}`);
                        }
                    }
                }

                // Both directions over all seven members. Every code the taxonomy
                // declares was produced, in every position it declares; and nothing
                // produced fell outside the vocabulary -- that second direction is what
                // `REFUSAL_CODES` decides, so a detail code the vocabulary does not
                // carry would have arrived as `indeterminate` and failed the equality
                // above.
                expect(positions).toEqual(declared);
                expect(WEB_EGRESS_REFUSALS.every((code) => answered.includes(code))).toBe(true);
                expect(answered.every((code) => REFUSAL_CODES[code] !== undefined)).toBe(true);
                expect(Object.keys(WEB_EGRESS_TAXONOMY).sort()).toEqual(
                    [...WEB_EGRESS_REFUSALS].sort()
                );
                // Seven codes, eleven materially different refusals, one kernel code: a
                // caller reading only the kernel level learns that its input was invalid
                // and nothing else.
                expect(
                    WEB_EGRESS_REFUSALS.every(
                        (code) => WEB_EGRESS_TAXONOMY[code].kernelCode === WEB_EGRESS_KERNEL_CODE
                    )
                ).toBe(true);
            }
        );

        test(
            "refuses an unsafe or unauthorized target with the transport never reached",
            { tags: "p0" },
            async () => {
                // SPEC P11-WEB-URL-SAFETY, as a reply value: a scheme that is not
                // http(s), a URL carrying either embedded credential field, and a host
                // the URL policy refuses. Each has to be `unsent`, because a target
                // refused after the request left is not a defence against SSRF.
                for (const url of [
                    REFUSED_SCHEME_TARGET,
                    USER_CREDENTIAL_TARGET,
                    PASSWORD_CREDENTIAL_TARGET,
                    BLOCKED_TARGET
                ]) {
                    const { service } = provoke(implementation, { kind: "answers" });
                    const reply = await webEgressReply(service, {
                        operation: "fetch",
                        dispatch: WEB_EGRESS_DISPATCH,
                        request: { url }
                    });

                    expect(reply).toEqual({
                        kind: "unsent",
                        code: "url.denied",
                        kernelCode: WEB_EGRESS_KERNEL_CODE
                    });
                    expect(service.transport.requests).toEqual([]);
                    expect(service.transport.deliveries).toBe(0);
                }
            }
        );

        test(
            "refuses every caller-supplied credential header at every casing without attaching it",
            { tags: "p0" },
            async () => {
                for (const name of CREDENTIAL_HEADER_NAMES) {
                    // Header names are case-insensitive on the wire, so a gate that
                    // folded with the host locale would let a Turkish deployment read
                    // "AUTHORIZATION" as a header it has never heard of.
                    for (const sent of [name, name.toUpperCase()]) {
                        const { service } = provoke(implementation, { kind: "answers" });
                        const reply = await webEgressReply(service, {
                            operation: "fetch",
                            dispatch: WEB_EGRESS_DISPATCH,
                            request: { url: CONTRACT_TARGET, headers: { [sent]: CALLER_SECRET } }
                        });

                        expect(reply).toEqual({
                            kind: "unsent",
                            code: "credential.denied",
                            kernelCode: WEB_EGRESS_KERNEL_CODE
                        });
                        expect(service.transport.requests).toEqual([]);
                    }
                }
            }
        );

        test(
            "attaches a policy credential only to the target each hop was authorized for",
            { tags: "p0" },
            async () => {
                const { service, call } = provoke(implementation, {
                    kind: "answers-after-redirect"
                });
                const reply = await webEgressReply(service, call);

                expect(reply.kind).toBe("answered");
                if (reply.kind !== "answered") return;
                // The answer names the target that answered, not the one first asked for.
                expect(reply.response?.url).toBe(WEB_EGRESS_WIRE.redirect);
                // SPEC P11-WEB-URL-SAFETY on every hop: the second target went through
                // the same authorization the first did, rather than inheriting it.
                expect(service.authorized).toEqual([CONTRACT_TARGET, WEB_EGRESS_WIRE.redirect]);
                expect(service.credentialed).toEqual([CONTRACT_TARGET, WEB_EGRESS_WIRE.redirect]);
                // SPEC P11-WEB-CREDENTIAL-ATTACHMENT: each hop carries the credential its
                // own target was authorized for, and the first hop's credential does not
                // follow the redirect to the second host.
                expect(
                    service.transport.requests.map((request) => request.headers["authorization"])
                ).toEqual(["policy-allowed.test", "policy-second.test"]);
                // One canonical effect identity across the whole chain, which is what
                // makes the retry-safety case below meaningful.
                expect(service.transport.dispatches).toEqual([
                    WEB_EGRESS_DISPATCH,
                    WEB_EGRESS_DISPATCH
                ]);
            }
        );

        test(
            "consumes a rate permit for the hop's origin before the request leaves",
            { tags: "p0" },
            async () => {
                const { service, call } = provoke(implementation, {
                    kind: "refuses",
                    code: "rate.exceeded",
                    position: "before-send"
                });
                const reply = await webEgressReply(service, call);

                expect(reply).toEqual({
                    kind: "unsent",
                    code: "rate.exceeded",
                    kernelCode: WEB_EGRESS_KERNEL_CODE
                });
                // The order is the claim: the policy was asked, and the answer decided
                // the request rather than annotating it after the fact.
                expect(service.consumed).toEqual([new URL(CONTRACT_TARGET).origin]);
                expect(service.transport.requests).toEqual([]);
            }
        );

        test(
            "refuses an oversized request and an oversized reply rather than truncating either",
            { tags: "p1" },
            async () => {
                const request = provoke(implementation, {
                    kind: "refuses",
                    code: "size.exceeded",
                    position: "before-send"
                });
                const requestReply = await webEgressReply(request.service, request.call);

                expect(requestReply).toEqual({
                    kind: "unsent",
                    code: "size.exceeded",
                    kernelCode: WEB_EGRESS_KERNEL_CODE
                });
                expect(request.service.transport.requests).toEqual([]);

                const reply = provoke(implementation, {
                    kind: "refuses",
                    code: "size.exceeded",
                    position: "after-send"
                });
                const replyReply = await webEgressReply(reply.service, reply.call);

                // The reply was too long and the answer is a refusal, not a prefix: there
                // is no reply kind in this vocabulary that carries partial bytes, so the
                // protocol cannot express a truncation even if a provider wanted one.
                expect(replyReply).toEqual({
                    kind: "refused",
                    code: "size.exceeded",
                    kernelCode: WEB_EGRESS_KERNEL_CODE
                });
                expect(reply.service.transport.limits).toEqual([
                    { maxResponseBytes: WEB_EGRESS_BOUNDS.maxResponseBytes }
                ]);
            }
        );

        test(
            "answers a crash-after-send retry rather than re-delivering it or staying indeterminate",
            { tags: "p0" },
            async () => {
                const { service, call } = provoke(implementation, {
                    kind: "crashes-after-send"
                });

                const lost = await webEgressReply(service, call);

                // Bytes left and the outcome did not come back. This is the reply kind
                // that must not be dressed up as a refusal: the service did not refuse,
                // the runtime simply does not know.
                expect(lost.kind).toBe("indeterminate");
                expect(service.transport.requests).toHaveLength(1);
                expect(service.transport.deliveries).toBe(1);

                const retried = await webEgressReply(service, call);

                // The invariant `WebTransport.send`'s own docstring states (SPEC 7.4): the
                // retry carries the same identity, the provider recognises it, and the
                // effect neither happens twice nor stays unknown.
                expect(retried.kind).toBe("answered");
                expect(service.transport.deliveries).toBe(1);
                expect(service.transport.requests).toHaveLength(2);
                expect(
                    service.transport.dispatches.map((dispatch) => dispatch.idempotencyKey)
                ).toEqual([WEB_EGRESS_DISPATCH.idempotencyKey, WEB_EGRESS_DISPATCH.idempotencyKey]);
                expect(
                    service.transport.dispatches.every(
                        (dispatch) =>
                            dispatch.attempt?.id.equals(WEB_EGRESS_DISPATCH.attempt!.id) === true &&
                            dispatch.attempt?.ordinal === WEB_EGRESS_DISPATCH.attempt!.ordinal
                    )
                ).toBe(true);

                // The other direction, without which "dedups" would be indistinguishable
                // from "answers everything from a cache": a different effect identity is a
                // different effect, and it is delivered.
                const fresh = await webEgressReply(service, {
                    operation: "fetch",
                    dispatch: WEB_EGRESS_SECOND_DISPATCH,
                    request: { url: CONTRACT_TARGET }
                });

                expect(fresh.kind).toBe("indeterminate");
                expect(service.transport.deliveries).toBe(2);
            }
        );

        test(
            "answers an undeclared transport failure as indeterminate rather than as a refusal",
            { tags: "p1" },
            async () => {
                const { service, call } = provoke(implementation, { kind: "faults" });
                const reply = await webEgressReply(service, call);

                expect(reply.kind).toBe("indeterminate");
                if (reply.kind !== "indeterminate") return;
                // The cause travels whole. A refusal code invented here would be the
                // runtime claiming an answer the service never gave.
                expect(reply.cause).toBeInstanceOf(TypeError);
                expect(service.transport.requests).toHaveLength(1);
            }
        );

        test(
            "answers with one whole byte array, because the protocol has no streamed reply",
            { tags: "p1" },
            async () => {
                const { service, call } = provoke(implementation, { kind: "answers" });
                const reply = await webEgressReply(service, call);

                expect(reply.kind).toBe("answered");
                if (reply.kind !== "answered" || reply.response === undefined) return;
                // `WebTransportResponse.body` is a `Uint8Array` and `send` resolves once,
                // so there is no frame grammar to get wrong: no chunk, no trailer, no
                // continuation. A provider with a streaming source has to buffer it whole
                // before it can answer at all, which is why the response bound is a
                // refusal rather than a backpressure signal.
                expect(reply.response.body).toBeInstanceOf(Uint8Array);
                expect(Symbol.asyncIterator in reply.response.body).toBe(false);
                expect(Object.keys(reply.response).sort()).toEqual([...RESPONSE_FIELDS]);
                expect(service.transport.requests).toHaveLength(1);
            }
        );

        test(
            "carries a search through the same egress path as a fetch, query and limit included",
            { tags: "p1" },
            async () => {
                const { service } = provoke(implementation, { kind: "answers" });
                const reply = await webEgressReply(service, {
                    operation: "search",
                    dispatch: WEB_EGRESS_DISPATCH,
                    query: CONTRACT_QUERY
                });

                expect(reply.kind).toBe("answered");
                // SPEC P11-WEB-SEARCH: search is not a second protocol. It is one fetch of
                // the configured endpoint, so every URL, credential, rate and size rule
                // above applies to it unchanged -- and the query it sends is visible in
                // the authorized target rather than hidden in a body.
                const [authorized] = service.authorized;
                expect(authorized).toBeDefined();
                if (authorized === undefined) return;
                const requested = new URL(authorized);
                expect(requested.origin).toBe(new URL(CONTRACT_SEARCH_ENDPOINT).origin);
                expect(requested.searchParams.get("q")).toBe(CONTRACT_QUERY);
                // The limit always travels, defaulted by the backend when the caller
                // omits it, so a provider never has to guess how much to return.
                expect(requested.searchParams.get("limit")).not.toBeNull();
                expect(service.transport.requests).toHaveLength(1);
            }
        );

        test("answers a cache miss rather than refusing one", { tags: "p2" }, async () => {
            const { service } = provoke(implementation, { kind: "answers" });
            const hit = await webEgressReply(service, {
                operation: "readCached",
                key: CONTRACT_CACHE_KEY
            });
            const miss = await webEgressReply(service, {
                operation: "readCached",
                key: UNCACHED_KEY
            });

            expect(hit).toEqual({ kind: "answered", response: CACHED_RESPONSE });
            // An absent entry is an answer, not a refusal: the only refusal `readCached`
            // has is about the key's shape.
            expect(miss).toEqual({ kind: "answered", response: undefined });
            // SPEC P11-WEB-CACHED: an `observe` operation reaches no transport at all,
            // which is why it carries no effect identity.
            expect(service.transport.requests).toEqual([]);
        });
    });
}
