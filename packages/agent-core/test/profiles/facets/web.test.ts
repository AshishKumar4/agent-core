import { describe, expect, test } from "vitest";
import { CompatRange, Digest, SemVer } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import {
    EffectDispatch,
    EffectDispatchAttempt,
    FacetPackageId,
    FixedWindowRatePolicy,
    OperationName,
    WEB_OPERATION_CONTRACTS,
    WEB_OPERATIONS,
    WebBackend,
    WebFacet,
    WebPolicyError,
    createWebManifest,
    type OperationContext,
    type WebHeaders,
    type WebResponse,
    type WebTransportAuthorization,
    type WebTransportLimits,
    type WebTransportRequest,
    type WebTransportResponse
} from "../../../src/facets";
import { EffectAttemptId, InvocationId } from "../../../src/invocations";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Web", WEB_OPERATIONS, {
    fetch: "externalSend",
    search: "externalSend",
    readCached: "observe"
});

const DISPATCH = new EffectDispatch(
    "web-test-key",
    new EffectDispatchAttempt(
        new EffectAttemptId("web-test-attempt"),
        0,
        Digest.sha256(new TextEncoder().encode("web-test"))
    )
);

describe("Web protected facade", () => {
    test("[P11-WEB-FETCH] routes fetch and search through invoke", async () => {
        const requests: WebTransportRequest[] = [];
        const backend = createWebBackend({
            send: async (request) => {
                requests.push(request);
                return response();
            }
        });
        const { runtime, admission } = recordingRuntime("web");
        const web = new WebFacet(runtime, backend);
        await web.fetch({ url: "https://allowed.test/page" });
        await web.search({ query: "two words", limit: 3 });
        expect(admission.calls.map((call) => call.name)).toEqual(["fetch", "search"]);
        expect(admission.calls[0]?.impact).toBe("externalSend");
        expect(requests).toHaveLength(2);
        expect(new URL(requests[1]!.authorization.requestedUrl).searchParams.get("q")).toBe(
            "two words"
        );
    });

    test("denial happens before URL policy or transport", async () => {
        let sends = 0;
        const backend = createWebBackend({
            send: async () => {
                sends += 1;
                return response();
            }
        });
        const web = new WebFacet(denyingRuntime("web").runtime, backend);
        await expect(web.fetch({ url: "https://allowed.test/" })).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(sends).toBe(0);
    });

    test("[P11-WEB-CACHED] reads cached responses with observe impact and never reaches transport", async () => {
        let sends = 0;
        const cached: WebResponse = {
            url: "https://allowed.test/cached",
            status: 200,
            headers: {},
            body: new Uint8Array([7])
        };
        const { runtime, admission } = recordingRuntime("web-cached");
        const web = new WebFacet(
            runtime,
            createWebBackend({
                cache: (key) => (key === "hit" ? cached : undefined),
                send: async () => {
                    sends += 1;
                    return response();
                }
            })
        );

        await expect(web.readCached({ key: "hit" })).resolves.toEqual(cached);
        await expect(web.readCached({ key: "miss" })).resolves.toBeUndefined();
        expect(admission.calls.map((call) => [call.name, call.impact])).toEqual([
            ["readCached", "observe"],
            ["readCached", "observe"]
        ]);
        expect(sends).toBe(0);
    });

    test("[P11-WEB-DISPATCH] delivers the canonical effect identity derived from the mediated context to transport", async () => {
        const dispatched: EffectDispatch[] = [];
        const backend = createWebBackend({
            send: async (_request, _limits, dispatch) => {
                dispatched.push(dispatch);
                return response();
            }
        });
        const { runtime, admission } = recordingRuntime("web-dispatch");
        const web = new WebFacet(runtime, backend);

        await web.fetch({ url: "https://allowed.test/page" });

        const expected = admission.calls[0]!.context!.dispatch();
        expect(dispatched).toHaveLength(1);
        const delivered = dispatched[0]!;
        expect(Object.isFrozen(delivered)).toBe(true);
        expect(delivered.idempotencyKey).toBe(expected.idempotencyKey);
        expect(delivered.attempt?.id.equals(expected.attempt!.id)).toBe(true);
        expect(delivered.attempt?.ordinal).toBe(expected.attempt!.ordinal);
        expect(delivered.attempt?.intentDigest.equals(expected.attempt!.intentDigest)).toBe(true);
    });

    test("[P11-WEB-CRASH-RETRY] a crash-after-send retry reuses the idempotency key so the provider dedups instead of re-sending", async () => {
        const transport = new DedupWebTransport();
        const backend = createWebBackend({
            send: (request, limits, dispatch) => transport.send(request, limits, dispatch)
        });

        await expect(backend.fetch({ url: "https://allowed.test/" }, DISPATCH)).rejects.toThrow(
            "crash after send"
        );
        const retry = await backend.fetch({ url: "https://allowed.test/" }, DISPATCH);

        expect(transport.attempts.map((dispatch) => dispatch.idempotencyKey)).toEqual([
            DISPATCH.idempotencyKey,
            DISPATCH.idempotencyKey
        ]);
        expect(
            transport.attempts.every((dispatch) =>
                dispatch.attempt!.id.equals(DISPATCH.attempt!.id)
            )
        ).toBe(true);
        expect(transport.deliveries).toBe(1);
        expect(retry.status).toBe(200);
    });
});

