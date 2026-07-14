import { describe, expect, test } from "vitest";
import {
    FixedWindowRatePolicy,
    WEB_OPERATION_CONTRACTS,
    WEB_OPERATIONS,
    WebBackend,
    WebFacet,
    WebPolicyError,
    type WebHeaders,
    type WebResponse,
    type WebTransportAuthorization,
    type WebTransportLimits,
    type WebTransportRequest,
    type WebTransportResponse
} from "../../../src/facets";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Web", WEB_OPERATIONS, {
    fetch: "externalSend",
    search: "externalSend",
    readCached: "observe"
});

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
            await expect(web.fetch({ url })).rejects.toMatchObject({ detailCode: "url.denied" });
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
            web.fetch({ url: "https://allowed.test/", headers: { Authorization: "secret" } })
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
        await web.fetch({ url: "https://allowed.test/", headers: { "x-caller": "safe" } });
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
            oversized.fetch({ url: "https://allowed.test/", body: new Uint8Array([1, 2]) })
        ).rejects.toMatchObject({ detailCode: "size.exceeded" });
        const rateLimited = createWebBackend({
            rate: () => false,
            send: async () => {
                sends += 1;
                return response();
            }
        });
        await expect(rateLimited.fetch({ url: "https://allowed.test/" })).rejects.toMatchObject({
            detailCode: "rate.exceeded"
        });
        expect(sends).toBe(0);
    });

    test("[P11-WEB-BLOCK] rejects an oversized response instead of returning truncated bytes", async () => {
        const web = createWebBackend({
            maxResponseBytes: 1,
            send: async () => response({ body: new Uint8Array([1, 2]) })
        });
        await expect(web.fetch({ url: "https://allowed.test/" })).rejects.toMatchObject({
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
        await expect(web.fetch({ url: "https://blocked.test/" })).rejects.toMatchObject({
            detailCode: "url.denied"
        });
        await expect(
            web.fetch({ url: "https://allowed.test/", headers: { Authorization: "secret" } })
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
        await expect(web.fetch({ url: "https://first.test/start" })).resolves.toMatchObject({
            status: 200
        });
        expect(requests.map((request) => request.headers["authorization"])).toEqual([
            "for-first.test",
            "for-second.test"
        ]);
        await expect(web.fetch({ url: "https://first.test/again" })).rejects.toMatchObject({
            detailCode: "rate.exceeded"
        });
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
            web.fetch({ url: "https://allowed.test/", body: new Uint8Array([1, 2]) })
        ).rejects.toMatchObject({ detailCode: "size.exceeded" });
        await expect(web.fetch({ url: "https://allowed.test/" })).rejects.toMatchObject({
            detailCode: "size.exceeded"
        });
        const bodyTransport = createWebBackend({
            send: async (request) => {
                expect(request.body).toEqual(new Uint8Array([1]));
                return response();
            }
        });
        await expect(
            bodyTransport.fetch({
                url: "https://allowed.test/",
                body: new Uint8Array([1])
            })
        ).resolves.toMatchObject({ status: 200 });
        expect(() => web.search(" ")).toThrow(
            expect.objectContaining({ detailCode: "search.invalid" })
        );
        expect(() => web.search("query", 0)).toThrow(
            expect.objectContaining({ detailCode: "search.invalid" })
        );

        const noRedirects = createWebBackend({
            send: async () => response({ redirect: "/next" }),
            maxRedirects: 0
        });
        await expect(noRedirects.fetch({ url: "https://allowed.test/" })).rejects.toMatchObject({
            detailCode: "redirect.denied"
        });
        for (const url of ["relative", "ftp://allowed.test/", "https://user:pass@allowed.test/"]) {
            await expect(noRedirects.fetch({ url })).rejects.toMatchObject({
                detailCode: "url.denied"
            });
        }
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
            await expect(web.fetch({ url: requested })).rejects.toMatchObject({
                detailCode: "url.denied"
            });
        }
    });
});

interface WebOptions {
    readonly authorize?: (url: URL) => WebTransportAuthorization;
    readonly callerHeaders?: (url: URL, requested: WebHeaders) => WebHeaders;
    readonly credentials?: (url: URL) => Readonly<Record<string, string>>;
    readonly rate?: (origin: string) => boolean;
    readonly send: (
        request: WebTransportRequest,
        limits: WebTransportLimits
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
