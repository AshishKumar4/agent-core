import { describe, expect, test } from "vitest";
import {
    EffectDispatch,
    WEB_OPERATION_CONTRACTS,
    WEB_OPERATIONS,
    WebBackend,
    WebPolicyError,
    type WebTransportLimits,
    type WebTransportRequest,
    type WebTransportResponse
} from "../../../src/facets";
import {
    WEB_EGRESS_BOUNDS,
    WEB_EGRESS_DISPATCH,
    WEB_EGRESS_OPERATIONS,
    WEB_EGRESS_REFUSALS,
    WEB_EGRESS_TAXONOMY,
    WEB_EGRESS_WIRE,
    webEgressContract,
    webEgressReply,
    type WebEgressImplementation,
    type WebEgressScenario,
    type WebEgressTransport
} from "./web-egress-contract.js";

/**
 * The `web.egress` contract, run against the only implementations this repository has.
 *
 * There is no adapter to run it against. `WebTransport` has no implementation anywhere in
 * `src/`, in this package or any other, and no `src/` module constructs a `WebBackend`
 * either: every construction site is a test fixture. So the two runs below are both
 * references, and they are not two copies of one thing — they discharge the two distinct
 * obligations `WebTransport.send`'s docstring places on a provider. One dedups on
 * `dispatch.idempotencyKey`; the other answers a reconciliation query addressed by
 * `dispatch.attempt` identity. A provider honouring either one satisfies the same
 * contract, which is the claim the two runs make.
 *
 * The reference is the control: it is what this protocol looks like when the provider is
 * perfect, so a case failing here is a fact about the contract rather than about a
 * transport.
 */

/**
 * A conforming provider transport. It speaks wire conditions — a status, a redirect, an
 * oversized reply, a crash — and never a taxonomy code, because which policy refuses is
 * the backend's decision and a transport that pre-classified it would be marking its own
 * homework.
 *
 * Its dedup ledger is keyed by whatever `effectIdentity` returns, which is the axis the
 * two contract members differ on and the axis the finding below sits on.
 */
class ReferenceWebTransport implements WebEgressTransport {
    public readonly requests: WebTransportRequest[] = [];
    public readonly dispatches: EffectDispatch[] = [];
    public readonly limits: WebTransportLimits[] = [];
    public deliveries = 0;
    readonly #settled = new Map<string, WebTransportResponse>();

    public constructor(
        private readonly scenario: WebEgressScenario,
        private readonly effectIdentity: (
            dispatch: EffectDispatch,
            request: WebTransportRequest
        ) => string
    ) {}

    public async send(
        request: WebTransportRequest,
        limits: WebTransportLimits,
        dispatch: EffectDispatch
    ): Promise<WebTransportResponse> {
        this.requests.push(request);
        this.dispatches.push(dispatch);
        this.limits.push(limits);

        const effect = this.effectIdentity(dispatch, request);
        const settled = this.#settled.get(effect);
        // The reconciliation half of the obligation: this effect already happened, so its
        // recorded outcome is the answer and no second delivery is made.
        if (settled !== undefined) return settled;
        if (this.scenario.kind === "faults") {
            throw new TypeError("Reference transport failed in a way the taxonomy does not name");
        }

        const answer = this.answer(limits);
        this.deliveries += 1;
        this.#settled.set(effect, answer);
        if (this.scenario.kind === "crashes-after-send") {
            // Delivered, then lost the outcome before it could be reported. The runtime
            // does not know whether the request happened, which is what `indeterminate`
            // says and what the retry then resolves.
            throw new TypeError("Reference transport crashed after delivering");
        }
        return answer;
    }

    /** The wire condition this scenario asks for, on this hop. */
    private answer(limits: WebTransportLimits): WebTransportResponse {
        const firstHop = this.requests.length === 1;
        if (this.scenario.kind === "answers-after-redirect") {
            return firstHop ? this.redirect(WEB_EGRESS_WIRE.redirect) : this.answered();
        }
        if (this.scenario.kind === "refuses" && this.scenario.position === "after-send") {
            if (this.scenario.code === "size.exceeded") {
                // One byte past the bound the seam just handed over, so the refusal is
                // the bound's rather than this fixture's idea of a large reply.
                return { ...this.answered(), body: new Uint8Array(limits.maxResponseBytes + 1) };
            }
            if (this.scenario.code === "url.denied") {
                return this.redirect(WEB_EGRESS_WIRE.refusedRedirect);
            }
            // `rate.exceeded` on the next hop's origin, and `redirect.denied` once the hop
            // count runs out: both need a redirect the backend will try to follow.
            return this.redirect(WEB_EGRESS_WIRE.redirect);
        }
        return this.answered();
    }

    private answered(): WebTransportResponse {
        return {
            status: WEB_EGRESS_WIRE.status,
            headers: { "x-provider": "reference" },
            body: new Uint8Array([1])
        };
    }

