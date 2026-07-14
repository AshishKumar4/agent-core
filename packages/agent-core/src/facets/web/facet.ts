import { Contributions, Contribution, OperationDescriptor } from "../contribution";
import type { FacetData } from "../data";
import { requireDataObject, requireSafeInteger, requireString } from "../data";
import { OperationName, SlotName } from "../id";
import type { FacetManifest } from "../manifest";
import {
    DetailedProfileError,
    InternalProfileFacetRuntime,
    ProfileOperationContract,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema
} from "../profile-runtime";

export type WebHeaders = Readonly<Record<string, string>>;

export interface WebUrlPolicy {
    authorize(url: URL): WebTransportAuthorization;
}

export interface WebCallerHeaderPolicy {
    headersFor(url: URL, requested: WebHeaders): WebHeaders;
}

export interface WebCredentialPolicy {
    headersFor(url: URL): WebHeaders;
}

export interface WebRatePolicy {
    consume(origin: string): boolean;
}

export interface WebTransportAuthorization {
    readonly requestedUrl: string;
    readonly resolvedTarget: string;
    readonly token: object;
}

export interface WebTransportLimits {
    readonly maxResponseBytes: number;
}

export interface WebTransportRequest {
    readonly authorization: WebTransportAuthorization;
    readonly method: string;
    readonly headers: WebHeaders;
    readonly body?: Uint8Array;
}

export interface WebTransportResponse {
    readonly status: number;
    readonly headers: WebHeaders;
    readonly body: Uint8Array;
    readonly redirect?: string;
}

export interface WebTransport {
    send(request: WebTransportRequest, limits: WebTransportLimits): Promise<WebTransportResponse>;
}

export interface WebRequest extends PublicProfileInput {
    readonly url: string;
    readonly method?: string;
    readonly headers?: WebHeaders;
    readonly body?: Uint8Array;
}

export interface WebSearchInput extends PublicProfileInput {
    readonly query: string;
    readonly limit?: number;
}

export interface WebCachedInput extends PublicProfileInput {
    readonly key: string;
}

export interface WebResponse {
    readonly url: string;
    readonly status: number;
    readonly headers: WebHeaders;
    readonly body: Uint8Array;
}

export interface WebFacetConfig {
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxRedirects: number;
    readonly searchEndpoint: string;
}

export interface WebResponseCache {
    read(key: string): WebResponse | undefined;
}

const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const headersSchema = {
    type: "object",
    additionalProperties: { type: "string" }
} as const;
const bodySchema = { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } } as const;
const responseSchema = schema({
    type: "object",
    properties: {
        url: { type: "string", format: "uri" },
        status: { type: "integer" },
        headers: headersSchema,
        body: bodySchema
    },
    required: ["url", "status", "headers", "body"],
    additionalProperties: false
});

export const WEB_OPERATION_CONTRACTS = Object.freeze({
    fetch: new ProfileOperationContract<"fetch", WebRequest, WebResponse>(
        "fetch",
        new OperationDescriptor(
            new OperationName("fetch"),
            "externalSend",
            strictObjectSchema(
                {
                    url: { type: "string", format: "uri" },
                    method: { type: "string", minLength: 1 },
                    headers: headersSchema,
                    body: bodySchema
                },
                ["url"]
            ),
            responseSchema
        ),
        profileWireCodec(
            (request) => ({
                url: request.url,
                ...(request.method === undefined ? {} : { method: request.method }),
                ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
                ...(request.body === undefined ? {} : { body: [...request.body] })
            }),
            decodeWebRequest
        ),
        profileWireCodec(encodeWebResponse, decodeWebResponse),
        "output"
    ),
    search: new ProfileOperationContract<"search", WebSearchInput, WebResponse>(
        "search",
        new OperationDescriptor(
            new OperationName("search"),
            "externalSend",
            strictObjectSchema(
                {
                    query: { type: "string", minLength: 1 },
                    limit: { type: "integer", minimum: 1 }
                },
                ["query"]
            ),
            responseSchema
        ),
        profileWireCodec(
            (input) => ({
                query: input.query,
                ...(input.limit === undefined ? {} : { limit: input.limit })
            }),
            (data) => {
                const object = requireDataObject(data, "Web search input");
                return {
                    query: requireString(object["query"], "Web search query"),
                    ...(object["limit"] === undefined
                        ? {}
                        : {
                              limit: requireSafeInteger(object["limit"], "Web search limit")
                          })
                };
            }
        ),
        profileWireCodec(encodeWebResponse, decodeWebResponse),
        "output"
    ),
    readCached: new ProfileOperationContract<"readCached", WebCachedInput, WebResponse | undefined>(
        "readCached",
        new OperationDescriptor(
            new OperationName("readCached"),
            "observe",
            strictObjectSchema({ key: { type: "string", minLength: 1 } }, ["key"]),
            schema({ anyOf: [responseSchema.document, { type: "null" }] })
        ),
        profileWireCodec(
            (input) => ({ key: input.key }),
            (data) => ({
                key: requireString(
                    requireDataObject(data, "Web cache input")["key"],
                    "Web cache key"
                )
            })
        ),
        profileWireCodec(
            (response) => (response === undefined ? null : encodeWebResponse(response)),
            (data) => (data === null ? undefined : decodeWebResponse(data))
        ),
        "output"
    )
});

