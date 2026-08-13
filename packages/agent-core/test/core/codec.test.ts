import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { AgentCoreError } from "../../src/errors";
import {
    RecordCodec,
    decodeBase64,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson,
    hasExactJsonKeys,
    isJsonValue,
    type JsonValue,
    type RecordVersion
} from "../../src/core";

interface StringLike {
    readonly length: number;
    charCodeAt(index: number): number;
    trim(): StringLike;
}

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
    test("orders object keys recursively and deterministically", { tags: "p0" }, () => {
        const encoded = encodeCanonicalJson({ z: 1, nested: { y: 2, a: 3 }, a: 4 });

        expect(new TextDecoder().decode(encoded)).toBe('{"a":4,"nested":{"a":3,"y":2},"z":1}');
    });

    test("orders composed and decomposed Unicode keys by UTF-16 code units", { tags: "p0" }, () => {
        const composed = "\u00e9";
        const decomposed = "e\u0301";
        const encoded = encodeCanonicalJson({ [composed]: 1, [decomposed]: 2 });

        expect(new TextDecoder().decode(encoded)).toBe(
            `{${JSON.stringify(decomposed)}:2,${JSON.stringify(composed)}:1}`
        );
    });

    test(
        "rejects hostile, cyclic, and non-plain runtime values before encoding",
        { tags: "p0" },
        () => {
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
        }
    );

    test("rejects values that become hostile after validation", { tags: "p0" }, () => {
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

    test("rejects lone Unicode surrogates in values and keys", { tags: "p0" }, () => {
        for (const value of ["\ud800", "\ud800a", "\udc00", { "\ud800": "invalid" }]) {
            expectCodecError(() => encodeCanonicalJson(value), "codec.invalid");
        }
        expect(() => encodeCanonicalJson("\ud83d\ude00")).not.toThrow();
    });

    test("rejects JSON bytes that are valid but not canonical", { tags: "p0" }, () => {
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

    test("accepts repeated acyclic plain values", { tags: "p1" }, () => {
        const shared = { value: "shared" };

        expect(new TextDecoder().decode(encodeCanonicalJson({ left: shared, right: shared }))).toBe(
            '{"left":{"value":"shared"},"right":{"value":"shared"}}'
        );
    });

    test(
        "checks exact fields by own property rather than the prototype chain",
        { tags: "p0" },
        () => {
            const hostile = Object.assign(Object.create({ expected: true }), { extra: true }) as {
                readonly [key: string]: JsonValue;
            };

            expect(hasExactJsonKeys({ expected: true }, ["expected"])).toBe(true);
            expect(hasExactJsonKeys(hostile, ["expected"])).toBe(false);
        }
    );

    test(
        "rejects throwing proxies and accessor-backed array entries as JSON",
        { tags: "p0" },
        () => {
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

            expect(encodeCanonicalJson.bind(undefined, throwing as JsonValue)).toThrow(
                AgentCoreError
            );
            expect(encodeCanonicalJson.bind(undefined, accessor)).toThrow(AgentCoreError);
        }
    );

    test("uses canonical padded RFC 4648 base64", { tags: "p0" }, () => {
        expect(encodeBase64(new Uint8Array())).toBe("");
        expect(encodeBase64(new TextEncoder().encode("f"))).toBe("Zg==");
        expect(encodeBase64(new TextEncoder().encode("fo"))).toBe("Zm8=");
        expect(encodeBase64(new TextEncoder().encode("foo"))).toBe("Zm9v");
        expect(new TextDecoder().decode(decodeBase64("Zm9vYmFy"))).toBe("foobar");
    });

    test("rejects noncanonical and malformed base64 without coercion", { tags: "p0" }, () => {
        for (const value of ["Zg", "Zg=", "Zg===", "Zg==\n", "-w==", "AB==", "AAB="]) {
            expect(() => decodeBase64(value)).toThrow(TypeError);
        }
        expect(() => decodeBase64(1 as unknown as string)).toThrow(TypeError);
        expect(() => encodeBase64([1, 2, 3] as unknown as Uint8Array)).toThrow(TypeError);
    });

    test("reports base64 rejections verbatim", { tags: "p1" }, () => {
        expectTypeFailure(
            () => encodeBase64([1, 2, 3] as unknown as Uint8Array),
            "Base64 input must be a Uint8Array"
        );
        for (const value of ["Zg", "AB==", "AAB="]) {
            expectTypeFailure(
                () => decodeBase64(value),
                "Base64 value must use canonical RFC 4648 encoding"
            );
        }
    });

    test(
        "still rejects invalid base64 digits if runtime validation is compromised",
        { tags: "p1" },
        () => {
            const regexTest = vi.spyOn(RegExp.prototype, "test").mockReturnValue(true);
            try {
                expect(() => decodeBase64("!!!!")).toThrow(TypeError);
            } finally {
                regexTest.mockRestore();
            }
        }
    );

    test("detaches and freezes codec metadata", { tags: "p0" }, () => {
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

    test("decodes and upcasts an older minor in the same major", { tags: "p2" }, () => {
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

    test("rejects malformed data with a typed codec error", { tags: "p1" }, () => {
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

    test("wraps expected payload TypeErrors as codec failures", { tags: "p1" }, () => {
        const rejecting = new RejectingFixtureCodec(new TypeError("typed failure"));
        const encoded = rejectingRecord();

        expectCodecError(() => rejecting.decode(encoded), "codec.invalid");
    });

    test("rethrows unexpected payload decoder exceptions unchanged", { tags: "p1" }, () => {
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

    test("rejects an unknown major with its typed error", { tags: "p2" }, () => {
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

    test("rejects future minor versions and unknown envelope fields", { tags: "p2" }, () => {
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

    test("rejects negative decoded versions as malformed", { tags: "p2" }, () => {
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

    test("rejects invalid codec metadata at construction", { tags: "p2" }, () => {
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

    test("reports canonical encoding and decoding failures verbatim", { tags: "p0" }, () => {
        const nonfinite = new Proxy(
            { value: 1 },
            {
                get: (target, key, receiver) =>
                    key === "value" ? Number.POSITIVE_INFINITY : Reflect.get(target, key, receiver)
            }
        );

        expectCodecFailure(
            () => encodeCanonicalJson(new Date("2026-01-01T00:00:00.000Z") as unknown as JsonValue),
            "codec.invalid",
            "Value is not canonical JSON data"
        );
        expectCodecFailure(
            () => encodeCanonicalJson(nonfinite),
            "codec.invalid",
            "Canonical JSON numbers must be finite"
        );
        expectCodecFailure(
            () => decodeCanonicalJson("{}" as unknown as Uint8Array),
            "codec.invalid",
            "Invalid canonical JSON: Canonical JSON input must be a Uint8Array"
        );
        expectCodecFailure(
            () => decodeCanonicalJson(new TextEncoder().encode('"\\ud800"')),
            "codec.invalid",
            "Decoded value is not canonical JSON data"
        );
        expectCodecFailure(
            () => decodeCanonicalJson(new TextEncoder().encode(' {"a":1}')),
            "codec.invalid",
            "JSON bytes are not in canonical form"
        );
    });

    test(
        "holds the base64 length and digit checks when the pattern is bypassed",
        { tags: "p1" },
        () => {
            const regexTest = vi.spyOn(RegExp.prototype, "test").mockReturnValue(true);
            const failures: unknown[] = [];
            try {
                for (const value of ["!!!!", "Zg"]) {
                    try {
                        decodeBase64(value);
                    } catch (error) {
                        failures.push(error);
                    }
                }
            } finally {
                regexTest.mockRestore();
            }

            expect(failures).toHaveLength(2);
            expect(failures[0]).toBeInstanceOf(TypeError);
            expect(failures[0]).toMatchObject({
                message: "Base64 value contains an invalid digit"
            });
            expect(failures[1]).toBeInstanceOf(TypeError);
            expect(failures[1]).toMatchObject({
                message: "Base64 value must use canonical RFC 4648 encoding"
            });
        }
    );

    test(
        "pins codec metadata to nonconfigurable enumerable data properties",
        { tags: "p0" },
        () => {
            const detached = new FixtureCodec();

            expect(Object.getOwnPropertyDescriptor(detached, "kind")).toEqual({
                configurable: false,
                enumerable: true,
                value: "test.fixture",
                writable: false
            });
            expect(Object.getOwnPropertyDescriptor(detached, "version")).toEqual({
                configurable: false,
                enumerable: true,
                value: { major: 1, minor: 1 },
                writable: false
            });
        }
    );

    test("rejects codec kinds that only imitate the string protocol", { tags: "p1" }, () => {
        const impostor: StringLike = {
            length: 1,
            charCodeAt: () => 0x61,
            trim: () => impostor
        };

        for (const kind of ["", " ", " padded", "padded ", "\ud800", null, impostor]) {
            expectTypeFailure(
                () => new FixtureCodec(undefined, kind as string),
                "Record codec kind must be a nonblank canonical string"
            );
        }
    });

    test("rejects an absent codec version with the same message", { tags: "p1" }, () => {
        // FixtureCodec defaults its version parameter, so an absent version can only
        // reach RecordCodec through a subclass that forwards whatever it was handed.
        // It is the one malformed version the `typeof version !== "object"` clause has
        // to itself: every other non-object is rejected by the prototype comparison
        // that follows, which for undefined throws its own TypeError instead.
        expectTypeFailure(
            () => new VerbatimVersionCodec(undefined),
            "Record codec version must contain non-negative safe integers"
        );
    });

    test("rejects codec versions clause by clause with one message", { tags: "p1" }, () => {
        class PrototypedVersion {
            public readonly major = 1;
            public readonly minor = 0;
        }
        const hiddenMajor = Object.defineProperty({ minor: 0 }, "major", {
            enumerable: false,
            value: 1
        });
        const hiddenMinor = Object.defineProperty({ major: 1 }, "minor", {
            enumerable: false,
            value: 0
        });
        const accessorMinor = Object.defineProperty({ major: 1 }, "minor", {
            enumerable: true,
            get: () => 0
        });

        for (const version of [
            null,
            "1.0",
            new PrototypedVersion(),
            Object.create(null) as RecordVersion,
            { extra: true, major: 1, minor: 0 },
            { major: 1.5, minor: 0 },
            { major: -1, minor: 0 },
            { major: 1, minor: -1 },
            { major: 1, minor: 0.5 },
            hiddenMajor,
            hiddenMinor,
            accessorMinor
        ]) {
            expectTypeFailure(
                () => new FixtureCodec(version as RecordVersion),
                "Record codec version must contain non-negative safe integers"
            );
        }
        expect(new FixtureCodec({ major: 0, minor: 0 }).version).toEqual({ major: 0, minor: 0 });
    });

    test("reports envelope, kind, and version rejections verbatim", { tags: "p1" }, () => {
        const envelope = (value: JsonValue): Uint8Array => encodeCanonicalJson(value);

        expectCodecFailure(
            () => codec.decode(envelope({ kind: "test.fixture" })),
            "codec.invalid",
            "Record envelope is malformed"
        );
        expectCodecFailure(
            () =>
                codec.decode(envelope({ kind: 1, payload: null, version: { major: 1, minor: 1 } })),
            "codec.invalid",
            "Record envelope is malformed"
        );
        expectCodecFailure(
            () => codec.decode(envelope({ kind: "test.fixture", payload: null, version: null })),
            "codec.invalid",
            "Record envelope is malformed"
        );
        expectCodecFailure(
            () =>
                codec.decode(
                    envelope({
                        kind: "other.fixture",
                        payload: { enabled: true, label: "wrong kind" },
                        version: { major: 1, minor: 1 }
                    })
                ),
            "codec.invalid",
            "Expected record kind test.fixture"
        );
        expectCodecFailure(
            () =>
                codec.decode(
                    envelope({
                        kind: "test.fixture",
                        payload: { enabled: true, label: "future" },
                        version: { major: 1, minor: 2 }
                    })
                ),
            "codec.invalid",
            "Unsupported test.fixture codec minor 2"
        );
        expectCodecFailure(
            () =>
                codec.decode(
                    envelope({
                        kind: "test.fixture",
                        payload: { enabled: true, label: "future" },
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.unknown-major",
            "Unsupported test.fixture codec major 2"
        );
    });
});

describe("JSON value classification", () => {
    test("accepts and rejects Unicode scalar boundaries in values and keys", { tags: "p0" }, () => {
        for (const value of [
            "\ud800\udc00",
            "\ud800\udfff",
            "\udbff\udc00",
            "\udbff\udfff",
            "\ud83d\ude00",
            "\ud7ff",
            "\ue000",
            ""
        ]) {
            expect(isJsonValue(value)).toBe(true);
            expect(isJsonValue({ [value]: value })).toBe(true);
        }
        for (const value of [
            "\ud800",
            "\udbff",
            "\udc00",
            "\udfff",
            "\ud800a",
            "\ud800\ue000",
            "\udc00\udc00",
            "\udfff\udfff"
        ]) {
            expect(isJsonValue(value)).toBe(false);
            expect(isJsonValue({ [value]: 1 })).toBe(false);
        }
    });

    test("rejects containers whose entries are not plain enumerable data", { tags: "p0" }, () => {
        const detachedPrototype = [1, 2];
        Object.setPrototypeOf(detachedPrototype, null);
        const hiddenIndex = ["visible"];
        Object.defineProperty(hiddenIndex, "0", {
            configurable: true,
            enumerable: false,
            value: 1,
            writable: true
        });
        const hiddenKey = Object.defineProperty({}, "hidden", {
            configurable: true,
            enumerable: false,
            value: 1,
            writable: true
        });
        const hostile = new Proxy(
            {},
            {
                getPrototypeOf: () => {
                    throw new TypeError("hostile prototype");
                }
            }
        );

        expect(isJsonValue(detachedPrototype)).toBe(false);
        expect(isJsonValue(hiddenIndex)).toBe(false);
        expect(isJsonValue(hiddenKey)).toBe(false);
        expect(isJsonValue(hostile)).toBe(false);
    });
});

describe("Canonical value properties", () => {
    test(
        "serializes every value exactly as an independent canonical serializer does",
        { tags: "p0" },
        () => {
            fc.assert(
                fc.property(canonicalValue, (value) => {
                    expect(new TextDecoder().decode(encodeCanonicalJson(value))).toBe(
                        referenceCanonicalJson(value)
                    );
                }),
                { numRuns: 500 }
            );
        }
    );

    test(
        "reorders sibling keys into code-unit order whatever order they were built in",
        { tags: "p0" },
        () => {
            fc.assert(
                fc.property(
                    fc.uniqueArray(jsonKey, { minLength: 2, maxLength: 8 }),
                    canonicalValue,
                    (keys, leaf) => {
                        const forward = Object.fromEntries(keys.map((key) => [key, leaf]));
                        const reversed = Object.fromEntries(
                            [...keys].reverse().map((key) => [key, leaf])
                        );
                        fc.pre(isJsonValue(forward));

                        expect(encodeCanonicalJson(reversed)).toStrictEqual(
                            encodeCanonicalJson(forward)
                        );
                        expect(new TextDecoder().decode(encodeCanonicalJson(forward))).toBe(
                            referenceCanonicalJson(forward)
                        );
                    }
                ),
                { numRuns: 500 }
            );
        }
    );

    test("round-trips every canonical value through its encoding", { tags: "p0" }, () => {
        fc.assert(
            fc.property(canonicalValue, (value) => {
                const encoded = encodeCanonicalJson(value);
                const decoded = decodeCanonicalJson(encoded);

                expect(encodeCanonicalJson(decoded)).toStrictEqual(encoded);
                expect(referenceCanonicalJson(decoded)).toBe(referenceCanonicalJson(value));
            }),
            { numRuns: 500 }
        );
    });

    test(
        "accepts bytes only when they are exactly the canonical form of what they decode to",
        { tags: "p0" },
        () => {
            fc.assert(
                fc.property(hostileJsonBytes(), (candidate) => {
                    let decoded: JsonValue;
                    try {
                        decoded = decodeCanonicalJson(candidate);
                    } catch (error) {
                        expect(error).toBeInstanceOf(AgentCoreError);
                        expect(error).toMatchObject({ code: "codec.invalid" });
                        return;
                    }
                    expect(encodeCanonicalJson(decoded)).toStrictEqual(candidate);
                }),
                { numRuns: 1000 }
            );
        }
    );

    test("round-trips every byte string through its base64 encoding", { tags: "p0" }, () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), (value) => {
                const encoded = encodeBase64(value);

                expect(encoded.length % 4).toBe(0);
                expect(decodeBase64(encoded)).toStrictEqual(value);
            }),
            { numRuns: 1000 }
        );
    });

    test(
        "accepts base64 only when it is exactly the encoding of what it decodes to",
        { tags: "p0" },
        () => {
            fc.assert(
                fc.property(hostileBase64(), (candidate) => {
                    let decoded: Uint8Array;
                    try {
                        decoded = decodeBase64(candidate);
                    } catch (error) {
                        expect(error).toBeInstanceOf(TypeError);
                        return;
                    }
                    expect(encodeBase64(decoded)).toBe(candidate);
                }),
                { numRuns: 2000 }
            );
        }
    );

    test("rejects non-string base64 input verbatim, without coercing it", { tags: "p1" }, () => {
        for (const hostile of [
            null,
            undefined,
            42,
            true,
            ["Q", "Q", "=", "="],
            { length: 4, toString: () => "QQ==" },
            { length: 4 },
            new String("QQ=="),
            new String("Zm9vYmFy"),
            Object.assign(Object.create(null) as object, { length: 4 })
        ]) {
            expectTypeFailure(
                () => decodeBase64(hostile as unknown as string),
                "Base64 value must use canonical RFC 4648 encoding"
            );
        }
    });

    test("rejects non-Uint8Array base64 input verbatim", { tags: "p1" }, () => {
        for (const hostile of [
            null,
            undefined,
            [1, 2, 3],
            "abc",
            new Uint16Array(2),
            new ArrayBuffer(2),
            { length: 3, 0: 1, 1: 2, 2: 3 }
        ]) {
            expectTypeFailure(
                () => encodeBase64(hostile as unknown as Uint8Array),
                "Base64 input must be a Uint8Array"
            );
        }
    });
});

// Keys chosen to collide with prototype machinery and to straddle the boundaries
// of UTF-16 code-unit ordering, where canonical key order is easiest to get wrong.
const hostileKeys = [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "",
    "a",
    "A",
    "Z",
    "z",
    "[",
    "é",
    "é",
    "\u{1f600}",
    "ﬃ"
] as const;

const jsonKey = fc.oneof(fc.constantFrom(...hostileKeys), fc.string());

const jsonValue = fc.letrec<{ value: JsonValue }>((tie) => ({
    value: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constant(null),
        fc.boolean(),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.string(),
        fc.constantFrom(...hostileKeys),
        fc.array(tie("value"), { maxLength: 6 }),
        fc
            .array(fc.tuple(jsonKey, tie("value")), { maxLength: 6 })
            // Object.fromEntries defines own data properties, so "__proto__" stays
            // a real key instead of reassigning the prototype.
            .map((entries) => Object.fromEntries(entries) as JsonValue)
    )
})).value;

// Only values the public predicate already admits are legal inputs; generated lone
// surrogates and other non-JSON shapes are filtered rather than asserted on.
const canonicalValue = jsonValue.filter(isJsonValue);

// An independent canonical serializer. Key order comes from the default Array#sort,
// which the language defines as ascending UTF-16 code-unit order, so it shares no
// comparison logic with the implementation under test.
function referenceCanonicalJson(value: JsonValue): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(referenceCanonicalJson).join(",")}]`;
    }
    const record = value as { readonly [key: string]: JsonValue };
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${referenceCanonicalJson(record[key]!)}`).join(",")}}`;
}

// Canonical encodings, near-misses of them, and free-form bytes, so the totality
// properties see far more accepted inputs than uniform random bytes would yield.
function hostileJsonBytes(): fc.Arbitrary<Uint8Array> {
    const canonical = canonicalValue.map(encodeCanonicalJson);
    const perturbed = fc
        .tuple(canonical, fc.nat(), fc.nat({ max: 255 }), fc.nat({ max: 3 }))
        .map(([encoded, position, byte, operation]) => {
            if (encoded.length === 0) return encoded;
            const index = position % encoded.length;
            switch (operation) {
                case 0:
                    return encoded.slice(0, index);
                case 1: {
                    const flipped = new Uint8Array(encoded);
                    flipped[index] = byte;
                    return flipped;
                }
                case 2:
                    return new TextEncoder().encode(` ${new TextDecoder().decode(encoded)}`);
                default:
                    return new Uint8Array([...encoded, byte]);
            }
        });
    const looseJson = jsonValue.map((value) =>
        new TextEncoder().encode(JSON.stringify(value, null, 1))
    );
    return fc.oneof(canonical, perturbed, looseJson, fc.uint8Array({ maxLength: 24 }));
}

function hostileBase64(): fc.Arbitrary<string> {
    const canonical = fc.uint8Array({ maxLength: 32 }).map(encodeBase64);
    const perturbed = fc
        .tuple(canonical, fc.nat(), fc.constantFrom("A", "B", "=", "/", "+", "-", "\n", "0", ""))
        .map(([encoded, position, character]) => {
            if (encoded.length === 0) return character;
            const index = position % encoded.length;
            return `${encoded.slice(0, index)}${character}${encoded.slice(index + 1)}`;
        });
    const truncated = fc
        .tuple(canonical, fc.nat())
        .map(([encoded, position]) =>
            encoded.length === 0 ? encoded : encoded.slice(0, position % encoded.length)
        );
    const padded = fc
        .tuple(canonical, fc.nat({ max: 4 }))
        .map(([encoded, count]) => `${encoded}${"=".repeat(count)}`);
    return fc.oneof(
        canonical,
        perturbed,
        truncated,
        padded,
        fc.string({ unit: fc.constantFrom("A", "B", "z", "9", "+", "/", "=", "!") })
    );
}

class VerbatimVersionCodec extends RecordCodec<FixtureRecord> {
    public constructor(version: RecordVersion | undefined) {
        super("test.verbatim-version", version as RecordVersion);
    }

    protected encodePayload(record: FixtureRecord): JsonValue {
        return { enabled: record.enabled, label: record.label };
    }

    protected decodePayload(_payload: JsonValue, _version: RecordVersion): FixtureRecord {
        return { label: "", enabled: false };
    }
}

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

function expectCodecFailure(
    action: () => unknown,
    code: AgentCoreError["code"],
    message: string
): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentCoreError);
    expect(thrown).toMatchObject({ code, message });
}

function expectTypeFailure(action: () => unknown, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message });
}