    private redirect(target: string): WebTransportResponse {
        return { ...this.answered(), redirect: target };
    }
}

/**
 * Dedups on the canonical key — and on the hop's requested URL, which the protocol does
 * not make part of the effect identity. That concatenation is not a convenience: it is
 * this reference working around the finding the last case in this file demonstrates.
 */
const keyDedupReference: WebEgressImplementation = {
    transport: (scenario) =>
        new ReferenceWebTransport(
            scenario,
            (dispatch, request) =>
                `${dispatch.idempotencyKey}\n${request.authorization.requestedUrl}`
        )
};

/**
 * Reconciles by attempt identity instead: the same crash-after-send retry is recognised
 * from `attempt.id` and `attempt.ordinal` rather than from the key. A provider that keys
 * its ledger this way answers the same contract, which is why the obligation is stated as
 * two capabilities rather than one mechanism.
 */
const attemptReconcilingReference: WebEgressImplementation = {
    transport: (scenario) =>
        new ReferenceWebTransport(scenario, (dispatch, request) => {
            const attempt =
                dispatch.attempt === undefined
                    ? dispatch.idempotencyKey
                    : `${dispatch.attempt.id.value}#${dispatch.attempt.ordinal}`;
            return `${attempt}\n${request.authorization.requestedUrl}`;
        })
};

/**
 * A provider that reads `WebTransport.send`'s docstring literally: `dispatch.idempotencyKey`
 * is *the* dedup key, with nothing else mixed in. Not a contract member — it is the
 * subject of the last case in this file.
 */
const keyOnlyReference: WebEgressImplementation = {
    transport: (scenario) =>
        new ReferenceWebTransport(scenario, (dispatch) => dispatch.idempotencyKey)
};

/**
 * A provider that ignores the identity entirely. Not a member of the contract: it exists
 * so the retry-safety case is known to discriminate, and to show what the runtime is
 * exposed to, because nothing in `src/` can stop it.
 */
class ForgetfulWebTransport implements WebEgressTransport {
    public readonly requests: WebTransportRequest[] = [];
    public readonly dispatches: EffectDispatch[] = [];
    public readonly limits: WebTransportLimits[] = [];
    public deliveries = 0;

    public async send(
        request: WebTransportRequest,
        limits: WebTransportLimits,
        dispatch: EffectDispatch
    ): Promise<WebTransportResponse> {
        this.requests.push(request);
        this.dispatches.push(dispatch);
        this.limits.push(limits);
        this.deliveries += 1;
        throw new TypeError("Forgetful transport crashed after delivering");
    }
}

webEgressContract("key-dedup reference", keyDedupReference);
webEgressContract("attempt-reconciling reference", attemptReconcilingReference);