describe("Web policy backend", () => {
    test("[P11-WEB-SEARCH] mediates search with externalSend impact before transport", async () => {
        const requests: WebTransportRequest[] = [];
        const { runtime, admission } = recordingRuntime("web-search");
        const web = new WebFacet(
            runtime,
            createWebBackend({
                send: async (request) => {
                    requests.push(request);
                    return response();
                }
            })
        );
        await web.search({ query: "query", limit: 2 });
        expect(admission.calls).toMatchObject([
            { kind: "invoke", name: "search", impact: "externalSend" }
        ]);
        expect(requests).toHaveLength(1);
    });

    test("[P11-WEB-URL-SAFETY] rejects unsafe and disallowed URLs before transport", async () => {
        let sends = 0;
        const web = createWebBackend({
            authorize: (url) => {
                if (url.hostname !== "allowed.test") {
                    throw new WebPolicyError("url.denied", "blocked");
                }
                return authorization(url);
            },
            send: async () => {
                sends += 1;
                return response();
            }
        });
        for (const url of [
            "relative",
            "https://blocked.test/",
            "https://user:pass@allowed.test/"
        ]) {
            await expect(web.fetch({ url }, DISPATCH)).rejects.toMatchObject({
                detailCode: "url.denied"
            });
        }
        expect(sends).toBe(0);
    });

    test("[P11-WEB-CREDENTIAL-POLICY] rejects caller credentials before transport", async () => {
        let sends = 0;
        const web = createWebBackend({
            send: async () => {
                sends += 1;
                return response();
            }
        });
        await expect(
            web.fetch(
                { url: "https://allowed.test/", headers: { Authorization: "secret" } },
                DISPATCH
            )
        ).rejects.toMatchObject({ detailCode: "credential.denied" });
        expect(sends).toBe(0);
    });

    test("[P11-WEB-CREDENTIAL-ATTACHMENT] attaches policy credentials only to the authorized target", async () => {
        const requests: WebTransportRequest[] = [];
        const web = createWebBackend({
            credentials: (url) => ({ authorization: `policy-${url.hostname}` }),
            send: async (request) => {
                requests.push(request);
                return response();
            }
        });
        await web.fetch(
            { url: "https://allowed.test/", headers: { "x-caller": "safe" } },
            DISPATCH
        );
        expect(requests[0]?.headers).toEqual({
            authorization: "policy-allowed.test",
            "x-caller": "safe"
        });
    });

    test("[P11-WEB-LIMIT-POLICY] enforces request and rate limits before transport", async () => {
        let sends = 0;
        const oversized = createWebBackend({
            maxRequestBytes: 1,
            send: async () => {
                sends += 1;
                return response();
            }
        });
        await expect(
            oversized.fetch(
                { url: "https://allowed.test/", body: new Uint8Array([1, 2]) },
                DISPATCH
            )
        ).rejects.toMatchObject({ detailCode: "size.exceeded" });
        const rateLimited = createWebBackend({
            rate: () => false,
            send: async () => {
                sends += 1;
                return response();
            }
        });
        await expect(
            rateLimited.fetch({ url: "https://allowed.test/" }, DISPATCH)
        ).rejects.toMatchObject({
            detailCode: "rate.exceeded"
        });
        expect(sends).toBe(0);
    });

    test("[P11-WEB-BLOCK] rejects an oversized response instead of returning truncated bytes", async () => {
        const web = createWebBackend({
            maxResponseBytes: 1,
            send: async () => response({ body: new Uint8Array([1, 2]) })
        });
        await expect(web.fetch({ url: "https://allowed.test/" }, DISPATCH)).rejects.toMatchObject({
            detailCode: "size.exceeded"
        });
    });

    test("[P11-WEB-SEARCH] round-trips request and search wire options", () => {
        const request = {
            url: "https://allowed.test/",
            method: "POST",
            headers: { "X-Test": "yes" },
            body: new Uint8Array([1, 2])
        };
        expect(
            WEB_OPERATION_CONTRACTS.fetch.decodeInput(
                WEB_OPERATION_CONTRACTS.fetch.encodeInput(request)
            )
        ).toEqual(request);
        expect(
            WEB_OPERATION_CONTRACTS.search.decodeInput(
                WEB_OPERATION_CONTRACTS.search.encodeInput({ query: "query", limit: 2 })
            )
        ).toEqual({ query: "query", limit: 2 });
        expect(() =>
            WEB_OPERATION_CONTRACTS.fetch.decodeInput({
                url: "https://allowed.test/",
                body: ["invalid"]
            } as never)
        ).toThrow(TypeError);
    });

    test("[P11-WEB-DISALLOWED] denies disallowed and credential-bearing requests before transport", async () => {
        let sends = 0;
        const web = createWebBackend({
            authorize: (url) => {
                if (url.hostname !== "allowed.test")
                    throw new WebPolicyError("url.denied", "blocked");
                return authorization(url);
            },
            send: async () => {
                sends += 1;
                return response();
            }
        });
        await expect(web.fetch({ url: "https://blocked.test/" }, DISPATCH)).rejects.toMatchObject({
            detailCode: "url.denied"
        });
        await expect(
            web.fetch(
                { url: "https://allowed.test/", headers: { Authorization: "secret" } },
                DISPATCH
            )
        ).rejects.toMatchObject({ detailCode: "credential.denied" });
        expect(sends).toBe(0);
    });

    test("[P11-WEB-BOUNDS] rechecks redirects and enforces response/rate bounds", async () => {
        const requests: WebTransportRequest[] = [];
        let permits = 2;
        const web = createWebBackend({
            credentials: (url) => ({ authorization: `for-${url.hostname}` }),
            rate: () => permits-- > 0,
            maxResponseBytes: 1,
            send: async (request, limits) => {
                requests.push(request);
                expect(limits).toEqual({ maxResponseBytes: 1 });
                return requests.length === 1
                    ? response({ redirect: "https://second.test/final" })
                    : response({ body: new Uint8Array([1]) });
            }
        });
        await expect(
            web.fetch({ url: "https://first.test/start" }, DISPATCH)
        ).resolves.toMatchObject({ status: 200 });
        expect(requests.map((request) => request.headers["authorization"])).toEqual([
            "for-first.test",
            "for-second.test"
        ]);
        await expect(
            web.fetch({ url: "https://first.test/again" }, DISPATCH)
        ).rejects.toMatchObject({
            detailCode: "rate.exceeded"
        });
    });

    test("[P11-WEB-BOUNDS] delivers one canonical effect identity across every redirect hop", async () => {
        const dispatched: EffectDispatch[] = [];
        let permits = 2;
        const web = createWebBackend({
            rate: () => permits-- > 0,
            send: async (_request, _limits, dispatch) => {
                dispatched.push(dispatch);
                return dispatched.length === 1
                    ? response({ redirect: "https://second.test/final" })
                    : response();
            }
        });
        await web.fetch({ url: "https://first.test/start" }, DISPATCH);
        expect(dispatched).toEqual([DISPATCH, DISPATCH]);
    });

    test("enforces fixed per-origin windows", () => {
        let now = 10;
        const rates = new FixedWindowRatePolicy(1, 5, () => now);
        expect(rates.consume("https://one.test")).toBe(true);
        expect(rates.consume("https://one.test")).toBe(false);
        now = 15;
        expect(rates.consume("https://one.test")).toBe(true);
        const twoRequests = new FixedWindowRatePolicy(2, 5, () => now);
        expect(twoRequests.consume("https://two.test")).toBe(true);
        expect(twoRequests.consume("https://two.test")).toBe(true);
    });

    test("enforces request, response, redirect, search, URL, and configuration bounds", async () => {
        expect(() =>
            createWebBackend({ send: async () => response(), maxResponseBytes: -1 })
        ).toThrow(TypeError);
        expect(() => new FixedWindowRatePolicy(0, 1)).toThrow(TypeError);
        expect(() => new FixedWindowRatePolicy(1, 0)).toThrow(TypeError);

        const web = createWebBackend({
            send: async () => response({ body: new Uint8Array([1, 2]) }),
            maxRequestBytes: 1,
            maxResponseBytes: 1
        });
        await expect(
            web.fetch({ url: "https://allowed.test/", body: new Uint8Array([1, 2]) }, DISPATCH)
        ).rejects.toMatchObject({ detailCode: "size.exceeded" });
        await expect(web.fetch({ url: "https://allowed.test/" }, DISPATCH)).rejects.toMatchObject({
            detailCode: "size.exceeded"
        });
        const bodyTransport = createWebBackend({
            send: async (request) => {
                expect(request.body).toEqual(new Uint8Array([1]));
                return response();
            }
        });
        await expect(
            bodyTransport.fetch(
                {
                    url: "https://allowed.test/",
                    body: new Uint8Array([1])
                },
                DISPATCH
            )
        ).resolves.toMatchObject({ status: 200 });
        expect(() => web.search(" ", 10, DISPATCH)).toThrow(
            expect.objectContaining({ detailCode: "search.invalid" })
        );
        expect(() => web.search("query", 0, DISPATCH)).toThrow(
            expect.objectContaining({ detailCode: "search.invalid" })
        );

        const noRedirects = createWebBackend({
            send: async () => response({ redirect: "/next" }),
            maxRedirects: 0
        });
        await expect(
            noRedirects.fetch({ url: "https://allowed.test/" }, DISPATCH)
        ).rejects.toMatchObject({
            detailCode: "redirect.denied"
        });
        for (const url of ["relative", "ftp://allowed.test/", "https://user:pass@allowed.test/"]) {
            await expect(noRedirects.fetch({ url }, DISPATCH)).rejects.toMatchObject({
                detailCode: "url.denied"
            });
        }
    });

    test("omits absent optional wire fields for fetch and search", { tags: "p1" }, () => {
        expect(
            WEB_OPERATION_CONTRACTS.fetch.encodeInput({ url: "https://allowed.test/" })
        ).toStrictEqual({ url: "https://allowed.test/" });
        expect(WEB_OPERATION_CONTRACTS.search.encodeInput({ query: "query" })).toStrictEqual({
            query: "query"
        });
        expect(WEB_OPERATION_CONTRACTS.search.decodeInput({ query: "query" })).toStrictEqual({
            query: "query"
        });
    });

    test(
        "admits a body exactly at the limit and isolates hop bodies from caller and transport mutation",
        { tags: "p1" },
        async () => {
            const sent: number[][] = [];
            const original = new Uint8Array([1, 2]);
            const web = createWebBackend({
                maxRequestBytes: 2,
                send: async (request) => {
                    sent.push([...(request.body ?? [])]);
                    if (sent.length === 1) {
                        request.body?.fill(9);
                        original.fill(9);
                        return response({ redirect: "https://allowed.test/second" });
                    }
                    return response();
                }
            });
            await expect(
                web.fetch({ url: "https://allowed.test/first", body: original }, DISPATCH)
            ).resolves.toMatchObject({ status: 200 });
            expect(sent).toEqual([
                [1, 2],
                [1, 2]
            ]);
        }
    );

    test(
        "defaults the method to GET and returns copies of transport response headers and body",
        { tags: "p1" },
        async () => {
            const transportBody = new Uint8Array([5]);
            const methods: string[] = [];
            const web = createWebBackend({
                send: async (request) => {
                    methods.push(request.method);
                    return response({ headers: { "x-provider": "1" }, body: transportBody });
                }
            });
            const result = await web.fetch({ url: "https://allowed.test/" }, DISPATCH);
            expect(result.headers).toEqual({ "x-provider": "1" });
            transportBody.fill(0);
            expect([...result.body]).toEqual([5]);
            await web.fetch({ url: "https://allowed.test/", method: "POST" }, DISPATCH);
            expect(methods).toEqual(["GET", "POST"]);
        }
    );

    test("stops redirect chains exactly at the configured bound", { tags: "p1" }, async () => {
        let sends = 0;
        const zeroRedirects = createWebBackend({
            maxRedirects: 0,
            send: async () => {
                sends += 1;
                return sends === 1 ? response({ redirect: "/next" }) : response();
            }
        });
        await expect(
            zeroRedirects.fetch({ url: "https://allowed.test/" }, DISPATCH)
        ).rejects.toMatchObject({ detailCode: "redirect.denied" });
        expect(sends).toBe(1);

        let hops = 0;
        const runaway = createWebBackend({
            maxRedirects: 1,
            send: async () => {
                hops += 1;
                if (hops > 3) throw new TypeError("redirect chain must stop at the bound");
                return response({ redirect: "/loop" });
            }
        });
        await expect(
            runaway.fetch({ url: "https://allowed.test/" }, DISPATCH)
        ).rejects.toMatchObject({ detailCode: "redirect.denied" });
        expect(hops).toBe(2);
    });

    test(
        "allows plain http targets while rejecting either embedded credential field",
        { tags: "p0" },
        async () => {
            const web = createWebBackend({ send: async () => response() });
            await expect(
                web.fetch({ url: "http://allowed.test/" }, DISPATCH)
            ).resolves.toMatchObject({ status: 200 });
            for (const url of ["https://user@allowed.test/", "https://:pass@allowed.test/"]) {
                await expect(web.fetch({ url }, DISPATCH)).rejects.toMatchObject({
                    detailCode: "url.denied"
                });
            }
        }
    );

    test("encodes the query and limit into the search endpoint", { tags: "p1" }, async () => {
        const requested: URL[] = [];
        const web = createWebBackend({
            send: async (request) => {
                requested.push(new URL(request.authorization.requestedUrl));
                return response();
            }
        });
        await web.search("query", 3, DISPATCH);
        await web.search("query", undefined, DISPATCH);
        expect(requested.map((url) => url.searchParams.get("limit"))).toEqual(["3", "10"]);
    });

    test(
        "readCached admits only canonical keys and preserves cached headers",
        { tags: "p1" },
        () => {
            const reads: string[] = [];
            const cached: WebResponse = {
                url: "https://allowed.test/cached",
                status: 200,
                headers: { "x-cached": "1" },
                body: new Uint8Array([7])
            };
            const web = createWebBackend({
                cache: (key) => {
                    reads.push(key);
                    return cached;
                },
                send: async () => response()
            });
            for (const key of ["", " key", "key ", " "]) {
                expect(() => web.readCached(key)).toThrow(
                    expect.objectContaining({
                        detailCode: "cache.invalid",
                        message: "Web cache key must be canonical"
                    })
                );
            }
            expect(reads).toEqual([]);
            expect(web.readCached("hit")).toEqual(cached);
        }
    );

    test("counts every request within the active rate window", { tags: "p1" }, () => {
        const rates = new FixedWindowRatePolicy(3, 5, () => 10);
        expect([
            rates.consume("https://three.test"),
            rates.consume("https://three.test"),
            rates.consume("https://three.test"),
            rates.consume("https://three.test")
        ]).toEqual([true, true, true, false]);
    });

    test("reports typed policy errors with exact codes and messages", { tags: "p2" }, async () => {
        const error = new WebPolicyError("rate.exceeded", "example");
        expect(error.name).toBe("WebPolicyError");
        expect(error.code).toBe("operation.invalid-input");

        const bounded = createWebBackend({
            maxRequestBytes: 1,
            maxResponseBytes: 1,
            send: async () => response({ body: new Uint8Array([1, 2]) })
        });
        await expect(
            bounded.fetch({ url: "https://allowed.test/", body: new Uint8Array([1, 2]) }, DISPATCH)
        ).rejects.toMatchObject({ message: "Request body exceeds the configured limit" });
        await expect(
            bounded.fetch({ url: "https://allowed.test/" }, DISPATCH)
        ).rejects.toMatchObject({ message: "Response exceeds the configured limit" });
        await expect(bounded.fetch({ url: "not-a-url" }, DISPATCH)).rejects.toMatchObject({
            message: "URL is invalid"
        });
        expect(() => bounded.search(" ", 1, DISPATCH)).toThrow("Search query must be nonblank");
        expect(() => bounded.search("query", 0, DISPATCH)).toThrow(
            "Search limit must be positive"
        );

        const rateLimited = createWebBackend({ rate: () => false, send: async () => response() });
        await expect(
            rateLimited.fetch({ url: "https://allowed.test/" }, DISPATCH)
        ).rejects.toMatchObject({ message: "Web rate limit exceeded" });
        const redirecting = createWebBackend({
            maxRedirects: 0,
            send: async () => response({ redirect: "/next" })
        });
        await expect(
            redirecting.fetch({ url: "https://allowed.test/" }, DISPATCH)
        ).rejects.toMatchObject({ message: "Redirect limit exceeded" });
    });

    test("labels malformed wire fields precisely", { tags: "p2" }, () => {
        const { fetch, search } = WEB_OPERATION_CONTRACTS;
        expect(() => fetch.decodeInput({ url: 5 })).toThrow("Web request URL must be a string");
        expect(() => fetch.decodeInput({ url: "https://allowed.test/", method: 5 })).toThrow(
            "Web method must be a string"
        );
        expect(() => search.decodeInput({ query: 5 })).toThrow("Web search query must be a string");
        expect(() => fetch.decodeOutput({ url: 5, status: 200, headers: {}, body: [] })).toThrow(
            "Web response URL must be a string"
        );
        expect(() =>
            fetch.decodeOutput({
                url: "https://allowed.test/",
                status: 200,
                headers: { "x-a": 5 },
                body: []
            })
        ).toThrow("Web header x-a must be a string");
    });

    test("rejects every malformed transport authorization field", async () => {
        const requested = "https://allowed.test/";
        for (const invalid of [
            { requestedUrl: "https://other.test/", resolvedTarget: "target", token: {} },
            { requestedUrl: requested, resolvedTarget: " ", token: {} },
            { requestedUrl: requested, resolvedTarget: "target", token: null },
            { requestedUrl: requested, resolvedTarget: "target", token: "token" }
        ]) {
            const web = createWebBackend({
                authorize: () => invalid as WebTransportAuthorization,
                send: async () => response()
            });
            await expect(web.fetch({ url: requested }, DISPATCH)).rejects.toMatchObject({
                detailCode: "url.denied"
            });
        }
    });
});