export const WEB_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(WEB_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);
export const WEB_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        WEB_OPERATIONS.map((operation) => operation.toData())
    )
]);

export class WebBackend {
    public constructor(
        private readonly config: WebFacetConfig,
        private readonly urls: WebUrlPolicy,
        private readonly callerHeaders: WebCallerHeaderPolicy,
        private readonly credentials: WebCredentialPolicy,
        private readonly rates: WebRatePolicy,
        private readonly transport: WebTransport,
        private readonly cache: WebResponseCache
    ) {
        for (const [name, value] of Object.entries(config)) {
            if (
                name !== "searchEndpoint" &&
                (!Number.isSafeInteger(value) || (value as number) < 0)
            ) {
                throw new TypeError("Web limits must be non-negative safe integers");
            }
        }
        this.safeUrl(config.searchEndpoint);
    }

    public async fetch(request: WebRequest): Promise<WebResponse> {
        const body = request.body?.slice();
        if ((body?.byteLength ?? 0) > this.config.maxRequestBytes) {
            throw new WebPolicyError("size.exceeded", "Request body exceeds the configured limit");
        }
        const requestedHeaders = Object.freeze(normalizeHeaders(request.headers ?? {}));

        let url = this.safeUrl(request.url);
        for (let redirectCount = 0; ; redirectCount += 1) {
            const authorization = this.authorizeTarget(url);
            const callerHeaders = normalizeHeaders(
                this.callerHeaders.headersFor(url, requestedHeaders)
            );
            if (Object.keys(callerHeaders).some((name) => CREDENTIAL_HEADERS.has(name))) {
                throw new WebPolicyError(
                    "credential.denied",
                    "Credentials may only be attached by credential policy"
                );
            }
            const policyHeaders = normalizeHeaders(this.credentials.headersFor(url));
            if (!this.rates.consume(url.origin))
                throw new WebPolicyError("rate.exceeded", "Web rate limit exceeded");
            const response = await this.transport.send(
                {
                    authorization,
                    method: request.method ?? "GET",
                    headers: Object.freeze({ ...callerHeaders, ...policyHeaders }),
                    ...(body === undefined ? {} : { body: body.slice() })
                },
                Object.freeze({ maxResponseBytes: this.config.maxResponseBytes })
            );
            if (response.body.byteLength > this.config.maxResponseBytes) {
                throw new WebPolicyError("size.exceeded", "Response exceeds the configured limit");
            }
            if (response.redirect === undefined) {
                return Object.freeze({
                    url: url.href,
                    status: response.status,
                    headers: Object.freeze({ ...response.headers }),
                    body: response.body.slice()
                });
            }
            if (redirectCount >= this.config.maxRedirects) {
                throw new WebPolicyError("redirect.denied", "Redirect limit exceeded");
            }
            url = this.safeUrl(new URL(response.redirect, url).href);
        }
    }

    public search(query: string, limit = 10): Promise<WebResponse> {
        if (query.trim().length === 0)
            throw new WebPolicyError("search.invalid", "Search query must be nonblank");
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new WebPolicyError("search.invalid", "Search limit must be positive");
        }
        const endpoint = this.safeUrl(this.config.searchEndpoint);
        endpoint.searchParams.set("q", query);
        endpoint.searchParams.set("limit", String(limit));
        return this.fetch({ url: endpoint.href });
    }

    public readCached(key: string): WebResponse | undefined {
        if (key.trim().length === 0 || key !== key.trim()) {
            throw new WebPolicyError("cache.invalid", "Web cache key must be canonical");
        }
        const response = this.cache.read(key);
        return response === undefined ? undefined : decodeWebResponse(encodeWebResponse(response));
    }

    private safeUrl(value: string): URL {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            throw new WebPolicyError("url.denied", "URL is invalid");
        }
        if (
            (url.protocol !== "https:" && url.protocol !== "http:") ||
            url.username !== "" ||
            url.password !== ""
        ) {
            throw new WebPolicyError(
                "url.denied",
                "URL scheme or embedded credentials are not allowed"
            );
        }
        return url;
    }

    private authorizeTarget(url: URL): WebTransportAuthorization {
        const authorization = this.urls.authorize(new URL(url.href));
        if (
            authorization.requestedUrl !== url.href ||
            authorization.resolvedTarget.trim().length === 0 ||
            authorization.token === null ||
            typeof authorization.token !== "object"
        ) {
            throw new WebPolicyError(
                "url.denied",
                "URL policy returned an invalid transport authorization"
            );
        }
        return Object.freeze({
            requestedUrl: authorization.requestedUrl,
            resolvedTarget: authorization.resolvedTarget,
            token: authorization.token
        });
    }
}

