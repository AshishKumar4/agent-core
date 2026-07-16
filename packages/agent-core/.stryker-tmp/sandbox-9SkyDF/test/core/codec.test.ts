// @ts-nocheck
import { describe, expect, test, vi } from "vitest";
import { AgentCoreError } from "../../src/errors";
import {
    RecordCodec,
    decodeBase64,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue,
    type RecordVersion
} from "../../src/core";

interface FixtureRecord {
    readonly label: string;
    readonly enabled: boolean;
}

class FixtureCodec extends RecordCodec<FixtureRecord> {
    public decodedVersion: RecordVersion | undefined;

    public constructor(version: RecordVersion = { major: 1, minor: 1 }, kind = "test.fixture") {
        super(kind, version);
    }

    protected encodePayload(record: FixtureRecord): JsonValue {
        return { enabled: record.enabled, label: record.label };
    }

    protected decodePayload(payload: JsonValue, version: RecordVersion): FixtureRecord {
        this.decodedVersion = version;
        if (!isObject(payload) || typeof payload["label"] !== "string") {
            throw new AgentCoreError("codec.invalid", "Fixture payload is malformed");
        }
        const enabled = payload["enabled"];
        if (version.minor > 0 && typeof enabled !== "boolean") {
            throw new AgentCoreError("codec.invalid", "Fixture enabled flag is malformed");
        }
        return {
            label: payload["label"],
            enabled: typeof enabled === "boolean" ? enabled : false
        };
    }
}

const codec = new FixtureCodec();