describe("Web internal runtime", () => {
    test(
        "executes fetch, search, and readCached through the manifest-validated runtime",
        { tags: "p1" },
        async () => {
            const cached: WebResponse = {
                url: "https://allowed.test/cached",
                status: 200,
                headers: {},
                body: new Uint8Array([7])
            };
            const backend = createWebBackend({
                cache: (key) => (key === "hit" ? cached : undefined),
                send: async () => response()
            });
            const manifest = createWebManifest(manifestInit());
            const internal = new WebFacet(
                recordingRuntime("web-internal").runtime,
                backend
            ).asInternalRuntime(manifest);

            expect(internal.manifest).toBe(manifest);
            await expect(
                internal
                    .operation(new OperationName("fetch"))
                    ?.execute(operationContext(), { url: "https://allowed.test/page" })
            ).resolves.toEqual({
                url: "https://allowed.test/page",
                status: 200,
                headers: {},
                body: []
            });
            await expect(
                internal
                    .operation(new OperationName("search"))
                    ?.execute(operationContext(), { query: "query" })
            ).resolves.toMatchObject({ status: 200 });
            await expect(
                internal
                    .operation(new OperationName("readCached"))
                    ?.execute(operationContext(), { key: "hit" })
            ).resolves.toEqual({
                url: "https://allowed.test/cached",
                status: 200,
                headers: {},
                body: [7]
            });
        }
    );
});

