import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { AgentCoreError } from "../../src/errors";
import {
    RecordCodec,
    canonicalTupleKey,
    decodeBase64,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson,
    hasExactJsonKeys,
    isJsonObject,
    isJsonValue,
    jsonDataParser,
    type JsonObject,
    type JsonValue,
    type RecordVersion
} from "../../src/core";

interface StringLike {
    readonly length: number;
    charCodeAt(index: number): number;
    trim(): StringLike;
}

/** A codec's own metadata without their readonly modifiers, so writes can be attempted. */
interface WritableCodec {
    kind: string;
    version: RecordVersion;
}

/** A version's own fields without their readonly modifier, so a write can be attempted. */
interface WritableVersion {
    major: number;
}

/** A value that refers to itself, which the canonical screen has to reject. */
type SelfReferentialValue = { self?: unknown };

const fixturePayload = jsonDataParser(
    (message) => new AgentCoreError("codec.invalid", `${message}; fixture payload is malformed`)
);

class FixtureRecordBase {
    public constructor(
        public readonly label: string,
        public readonly enabled: boolean
    ) {}

    public toData(): JsonValue {
        return { enabled: this.enabled, label: this.label };
    }
}

class FixtureRecord extends FixtureRecordBase {
    public constructor(label: string, enabled: boolean) {
        super(label, enabled);
        Object.freeze(this);
    }

    public static fromData(payload: JsonValue, version: RecordVersion): FixtureRecord {
        const object = fixturePayload.object(payload, "Fixture payload");
        const label = fixturePayload.string(object["label"], "Fixture payload label");
        const enabled = object["enabled"];
        if (version.minor > 0 && enabled !== true && enabled !== false) {
            throw new AgentCoreError("codec.invalid", "Fixture enabled flag is malformed");
        }
        return new FixtureRecord(label, enabled === true);
    }
}

class FixtureCodec extends RecordCodec<FixtureRecord> {
    public decodedVersion: RecordVersion | undefined;

    public constructor(version: RecordVersion = { major: 1, minor: 1 }, kind = "test.fixture") {
        super([FixtureRecord, FixtureRecordBase], kind, version);
    }

    protected encodePayload(record: FixtureRecord): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue, version: RecordVersion): FixtureRecord {
        this.decodedVersion = version;
        return FixtureRecord.fromData(payload, version);
    }
}

const codec = new FixtureCodec();