describe("Canonical codecs", () => {
    test("orders object keys recursively and deterministically", () => {
        const encoded = encodeCanonicalJson({ z: 1, nested: { y: 2, a: 3 }, a: 4 });

        expect(new TextDecoder().decode(encoded)).toBe('{"a":4,"nested":{"a":3,"y":2},"z":1}');
    });

    test("orders composed and decomposed Unicode keys by UTF-16 code units", () => {
        const composed = "\u00e9";
        const decomposed = "e\u0301";
        const encoded = encodeCanonicalJson({ [composed]: 1, [decomposed]: 2 });

        expect(new TextDecoder().decode(encoded)).toBe(
            `{${JSON.stringify(decomposed)}:2,${JSON.stringify(composed)}:1}`
        );
    });

    test("rejects hostile, cyclic, and non-plain runtime values before encoding", () => {
        const sparse: JsonValue[] = ["present"];
        sparse.length = 2;
        const extended = ["present"] as JsonValue[] & { extra?: boolean };
        extended.extra = true;
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        const accessor = Object.defineProperty({}, "value", {
            enumerable: true,
            get: () => "hidden"
        });
        const symbolKeyed = { value: "visible", [Symbol("hidden")]: true };
        class JsonLike {
            public readonly value = "not plain";
        }

        for (const value of [
            sparse,
            extended,
            cycle,
            accessor,
            symbolKeyed,
            new Date("2026-01-01T00:00:00.000Z"),
            new Uint8Array([1, 2, 3]),
            Number.NaN,
            Number.POSITIVE_INFINITY,
            1n,
            new JsonLike(),
            Object.create(null) as object,
            Object.create({ inherited: true }) as object
        ]) {
            expectCodecError(() => encodeCanonicalJson(value as JsonValue), "codec.invalid");
        }
    });

    test("rejects values that become hostile after validation", () => {
        let ownKeysCalls = 0;
        const throwing = new Proxy(
            { value: 1 },
            {
                ownKeys: (target) => {
                    ownKeysCalls += 1;
                    if (ownKeysCalls > 1) throw "hostile ownKeys";
                    return Reflect.ownKeys(target);
                }
            }
        );
        const nonfinite = new Proxy(
            { value: 1 },
            {
                get: (target, key, receiver) =>
                    key === "value" ? Number.POSITIVE_INFINITY : Reflect.get(target, key, receiver)
            }
        );

        expectCodecError(() => encodeCanonicalJson(throwing), "codec.invalid");
        expectCodecError(() => encodeCanonicalJson(nonfinite), "codec.invalid");
    });

    test("rejects lone Unicode surrogates in values and keys", () => {
        for (const value of ["\ud800", "\ud800a", "\udc00", { "\ud800": "invalid" }]) {
            expectCodecError(() => encodeCanonicalJson(value), "codec.invalid");
        }
        expect(() => encodeCanonicalJson("\ud83d\ude00")).not.toThrow();
    });

    test("rejects JSON bytes that are valid but not canonical", () => {
        for (const source of [
            ' {"a":1}',
            '{"b":2,"a":1}',
            '{"a":1.0}',
            '{"a":1,"a":1}',
            '{"a":-0}',
            '{"\\u0061":1}',
            '{"a":1}\n'
        ]) {
            expectCodecError(
                () => decodeCanonicalJson(new TextEncoder().encode(source)),
                "codec.invalid"
            );
        }
        expectCodecError(() => decodeCanonicalJson(Uint8Array.of(0xc3, 0x28)), "codec.invalid");
        expectCodecError(() => decodeCanonicalJson("{}" as unknown as Uint8Array), "codec.invalid");
        expectCodecError(
            () => decodeCanonicalJson(new TextEncoder().encode('"\\ud800"')),
            "codec.invalid"
        );
    });

    test("accepts repeated acyclic plain values", () => {
        const shared = { value: "shared" };

        expect(new TextDecoder().decode(encodeCanonicalJson({ left: shared, right: shared }))).toBe(
            '{"left":{"value":"shared"},"right":{"value":"shared"}}'
        );
    });

    test("checks exact fields by own property rather than the prototype chain", () => {
        const hostile = Object.assign(Object.create({ expected: true }), { extra: true }) as {
            readonly [key: string]: JsonValue;
        };

        expect(hasExactJsonKeys({ expected: true }, ["expected"])).toBe(true);
        expect(hasExactJsonKeys(hostile, ["expected"])).toBe(false);
    });

    test("rejects throwing proxies and accessor-backed array entries as JSON", () => {
        const throwing = new Proxy(
            {},
            {
                getPrototypeOf: () => {
                    throw new TypeError("hostile prototype");
                }
            }
        );
        const accessor: JsonValue[] = [];
        Object.defineProperty(accessor, "0", {
            enumerable: true,
            get: () => "hidden"
        });

        expect(encodeCanonicalJson.bind(undefined, throwing as JsonValue)).toThrow(AgentCoreError);
        expect(encodeCanonicalJson.bind(undefined, accessor)).toThrow(AgentCoreError);
    });

    test("uses canonical padded RFC 4648 base64", () => {
        expect(encodeBase64(new Uint8Array())).toBe("");
        expect(encodeBase64(new TextEncoder().encode("f"))).toBe("Zg==");
        expect(encodeBase64(new TextEncoder().encode("fo"))).toBe("Zm8=");
        expect(encodeBase64(new TextEncoder().encode("foo"))).toBe("Zm9v");
        expect(new TextDecoder().decode(decodeBase64("Zm9vYmFy"))).toBe("foobar");
    });

    test("rejects noncanonical and malformed base64 without coercion", () => {
        for (const value of ["Zg", "Zg=", "Zg===", "Zg==\n", "-w==", "AB==", "AAB="]) {
            expect(() => decodeBase64(value)).toThrow(TypeError);
        }
        expect(() => decodeBase64(1 as unknown as string)).toThrow(TypeError);
        expect(() => encodeBase64([1, 2, 3] as unknown as Uint8Array)).toThrow(TypeError);
    });

    test("still rejects invalid base64 digits if runtime validation is compromised", () => {
        const regexTest = vi.spyOn(RegExp.prototype, "test").mockReturnValue(true);
        try {
            expect(() => decodeBase64("!!!!")).toThrow(TypeError);
        } finally {
            regexTest.mockRestore();
        }
    });

    test("detaches and freezes codec metadata", () => {
        const metadata = { major: 1, minor: 1 };
        const detached = new FixtureCodec(metadata);
        metadata.major = 9;

        expect(detached.version).toEqual({ major: 1, minor: 1 });
        expect(Object.isFrozen(detached.version)).toBe(true);
        expect(() => {
            (detached as { kind: string }).kind = "changed";
        }).toThrow(TypeError);
        expect(() => {
            (detached as { version: RecordVersion }).version = { major: 9, minor: 9 };
        }).toThrow(TypeError);
        expect(() => {
            (detached.version as { major: number }).major = 9;
        }).toThrow(TypeError);
        expect(detached.kind).toBe("test.fixture");
    });

    test("decodes and upcasts an older minor in the same major", () => {
        const older = encodeCanonicalJson({
            kind: "test.fixture",
            payload: { label: "legacy" },
            version: { major: 1, minor: 0 }
        });

        expect(codec.decode(older)).toEqual({ label: "legacy", enabled: false });
        expect(Object.isFrozen(codec.decodedVersion)).toBe(true);
        expect(codec.decodedVersion).toEqual({ major: 1, minor: 0 });
        expect(codec.decode(codec.encode({ label: "current", enabled: true }))).toEqual({
            label: "current",
            enabled: true
        });
    });

    test("rejects malformed data with a typed codec error", () => {
        expectCodecError(() => codec.decode(new TextEncoder().encode("{")), "codec.invalid");
        expectCodecError(
            () => codec.decode(encodeCanonicalJson({ kind: "test.fixture" })),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                codec.decode(
                    encodeCanonicalJson({
                        kind: "test.fixture",
                        payload: { enabled: true },
                        version: { major: 1, minor: 1 }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                codec.decode(
                    encodeCanonicalJson({
                        kind: "other.fixture",
                        payload: { enabled: true, label: "wrong kind" },
                        version: { major: 1, minor: 1 }
                    })
                ),
            "codec.invalid"
        );
        for (const envelope of [null, [], true, "record"]) {
            expectCodecError(() => codec.decode(encodeCanonicalJson(envelope)), "codec.invalid");
        }
    });

    test("wraps expected payload TypeErrors as codec failures", () => {
        const rejecting = new RejectingFixtureCodec(new TypeError("typed failure"));
        const encoded = rejectingRecord();

        expectCodecError(() => rejecting.decode(encoded), "codec.invalid");
    });

    test("rethrows unexpected payload decoder exceptions unchanged", () => {
        for (const failure of [new RangeError("programmer failure"), "string failure"]) {
            const rejecting = new RejectingFixtureCodec(failure);
            let thrown: unknown;
            try {
                rejecting.decode(rejectingRecord());
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBe(failure);
        }
    });

    test("rejects an unknown major with its typed error", () => {
        const future = encodeCanonicalJson({
            kind: "test.fixture",
            payload: { enabled: true, label: "future" },
            version: { major: 2, minor: 0 }
        });

        expectCodecError(() => codec.decode(future), "codec.unknown-major");
        expectCodecError(
            () =>
                codec.decode(
                    encodeCanonicalJson({
                        kind: "test.fixture",
                        payload: null,
                        version: { major: 0, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
    });

    test("rejects future minor versions and unknown envelope fields", () => {
        const futureMinor = encodeCanonicalJson({
            kind: "test.fixture",
            payload: { enabled: true, label: "future" },
            version: { major: 1, minor: 2 }
        });
        const extraEnvelopeField = encodeCanonicalJson({
            extra: true,
            kind: "test.fixture",
            payload: { enabled: true, label: "extra" },
            version: { major: 1, minor: 1 }
        });
        const extraVersionField = encodeCanonicalJson({
            kind: "test.fixture",
            payload: { enabled: true, label: "extra" },
            version: { major: 1, minor: 1, patch: 0 }
        });

        expectCodecError(() => codec.decode(futureMinor), "codec.invalid");
        expectCodecError(() => codec.decode(extraEnvelopeField), "codec.invalid");
        expectCodecError(() => codec.decode(extraVersionField), "codec.invalid");
    });

    test("rejects negative decoded versions as malformed", () => {
        for (const version of [
            { major: -1, minor: 0 },
            { major: 1, minor: -1 }
        ]) {
            const invalid = encodeCanonicalJson({
                kind: "test.fixture",
                payload: { enabled: true, label: "invalid" },
                version
            });

            expectCodecError(() => codec.decode(invalid), "codec.invalid");
        }
    });

    test("rejects invalid codec metadata at construction", () => {
        for (const version of [
            { major: -1, minor: 0 },
            { major: 1, minor: 0.5 },
            { extra: true, major: 1, minor: 0 },
            null
        ]) {
            expect(() => new FixtureCodec(version as RecordVersion)).toThrow(TypeError);
        }
        for (const kind of ["", " ", " padded", "padded ", "\ud800", null]) {
            expect(() => new FixtureCodec(undefined, kind as string)).toThrow(TypeError);
        }
        const accessorVersion = Object.defineProperty({ minor: 0 }, "major", {
            enumerable: true,
            get: () => 1
        });
        const hiddenVersion = Object.defineProperty({ major: 1 }, "minor", {
            enumerable: false,
            value: 0
        });
        expect(() => new FixtureCodec(accessorVersion as RecordVersion)).toThrow(TypeError);
        expect(() => new FixtureCodec(hiddenVersion as RecordVersion)).toThrow(TypeError);
    });
});

class RejectingFixtureCodec extends RecordCodec<FixtureRecord> {
    public constructor(private readonly failure: unknown) {
        super("test.rejecting", { major: 1, minor: 0 });
    }

    protected encodePayload(_record: FixtureRecord): JsonValue {
        return null;
    }

    protected decodePayload(_payload: JsonValue, _version: RecordVersion): FixtureRecord {
        throw this.failure;
    }
}

function rejectingRecord(): Uint8Array {
    return encodeCanonicalJson({
        kind: "test.rejecting",
        payload: null,
        version: { major: 1, minor: 0 }
    });
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec to reject input");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error).toMatchObject({ code });
    }
}