interface WebOptions {
    readonly authorize?: (url: URL) => WebTransportAuthorization;
    readonly callerHeaders?: (url: URL, requested: WebHeaders) => WebHeaders;
    readonly credentials?: (url: URL) => Readonly<Record<string, string>>;
    readonly rate?: (origin: string) => boolean;
    readonly send: (
        request: WebTransportRequest,
        limits: WebTransportLimits,
        dispatch: EffectDispatch
    ) => Promise<WebTransportResponse>;
    readonly maxResponseBytes?: number;
    readonly maxRequestBytes?: number;
    readonly maxRedirects?: number;
    readonly cache?: (key: string) => WebResponse | undefined;
}

function createWebBackend(options: WebOptions): WebBackend {
    return new WebBackend(
        {
            maxRequestBytes: options.maxRequestBytes ?? 10,
            maxResponseBytes: options.maxResponseBytes ?? 10,
            maxRedirects: options.maxRedirects ?? 2,
            searchEndpoint: "https://allowed.test/search"
        },
        { authorize: options.authorize ?? authorization },
        { headersFor: options.callerHeaders ?? ((_url, requested) => requested) },
        { headersFor: options.credentials ?? (() => ({})) },
        { consume: options.rate ?? (() => true) },
        { send: options.send },
        { read: options.cache ?? (() => undefined) }
    );
}