describe("Canonical codecs", () => {
    test("orders object keys recursively and deterministically", { tags: "p0" }, () => {
        const encoded = encodeCanonicalJson({ z: 1, nested: { y: 2, a: 3 }, a: 4 });

        expect(new TextDecoder().decode(encoded)).toBe('{"a":4,"nested":{"a":3,"y":2},"z":1}');
    });

    test("preserves every tuple boundary, including control characters", { tags: "p0" }, () => {
        const left = canonicalTupleKey("test.tuple", ["a", "b\u0000c"]);
        const right = canonicalTupleKey("test.tuple", ["a\u0000b", "c"]);

        expect(left).not.toBe(right);
        expect(decodeCanonicalJson(new TextEncoder().encode(left))).toEqual([
            "test.tuple",
            "a",
            "b\u0000c"
        ]);
        expect(decodeCanonicalJson(new TextEncoder().encode(right))).toEqual([
            "test.tuple",
            "a\u0000b",
            "c"
        ]);
        expect(() => canonicalTupleKey("", [])).toThrow(
            "Canonical tuple key namespace must be nonblank"
        );
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
            const extended: JsonValue[] & { extra?: boolean } = ["present"];
            extended.extra = true;
            const cycle: SelfReferentialValue = {};
            cycle.self = cycle;
            const accessor = Object.defineProperty({}, "value", {
                enumerable: true,
                get: () => "hidden"
            });
            const symbolKeyed = { value: "visible", [Symbol("hidden")]: true };
            class JsonLike {
                public readonly value = "not plain";
            }
            const hostileValues: readonly unknown[] = [
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
                Object.create(null),
                Object.create({ inherited: true })
            ];

            for (const value of hostileValues) {
                // SAFETY: every value here is outside JsonValue, which is the test — the
                // encoder screens what it is handed at runtime and must reject holes,
                // extra keys, cycles, accessors, symbols, host objects, non-finite numbers,
                // bigints, class instances, and detached or inherited prototypes alike.
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
        // `value` is the object's only own key, so the trap answers for it alone: the
        // descriptor validation reads a finite 1 and the encoder then reads Infinity.
        const nonfinite = new Proxy({ value: 1 }, { get: () => Number.POSITIVE_INFINITY });

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
        expectCodecError(() => decodeCanonicalJson(candidateBytes("{}")), "codec.invalid");
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
            const hostile: JsonObject = Object.assign(Object.create({ expected: true }), {
                extra: true
            });

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

            // SAFETY: the proxy answers JsonValue's own screen with a throwing prototype read,
            // so it can only be offered as one — and offering it is the test: the encoder must
            // surface an AgentCoreError rather than let the trap escape.
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
        expect(() => decodeBase64(candidateBase64(1))).toThrow(TypeError);
        expect(() => encodeBase64(candidateBytes([1, 2, 3]))).toThrow(TypeError);
    });

    test("reports base64 rejections verbatim", { tags: "p1" }, () => {
        expectTypeFailure(
            () => encodeBase64(candidateBytes([1, 2, 3])),
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
        const writable: WritableCodec = detached;
        const writableVersion: WritableVersion = detached.version;
        metadata.major = 9;

        expect(detached.version).toEqual({ major: 1, minor: 1 });
        expect(Object.isFrozen(detached.version)).toBe(true);
        expect(() => {
            writable.kind = "changed";
        }).toThrow(TypeError);
        expect(() => {
            writable.version = { major: 9, minor: 9 };
        }).toThrow(TypeError);
        expect(() => {
            writableVersion.major = 9;
        }).toThrow(TypeError);
        expect(detached.kind).toBe("test.fixture");
    });

    test(
        "binds codec operations against instance and base prototype redirection",
        { tags: "p0" },
        () => {
            const bound = new FixtureCodec();
            const record = new FixtureRecord("bound", true);
            const bytes = bound.encode(record);
            const baseEncode = Object.getOwnPropertyDescriptor(RecordCodec.prototype, "encode");
            const baseDecode = Object.getOwnPropertyDescriptor(RecordCodec.prototype, "decode");
            if (baseEncode === undefined || baseDecode === undefined) {
                throw new TypeError("RecordCodec operations are unavailable");
            }

            const instanceEncodeRedirected = Reflect.defineProperty(bound, "encode", {
                configurable: true,
                value: () => new Uint8Array(),
                writable: true
            });
            const instanceDecodeRedirected = Reflect.defineProperty(bound, "decode", {
                configurable: true,
                value: () => ({ label: "redirected", enabled: false }),
                writable: true
            });
            try {
                expect(instanceEncodeRedirected).toBe(false);
                expect(instanceDecodeRedirected).toBe(false);
            } finally {
                if (instanceEncodeRedirected) Reflect.deleteProperty(bound, "encode");
                if (instanceDecodeRedirected) Reflect.deleteProperty(bound, "decode");
            }

            Reflect.defineProperty(RecordCodec.prototype, "encode", {
                ...baseEncode,
                value: () => new Uint8Array()
            });
            Reflect.defineProperty(RecordCodec.prototype, "decode", {
                ...baseDecode,
                value: () => ({ label: "redirected", enabled: false })
            });
            try {
                expect(bound.encode(record)).toEqual(bytes);
                expect(bound.decode(bytes)).toEqual(record);
            } finally {
                Object.defineProperty(RecordCodec.prototype, "encode", baseEncode);
                Object.defineProperty(RecordCodec.prototype, "decode", baseDecode);
            }
        }
    );

    test("captures concrete payload operations at codec construction", { tags: "p0" }, () => {
        const bound = new FixtureCodec();
        const record = new FixtureRecord("payload-bound", true);
        const bytes = bound.encode(record);
        const prototype = FixtureCodec.prototype;
        const encodePayload = Object.getOwnPropertyDescriptor(prototype, "encodePayload");
        const decodePayload = Object.getOwnPropertyDescriptor(prototype, "decodePayload");
        if (encodePayload === undefined || decodePayload === undefined) {
            throw new TypeError("Fixture payload operations are unavailable");
        }

        Reflect.defineProperty(prototype, "encodePayload", {
            ...encodePayload,
            value: () => ({ enabled: false, label: "redirected" })
        });
        Reflect.defineProperty(prototype, "decodePayload", {
            ...decodePayload,
            value: () => ({ label: "redirected", enabled: false })
        });
        try {
            expect(bound.encode(record)).toEqual(bytes);
            expect(bound.decode(bytes)).toEqual(record);
        } finally {
            Object.defineProperty(prototype, "encodePayload", encodePayload);
            Object.defineProperty(prototype, "decodePayload", decodePayload);
        }
    });

    test("seals explicit record code without freezing built-ins", { tags: "p0" }, () => {
        const builtinDescriptors = {
            function: Object.getOwnPropertyDescriptors(Function),
            functionPrototype: Object.getOwnPropertyDescriptors(Function.prototype),
            object: Object.getOwnPropertyDescriptors(Object),
            objectPrototype: Object.getOwnPropertyDescriptors(Object.prototype)
        };
        class TupleDependency {
            public static project(label: string): string {
                return label;
            }
        }
        class TupleRecordBase {
            public static normalize(label: string): string {
                return label;
            }
            public constructor(public readonly label: string) {}
            public toData(): JsonValue {
                return TupleDependency.project(this.label);
            }
        }
        class TupleRecord extends TupleRecordBase {
            public constructor(label: string) {
                super(label);
                Object.freeze(this);
            }
            public static fromData(payload: JsonValue): TupleRecord {
                return new TupleRecord(
                    TupleRecord.normalize(fixturePayload.string(payload, "Tuple record"))
                );
            }
        }
        class ReplacementTupleRecord extends TupleRecord {}
        class ReplacementTupleDependency extends TupleDependency {}
        function LegacyRecordConstructor(): void {}
        class TupleCodec extends RecordCodec<TupleRecord> {
            public constructor(
                classes: readonly [
                    { readonly prototype: TupleRecord },
                    ...{ readonly prototype: object }[]
                ]
            ) {
                super(classes, "test.tuple", { major: 1, minor: 0 });
            }
            protected encodePayload(record: TupleRecord): JsonValue {
                return record.toData();
            }
            protected decodePayload(payload: JsonValue): TupleRecord {
                return TupleRecord.fromData(payload);
            }
        }
        class GenericTupleCodec<Value extends TupleRecord> extends RecordCodec<Value> {
            public constructor(
                classes: readonly [
                    { readonly prototype: Value },
                    ...{ readonly prototype: object }[]
                ],
                private readonly restore: (payload: JsonValue) => Value
            ) {
                super(classes, "test.generic-tuple", { major: 1, minor: 0 });
            }
            protected encodePayload(record: Value): JsonValue {
                return record.toData();
            }
            protected decodePayload(payload: JsonValue): Value {
                return this.restore(payload);
            }
        }

        expect(() => new TupleCodec([ReplacementTupleRecord, LegacyRecordConstructor])).toThrow(
            "Record codec classes must be ordinary class constructors"
        );
        expect(Object.isFrozen(ReplacementTupleRecord)).toBe(false);
        expect(Object.isFrozen(ReplacementTupleRecord.prototype)).toBe(false);

        const classes: [
            { readonly prototype: TupleRecord },
            { readonly prototype: object },
            { readonly prototype: object },
            { readonly prototype: object }
        ] = [TupleRecord, TupleRecordBase, TupleDependency, TupleDependency];
        const bound = new TupleCodec(classes);
        const record = new TupleRecord("tuple-bound");
        const bytes = bound.encode(record);
        classes[0] = ReplacementTupleRecord;
        classes[1] = ReplacementTupleDependency;

        expect(
            Reflect.defineProperty(TupleRecord, "fromData", {
                configurable: true,
                value: () => new TupleRecord("redirected")
            })
        ).toBe(false);
        expect(
            Reflect.defineProperty(TupleRecord.prototype, "toData", {
                configurable: true,
                value: () => "redirected"
            })
        ).toBe(false);
        expect(
            Reflect.defineProperty(TupleRecordBase.prototype, "toData", {
                configurable: true,
                value: () => "redirected"
            })
        ).toBe(false);
        expect(
            Reflect.defineProperty(TupleDependency, "project", {
                configurable: true,
                value: () => "redirected"
            })
        ).toBe(false);
        expect(
            Reflect.defineProperty(TupleRecordBase, "normalize", {
                configurable: true,
                value: () => "redirected"
            })
        ).toBe(false);
        expect(
            Reflect.defineProperty(TupleRecord, "normalize", {
                configurable: true,
                value: () => "redirected"
            })
        ).toBe(false);
        expect(Reflect.setPrototypeOf(TupleRecord, ReplacementTupleRecord)).toBe(false);
        expect(Reflect.setPrototypeOf(TupleRecord.prototype, {})).toBe(false);
        expect(bound.encode(record)).toEqual(bytes);
        expect(bound.decode(bytes)).toEqual(record);
        expect(Object.isFrozen(ReplacementTupleRecord)).toBe(false);
        expect(Object.isFrozen(ReplacementTupleDependency)).toBe(false);
        expect(
            () => new TupleCodec([TupleRecord, TupleRecordBase, TupleDependency, TupleDependency])
        ).not.toThrow();
        const generic = new GenericTupleCodec(
            [TupleRecord, TupleRecordBase, TupleDependency],
            TupleRecord.fromData
        );
        expect(generic.decode(generic.encode(record))).toEqual(record);
        expect(Object.isFrozen(Object)).toBe(false);
        expect(Object.isFrozen(Object.prototype)).toBe(false);
        expect(Object.isFrozen(Function)).toBe(false);
        expect(Object.isFrozen(Function.prototype)).toBe(false);
        expect(Object.isExtensible(Object)).toBe(true);
        expect(Object.isExtensible(Object.prototype)).toBe(true);
        expect(Object.isExtensible(Function)).toBe(true);
        expect(Object.isExtensible(Function.prototype)).toBe(true);
        expect(Object.getOwnPropertyDescriptors(Object)).toEqual(builtinDescriptors.object);
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(
            builtinDescriptors.objectPrototype
        );
        expect(Object.getOwnPropertyDescriptors(Function)).toEqual(builtinDescriptors.function);
        expect(Object.getOwnPropertyDescriptors(Function.prototype)).toEqual(
            builtinDescriptors.functionPrototype
        );
    });

    test("[C13-CODEC-VERSIONING] decodes and upcasts an older minor in the same major", { tags: "p2" }, () => {
        const older = encodeCanonicalJson({
            kind: "test.fixture",
            payload: { label: "legacy" },
            version: { major: 1, minor: 0 }
        });

        expect(codec.decode(older)).toEqual({ label: "legacy", enabled: false });
        expect(Object.isFrozen(codec.decodedVersion)).toBe(true);
        expect(codec.decodedVersion).toEqual({ major: 1, minor: 0 });
        expect(codec.decode(codec.encode(new FixtureRecord("current", true)))).toEqual(
            new FixtureRecord("current", true)
        );
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

    test("[C13-CODEC-VERSIONING] rejects an unknown major with its typed error", { tags: "p2" }, () => {
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

    test("[C13-CODEC-VERSIONING] rejects future minor versions and unknown envelope fields", { tags: "p2" }, () => {
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

    /**
     * `C13-CODEC-INCOMPATIBILITY-TOTAL` needs the compatibility decision to be *total*, and
     * the sampling tests above cannot show that: between them they name five version pairs,
     * and a pair the decision fails to classify is exactly the defect. This enumerates the
     * decision's domain instead of sampling it.
     *
     * The version domain is infinite, so the bound is stated and then measured rather than
     * assumed. `isEnvelope` admits a component only when it is a non-negative safe integer,
     * so the domain is `[0, 2**53 - 1]` per component and every other JSON number is itself
     * a decided rejection — the `outsideDomain` list closes that edge. Over the admitted
     * domain the outcome is claimed to factor through
     * `(sign(major - reader.major), sign(minor - reader.minor))`, nine classes, which is what
     * makes a finite grid complete rather than merely wide. The grid measures that claim by
     * requiring exactly one outcome per class across components that reach both ends of the
     * domain; it does not infer it from reading the comparisons.
     *
     * The row cannot cite this test. `C13-CODEC-INCOMPATIBILITY-TOTAL` is `planned` because
     * the record-set-level version declaration the rule also requires does not exist, and
     * `scripts/quality/ledger.mjs#validateStatus` forbids a planned row from carrying test
     * selectors. Labelling it with the atom id would be a citation the ledger never made.
     */
    test("decides every version pair in its domain with no third answer", { tags: "p1" }, () => {
        type CodecDecision =
            | { readonly kind: "accepted" }
            | { readonly kind: "rejected"; readonly code: "codec.invalid" | "codec.unknown-major" }
            | { readonly kind: "undecided"; readonly detail: string };

        // Both components sit strictly inside the domain, so every sign class is reachable.
        const reader = new FixtureCodec({ major: 3, minor: 4 });
        const payload = { enabled: true, label: "total" };
        const decide = (bytes: Uint8Array): CodecDecision => {
            try {
                reader.decode(bytes);
                return { kind: "accepted" };
            } catch (error) {
                if (!(error instanceof AgentCoreError)) {
                    return { kind: "undecided", detail: `untyped failure: ${String(error)}` };
                }
                return error.code === "codec.invalid" || error.code === "codec.unknown-major"
                    ? { kind: "rejected", code: error.code }
                    : { kind: "undecided", detail: `code outside the codec pair: ${error.code}` };
            }
        };
        const rejects = (code: string): string => JSON.stringify({ kind: "rejected", code });
        const accepts = JSON.stringify({ kind: "accepted" });

        const end = Number.MAX_SAFE_INTEGER;
        const outcomesByClass = new Map<string, Set<string>>();
        const acceptedPairs: string[] = [];
        const undecided: string[] = [];
        for (const major of [0, 1, 2, 3, 4, 5, end]) {
            for (const minor of [0, 1, 3, 4, 5, end]) {
                const decision = decide(
                    encodeCanonicalJson({
                        kind: "test.fixture",
                        payload,
                        version: { major, minor }
                    })
                );
                const signs = `${Math.sign(major - 3)},${Math.sign(minor - 4)}`;
                const outcomes = outcomesByClass.get(signs) ?? new Set<string>();
                outcomes.add(JSON.stringify(decision));
                outcomesByClass.set(signs, outcomes);
                if (decision.kind === "accepted") acceptedPairs.push(`${major}.${minor}`);
                if (decision.kind === "undecided") {
                    undecided.push(`${major}.${minor}: ${decision.detail}`);
                }
            }
        }

        // Collected first and asserted second, so one run describes the whole shape of a gap
        // rather than stopping at its first edge.
        expect(undecided).toEqual([]);
        // The measured half of the completeness argument: one outcome per sign class means
        // the decision reads nothing about a version beyond the two signs, so nine classes
        // exhaust an infinite domain.
        expect([...outcomesByClass].filter(([, outcomes]) => outcomes.size !== 1)).toEqual([]);
        expect(
            Object.fromEntries(
                [...outcomesByClass].map(([signs, outcomes]) => [signs, [...outcomes][0]])
            )
        ).toEqual({
            "-1,-1": rejects("codec.unknown-major"),
            "-1,0": rejects("codec.unknown-major"),
            "-1,1": rejects("codec.unknown-major"),
            "0,-1": accepts,
            "0,0": accepts,
            "0,1": rejects("codec.invalid"),
            "1,-1": rejects("codec.unknown-major"),
            "1,0": rejects("codec.unknown-major"),
            "1,1": rejects("codec.unknown-major")
        });
        expect(acceptedPairs).toEqual(["3.0", "3.1", "3.3", "3.4"]);
        // "accepted" has to mean the record decoded, not merely that nothing was thrown.
        expect(
            reader.decode(
                encodeCanonicalJson({
                    kind: "test.fixture",
                    payload,
                    version: { major: 3, minor: 0 }
                })
            )
        ).toEqual({ enabled: true, label: "total" });

        // The domain's complement: every input the sign grid cannot describe is still
        // decided, so no input anywhere leaves the decision undefined.
        const outsideDomain: readonly JsonValue[] = [
            { major: -1, minor: 4 },
            { major: 3, minor: -1 },
            { major: 1.5, minor: 4 },
            { major: 3, minor: 0.5 },
            { major: end + 1, minor: 4 },
            { major: 3, minor: end + 1 },
            { major: "3", minor: 4 },
            { major: true, minor: 4 },
            { major: 3 },
            { minor: 4 },
            { major: 3, minor: 4, patch: 0 },
            [3, 4],
            null,
            "3.4"
        ];
        const malformedEnvelopes: readonly Uint8Array[] = [
            new TextEncoder().encode("{"),
            // Canonical key order is part of the envelope, so unordered bytes are malformed.
            new TextEncoder().encode(
                '{"version":{"major":3,"minor":4},"kind":"test.fixture",' +
                    '"payload":{"enabled":true,"label":"total"}}'
            ),
            encodeCanonicalJson({ kind: "test.fixture", payload }),
            encodeCanonicalJson({ payload, version: { major: 3, minor: 4 } }),
            encodeCanonicalJson({ kind: "test.fixture", version: { major: 3, minor: 4 } }),
            encodeCanonicalJson({
                extra: true,
                kind: "test.fixture",
                payload,
                version: { major: 3, minor: 4 }
            }),
            encodeCanonicalJson({
                kind: "other.fixture",
                payload,
                version: { major: 3, minor: 4 }
            }),
            encodeCanonicalJson(null),
            encodeCanonicalJson([]),
            encodeCanonicalJson("record")
        ];
        const boundary = [
            ...outsideDomain.map((version) => ({
                subject: `version ${JSON.stringify(version)}`,
                decision: decide(encodeCanonicalJson({ kind: "test.fixture", payload, version }))
            })),
            ...malformedEnvelopes.map((bytes, index) => ({
                subject: `envelope ${index}`,
                decision: decide(bytes)
            }))
        ];
        // Not merely "decided": every one of these is a malformed *envelope*, so the code
        // must be `codec.invalid`. `codec.unknown-major` is reserved for a well-formed
        // envelope whose major differs, and answering it here would report a version the
        // reader does not know in place of a version it cannot read at all.
        expect(
            boundary.filter((item) => JSON.stringify(item.decision) !== rejects("codec.invalid"))
        ).toEqual([]);
    });

    test("rejects invalid codec metadata at construction", { tags: "p2" }, () => {
        const accessorVersion = Object.defineProperty({ minor: 0 }, "major", {
            enumerable: true,
            get: () => 1
        });
        const hiddenVersion = Object.defineProperty({ major: 1 }, "minor", {
            enumerable: false,
            value: 0
        });
        const invalidVersions: readonly unknown[] = [
            { major: -1, minor: 0 },
            { major: 1, minor: 0.5 },
            { extra: true, major: 1, minor: 0 },
            null,
            accessorVersion,
            hiddenVersion
        ];

        for (const version of invalidVersions) {
            // SAFETY: each value is outside RecordVersion, which is the test — the constructor
            // validates its metadata at runtime and must reject negative, fractional, extra,
            // absent, accessor-backed, and non-enumerable components alike.
            expect(() => new FixtureCodec(version as RecordVersion)).toThrow(TypeError);
        }
        for (const kind of ["", " ", " padded", "padded ", "\ud800", null]) {
            // SAFETY: the constructor declares a string kind, so the null in this list reaches
            // it only through the assertion — and reaching it is the test.
            expect(() => new FixtureCodec(undefined, kind as string)).toThrow(TypeError);
        }
    });

    test("reports canonical encoding and decoding failures verbatim", { tags: "p0" }, () => {
        // `value` is the object's only own key, so the trap answers for it alone: the
        // descriptor validation reads a finite 1 and the encoder then reads Infinity.
        const nonfinite = new Proxy({ value: 1 }, { get: () => Number.POSITIVE_INFINITY });

        expectCodecFailure(
            () => encodeCanonicalJson(candidateJson(new Date("2026-01-01T00:00:00.000Z"))),
            "codec.invalid",
            "Value is not canonical JSON data"
        );
        expectCodecFailure(
            () => encodeCanonicalJson(nonfinite),
            "codec.invalid",
            "Canonical JSON numbers must be finite"
        );
        expectCodecFailure(
            () => decodeCanonicalJson(candidateBytes("{}")),
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
            // SAFETY: the constructor declares a string kind; the absent value and the impostor
            // that only imitates the string protocol are exactly what its check must refuse.
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

        const invalidVersions: readonly unknown[] = [
            null,
            "1.0",
            new PrototypedVersion(),
            Object.create(null),
            { extra: true, major: 1, minor: 0 },
            { major: 1.5, minor: 0 },
            { major: -1, minor: 0 },
            { major: 1, minor: -1 },
            { major: 1, minor: 0.5 },
            hiddenMajor,
            hiddenMinor,
            accessorMinor
        ];

        for (const version of invalidVersions) {
            // SAFETY: each value is outside RecordVersion, which is the test — every clause of
            // the version check must answer with the same message rather than let one through.
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
        const hostileValues: readonly unknown[] = [
            null,
            undefined,
            42,
            true,
            ["Q", "Q", "=", "="],
            { length: 4, toString: () => "QQ==" },
            { length: 4 },
            new String("QQ=="),
            new String("Zm9vYmFy"),
            Object.assign(Object.create(null), { length: 4 })
        ];

        for (const hostile of hostileValues) {
            // SAFETY: every value is outside the declared string parameter, which is the test —
            // `decodeBase64` must reject each rather than coerce it through toString or length.
            expectTypeFailure(
                () => decodeBase64(hostile as string),
                "Base64 value must use canonical RFC 4648 encoding"
            );
        }
    });

    test("rejects non-Uint8Array base64 input verbatim", { tags: "p1" }, () => {
        const hostileValues: readonly unknown[] = [
            null,
            undefined,
            [1, 2, 3],
            "abc",
            new Uint16Array(2),
            new ArrayBuffer(2),
            { length: 3, 0: 1, 1: 2, 2: 3 }
        ];

        for (const hostile of hostileValues) {
            // SAFETY: every value is outside the declared Uint8Array parameter, which is the
            // test — `encodeBase64` must reject each rather than read its indexed entries.
            expectTypeFailure(
                () => encodeBase64(hostile as Uint8Array),
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
            .map((entries): JsonValue => Object.fromEntries(entries))
    )
})).value;

// Only values the public predicate already admits are legal inputs; generated lone
// surrogates and other non-JSON shapes are filtered rather than asserted on.
const canonicalValue = jsonValue.filter(isJsonValue);

// An independent canonical serializer. Key order comes from the default Array#sort,
// which the language defines as ascending UTF-16 code-unit order, so it shares no
// comparison logic with the implementation under test.
function referenceCanonicalJson(value: JsonValue): string {
    if (Array.isArray(value)) {
        return `[${value.map(referenceCanonicalJson).join(",")}]`;
    }
    if (isJsonObject(value)) {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${referenceCanonicalJson(value[key]!)}`).join(",")}}`;
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
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
        // SAFETY: forwarding an absent version is the whole reason this subclass exists — it
        // is the only way to reach RecordCodec's first version clause from outside.
        super(
            [FixtureRecord, FixtureRecordBase],
            "test.verbatim-version",
            version as RecordVersion
        );
    }

    protected encodePayload(record: FixtureRecord): JsonValue {
        return { enabled: record.enabled, label: record.label };
    }

    protected decodePayload(_payload: JsonValue, _version: RecordVersion): FixtureRecord {
        return new FixtureRecord("", false);
    }
}

class RejectingFixtureCodec extends RecordCodec<FixtureRecord> {
    public constructor(private readonly failure: Error | string) {
        super([FixtureRecord, FixtureRecordBase], "test.rejecting", { major: 1, minor: 0 });
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

/**
 * Offers a value where the base64 decoder declares a string. Refusing to coerce is the
 * behavior under test, so a non-string has to be reachable.
 */
function candidateBase64(value: string | number): string {
    // SAFETY: the value is a candidate, not a proven encoding. It reaches `decodeBase64` only
    // so the string check can reject it.
    return value as string;
}

/**
 * Offers a value where a codec declares bytes. Refusing anything that merely resembles a
 * byte sequence is the behavior under test, so those values have to be reachable.
 */
function candidateBytes(value: Uint8Array | string | readonly number[]): Uint8Array {
    // SAFETY: the value is a candidate, not proven bytes. It reaches the codec only so the
    // Uint8Array check can reject it.
    return value as Uint8Array;
}

/**
 * Offers a value where the canonical encoder declares JSON data. Screening host objects is
 * the behavior under test, so one has to be reachable.
 */
function candidateJson(value: JsonValue | Date): JsonValue {
    // SAFETY: the value is a candidate, not proven JSON data. It reaches the encoder only so
    // `isJsonValue` can reject it.
    return value as JsonValue;
}

function expectCodecError(action: () => void, code: AgentCoreError["code"]): void {
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
    action: () => void,
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

function expectTypeFailure(action: () => void, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message });
}