describe("web egress service protocol", () => {
    test(
        "declares exactly the operations an implementation has to serve, at the impact each one crosses",
        { tags: "p1" },
        () => {
            expect(Object.keys(WEB_OPERATION_CONTRACTS)).toEqual([...WEB_EGRESS_OPERATIONS]);
            expect(WEB_OPERATIONS.map((operation) => operation.name.value)).toEqual([
                ...WEB_EGRESS_OPERATIONS
            ]);
            // SPEC P11-WEB-FETCH and P11-WEB-SEARCH: a request that crosses the trust
            // boundary is an `externalSend`. P11-WEB-CACHED: reading what an earlier
            // crossing left behind only observes.
            expect(
                Object.fromEntries(
                    WEB_OPERATIONS.map((operation) => [operation.name.value, operation.impact])
                )
            ).toEqual({ fetch: "externalSend", search: "externalSend", readCached: "observe" });
            // The backend has to serve every declared operation. It carries nothing else
            // that is a protocol verb: `safeUrl` and `authorizeTarget` are private.
            const offered = Object.getOwnPropertyNames(WebBackend.prototype);
            expect(WEB_EGRESS_OPERATIONS.every((name) => offered.includes(name))).toBe(true);
        }
    );

    test(
        "leaves no WebPolicyErrorCode outside the service taxonomy, and none distinguishable at the kernel level",
        { tags: "p0" },
        () => {
            // Both directions against the facet itself rather than against the contract's
            // own table: every declared refusal constructs, and each one carries the same
            // kernel code out of the facet. Seven detail codes, one
            // `AgentCoreErrorCode` -- so a caller that catches `AgentCoreError` and reads
            // `code` cannot tell an SSRF refusal from a malformed cache key, and only the
            // `detailCode` this taxonomy is built on can.
            const kernelCodes = WEB_EGRESS_REFUSALS.map(
                (code) => new WebPolicyError(code, "contract").code
            );
            const detailCodes = WEB_EGRESS_REFUSALS.map(
                (code) => new WebPolicyError(code, "contract").detailCode
            );

            expect(detailCodes).toEqual([...WEB_EGRESS_REFUSALS]);
            expect(kernelCodes).toEqual(
                WEB_EGRESS_REFUSALS.map((code) => WEB_EGRESS_TAXONOMY[code].kernelCode)
            );
            expect(kernelCodes.every((code) => code === "operation.invalid-input")).toBe(true);
            // Every taxonomy row names at least one site in the facet, because a refusal
            // nothing raises is a vocabulary entry rather than a behaviour.
            expect(
                WEB_EGRESS_REFUSALS.every((code) => WEB_EGRESS_TAXONOMY[code].sites.length > 0)
            ).toBe(true);
        }
    );

    test(
        "re-delivers a crash-after-send retry when the provider ignores the effect identity, and nothing in the seam prevents it",
        { tags: "p1" },
        async () => {
            // The negative control for the retry-safety case. `WebBackend` forwards the
            // dispatch and takes the provider's word for what it did with it: there is no
            // ledger, no reconciliation query and no duplicate check on this side of the
            // boundary, so at-most-once delivery is the provider's promise alone.
            const transport = new ForgetfulWebTransport();
            const service = controlService(transport);

            const lost = await webEgressReply(service, {
                operation: "fetch",
                dispatch: WEB_EGRESS_DISPATCH,
                request: { url: "https://allowed.test/page" }
            });
            const retried = await webEgressReply(service, {
                operation: "fetch",
                dispatch: WEB_EGRESS_DISPATCH,
                request: { url: "https://allowed.test/page" }
            });

            expect(lost.kind).toBe("indeterminate");
            expect(retried.kind).toBe("indeterminate");
            // Two deliveries under one effect identity. The contract's retry-safety case
            // passes for the references because they choose to honour the obligation, not
            // because the runtime holds them to it.
            expect(transport.deliveries).toBe(2);
            expect(
                transport.dispatches.every(
                    (dispatch) => dispatch.idempotencyKey === WEB_EGRESS_DISPATCH.idempotencyKey
                )
            ).toBe(true);
        }
    );

    test(
        "cannot follow a redirect when the provider dedups on the idempotency key alone",
        { tags: "p1" },
        async () => {
            // The finding the two contract members work around. `WebBackend.fetch` sends
            // every redirect hop under one `EffectDispatch`, and `WebTransport.send`'s
            // docstring tells the provider to treat `idempotencyKey` as *the* dedup key.
            // A provider that does exactly that answers the second hop out of its own
            // ledger -- with the first hop's redirect -- so the chain re-resolves the same
            // target until the hop bound refuses it. The provider is holding the answer
            // the caller asked for and the caller gets `redirect.denied` instead.
            const transport = keyOnlyReference.transport({ kind: "answers-after-redirect" });
            const reply = await webEgressReply(controlService(transport), {
                operation: "fetch",
                dispatch: WEB_EGRESS_DISPATCH,
                request: { url: "https://allowed.test/page" }
            });

            expect(reply).toEqual({
                kind: "refused",
                code: "redirect.denied",
                kernelCode: WEB_EGRESS_TAXONOMY["redirect.denied"].kernelCode
            });
            // One delivery, two hops: the second hop never left, because the provider
            // recognised it as the effect it had already carried.
            expect(transport.deliveries).toBe(1);
            expect(transport.requests).toHaveLength(WEB_EGRESS_BOUNDS.maxRedirects + 1);
            // Nothing in the dispatch distinguishes the hops, which is why the provider
            // could not tell them apart: one key, one attempt, two different targets.
            expect(transport.dispatches.every((dispatch) => dispatch === WEB_EGRESS_DISPATCH)).toBe(
                true
            );
            expect(transport.requests.map((request) => request.authorization.requestedUrl)).toEqual(
                ["https://allowed.test/page", WEB_EGRESS_WIRE.redirect]
            );
        }
    );
});

/**
 * The service the two control cases stand up. It restates only what they need: the
 * contract body's own assembly is not exported, because a runner that could reshape the
 * policy chain would be able to answer a different contract than the one it claims to
 * run.
 */
function controlService(transport: WebEgressTransport) {
    const backend = new WebBackend(
        {
            maxRequestBytes: WEB_EGRESS_BOUNDS.maxRequestBytes,
            maxResponseBytes: WEB_EGRESS_BOUNDS.maxResponseBytes,
            maxRedirects: WEB_EGRESS_BOUNDS.maxRedirects,
            searchEndpoint: "https://allowed.test/search"
        },
        {
            authorize: (url) =>
                Object.freeze({
                    requestedUrl: url.href,
                    resolvedTarget: `resolved:${url.hostname}`,
                    token: Object.freeze({ target: url.hostname })
                })
        },
        { headersFor: (_url, requested) => requested },
        { headersFor: () => Object.freeze({}) },
        { consume: () => true },
        transport,
        { read: () => undefined }
    );
    return {
        backend,
        transport,
        consumed: [],
        authorized: [],
        credentialed: []
    };
}