/**
 * A provider transport that dedups on the canonical idempotency key: the first send
 * delivers then crashes before the outcome is recorded; a retry carrying the same key
 * returns the prior result without re-delivering (SPEC §7.4).
 */
class DedupWebTransport {
    public readonly attempts: EffectDispatch[] = [];
    public deliveries = 0;
    readonly #results = new Map<string, WebTransportResponse>();

    public async send(
        _request: WebTransportRequest,
        _limits: WebTransportLimits,
        dispatch: EffectDispatch
    ): Promise<WebTransportResponse> {
        this.attempts.push(dispatch);
        const prior = this.#results.get(dispatch.idempotencyKey);
        if (prior !== undefined) return prior;
        this.deliveries += 1;
        this.#results.set(dispatch.idempotencyKey, response());
        throw new WebPolicyError("url.denied", "crash after send");
    }
}

function authorization(url: URL): WebTransportAuthorization {
    return {
        requestedUrl: url.href,
        resolvedTarget: `resolved:${url.hostname}`,
        token: Object.freeze({ target: url.hostname })
    };
}

function response(overrides: Partial<WebTransportResponse> = {}): WebTransportResponse {
    return { status: 200, headers: {}, body: new Uint8Array(), ...overrides };
}

function manifestInit() {
    return {
        id: new FacetPackageId("profile.web"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: []
    };
}

function operationContext(): OperationContext {
    return {
        invocation: new InvocationId("web-internal-invocation"),
        itemIndex: 0,
        idempotencyKey: "web-internal-idempotency",
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    };
}