export class WebFacet<Receipt> {
    public static readonly operations = WEB_OPERATIONS;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: WebBackend
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(WEB_OPERATION_CONTRACTS.fetch, (input) =>
                    this.backend.fetch(input)
                ),
                this.runtime.operation(WEB_OPERATION_CONTRACTS.search, (input) =>
                    this.backend.search(input.query, input.limit)
                ),
                this.runtime.operation(WEB_OPERATION_CONTRACTS.readCached, (input) =>
                    this.backend.readCached(input.key)
                )
            ]
        });
    }

    public fetch(input: WebRequest): Promise<WebResponse> {
        return this.runtime.invoke(WEB_OPERATION_CONTRACTS.fetch, input, (admitted) =>
            this.backend.fetch(admitted)
        );
    }

    public search(input: WebSearchInput): Promise<WebResponse> {
        return this.runtime.invoke(WEB_OPERATION_CONTRACTS.search, input, (admitted) =>
            this.backend.search(admitted.query, admitted.limit)
        );
    }

    public readCached(input: WebCachedInput): Promise<WebResponse | undefined> {
        return this.runtime.invoke(WEB_OPERATION_CONTRACTS.readCached, input, (admitted) =>
            this.backend.readCached(admitted.key)
        );
    }
}

export type WebPolicyErrorCode =
    | "url.denied"
    | "credential.denied"
    | "rate.exceeded"
    | "size.exceeded"
    | "redirect.denied"
    | "search.invalid"
    | "cache.invalid";

export class WebPolicyError extends DetailedProfileError<WebPolicyErrorCode> {
    public constructor(detailCode: WebPolicyErrorCode, message: string) {
        super("operation.invalid-input", detailCode, message);
        this.name = "WebPolicyError";
    }
}

export class FixedWindowRatePolicy implements WebRatePolicy {
    readonly #windows = new Map<string, { start: number; count: number }>();

    public constructor(
        private readonly maximum: number,
        private readonly windowMilliseconds: number,
        private readonly now: () => number = Date.now
    ) {
        if (
            !Number.isSafeInteger(maximum) ||
            maximum <= 0 ||
            !Number.isSafeInteger(windowMilliseconds) ||
            windowMilliseconds <= 0
        ) {
            throw new TypeError("Rate window and maximum must be positive safe integers");
        }
    }

    public consume(origin: string): boolean {
        const now = this.now();
        const current = this.#windows.get(origin);
        if (current === undefined || now - current.start >= this.windowMilliseconds) {
            this.#windows.set(origin, { start: now, count: 1 });
            return true;
        }
        if (current.count >= this.maximum) return false;
        current.count += 1;
        return true;
    }
}

function normalizeHeaders(headers: WebHeaders): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers))
        normalized[name.toLocaleLowerCase()] = value;
    return normalized;
}

function decodeWebRequest(data: FacetData): WebRequest {
    const object = requireDataObject(data, "Web request");
    return {
        url: requireString(object["url"], "Web request URL"),
        ...(object["method"] === undefined
            ? {}
            : { method: requireString(object["method"], "Web method") }),
        ...(object["headers"] === undefined ? {} : { headers: decodeHeaders(object["headers"]) }),
        ...(object["body"] === undefined ? {} : { body: decodeBytes(object["body"]) })
    };
}

function encodeWebResponse(response: WebResponse): FacetData {
    return {
        url: response.url,
        status: response.status,
        headers: { ...response.headers },
        body: [...response.body]
    };
}

function decodeWebResponse(data: FacetData): WebResponse {
    const object = requireDataObject(data, "Web response");
    return Object.freeze({
        url: requireString(object["url"], "Web response URL"),
        status: requireSafeInteger(object["status"], "Web response status"),
        headers: decodeHeaders(object["headers"]!),
        body: decodeBytes(object["body"]!)
    });
}

function decodeHeaders(data: FacetData): WebHeaders {
    const object = requireDataObject(data, "Web headers");
    return Object.freeze(
        Object.fromEntries(
            Object.entries(object).map(([name, value]) => [
                name,
                requireString(value, `Web header ${name}`)
            ])
        )
    );
}

function decodeBytes(data: FacetData): Uint8Array {
    if (!Array.isArray(data) || data.some((value) => typeof value !== "number")) {
        throw new TypeError("Web body must be bytes");
    }
    return new Uint8Array(data as number[]);
}
