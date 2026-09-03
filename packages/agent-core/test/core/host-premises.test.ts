import { expect, test } from "vitest";
import {
    JsonSchema,
    decodeBase64,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonString,
    type JsonValue
} from "../../src/core";
import { JsonPointer } from "../../src/facets";
import { RecordCodec } from "../../src/core/codec";
import { AgentCoreError } from "../../src/errors";

/**
 * The external facts `artifacts/quality/heuristic-register.json` names as premises, written
 * down as assertions.
 *
 * A bare `catch`, an ambient clock and a text-shape test each answer a domain question from
 * something this codebase does not declare: what a decoder does with malformed bytes, what a
 * host primitive throws, whether a timer may fire early, what `Function.prototype.toString`
 * returns for a class. Every one of those answers is right today and none of them is stated
 * anywhere the compiler or a reviewer can see. The register names each as a premise; this
 * file is the evidence those premises cite, so a runtime or a standard-library change that
 * breaks one fails here by name rather than turning a `catch` block into a wrong answer.
 *
 * These are premises, not preferences: nothing here asserts that the kernel *should* behave
 * this way. Each test asserts only what the register claims the kernel is entitled to rely
 * on, and each is falsifiable on its own.
 */

class Probe {
    public constructor(public readonly value: string) {
        if (value.length === 0) throw new TypeError("Probe value must not be empty");
        Object.freeze(this);
    }
}

class ProbeCodec extends RecordCodec<Probe> {
    public constructor() {
        super([Probe], "quality-probe", { major: 1, minor: 0 });
    }

    protected encodePayload(record: Probe): string {
        return record.value;
    }

    protected decodePayload(payload: JsonValue): Probe {
        if (!isJsonString(payload)) throw new TypeError("Probe payload must be a string");
        return new Probe(payload);
    }
}

test(
    "a kernel decoder refuses malformed input and returns for well-formed input",
    { tags: "p0" },
    () => {
        // Every bare `catch` around one of these decoders answers "the input is malformed".
        // That answer is only sound because malformed input is the one thing they refuse.
        expect(decodeBase64("AQID")).toEqual(Uint8Array.of(1, 2, 3));
        expect(() => decodeBase64("A")).toThrow();
        expect(() => decodeBase64("****")).toThrow();

        expect(decodeCanonicalJson(encodeCanonicalJson({ a: 1 }))).toEqual({ a: 1 });
        expect(() => decodeCanonicalJson(new TextEncoder().encode("{"))).toThrow(AgentCoreError);
        expect(() => decodeCanonicalJson(new TextEncoder().encode('{"b":1,"a":2}'))).toThrow(
            AgentCoreError
        );

        const codec = new ProbeCodec();
        expect(codec.decode(codec.encode(new Probe("held"))).value).toBe("held");
        expect(() => codec.decode(new TextEncoder().encode("not a record"))).toThrow(
            AgentCoreError
        );
    }
);

test("a host primitive refuses exactly its malformed input", { tags: "p0" }, () => {
    // ECMA-262 §25.5.1 (JSON.parse), WHATWG Encoding §TextDecoder with `fatal`, and WHATWG
    // URL §constructor each specify a throw for input they cannot parse, and specify no
    // other failure for a well-formed argument.
    expect(JSON.parse('{"a":1}')).toEqual({ a: 1 });
    expect(() => JSON.parse("{")).toThrow(SyntaxError);

    const fatal = new TextDecoder("utf-8", { fatal: true });
    expect(fatal.decode(Uint8Array.of(0x61))).toBe("a");
    expect(() => fatal.decode(Uint8Array.of(0xff))).toThrow(TypeError);

    expect(new URL("https://example.test/a").pathname).toBe("/a");
    expect(() => new URL("not a url")).toThrow(TypeError);

    expect(atob("YQ==")).toBe("a");
    expect(() => atob("*")).toThrow();
});

test("releasing an already-released host resource is a no-op", { tags: "p1" }, () => {
    // The premise every `closeQuietly`-shaped block rests on: a release the host has
    // already performed leaves the resource in the state the caller asked for, so a
    // second release cannot mean something the caller has to handle differently.
    const controller = new AbortController();
    controller.abort();
    const first = controller.signal.reason;
    expect(controller.signal.aborted).toBe(true);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(first);
});

test("a cleanup failure never replaces the in-flight cause", { tags: "p0" }, () => {
    // Nested failure handling relies on two ECMAScript guarantees: a throw caught inside a
    // `catch` block does not disturb the pending cause the block goes on to rethrow, and a
    // `finally` that completes normally leaves the in-flight completion alone.
    const original = new TypeError("original cause");
    let rethrown: Error | undefined;
    try {
        try {
            throw original;
        } catch (cause) {
            try {
                throw new RangeError("cleanup failed");
            } catch {
                // Exactly the shape the register binds: the cleanup failure is dropped here
                // so the cause below is the one the caller sees.
            }
            throw cause;
        }
    } catch (surfaced) {
        rethrown = surfaced instanceof Error ? surfaced : undefined;
    }
    expect(rethrown).toBe(original);

    let ran = false;
    expect(() => {
        try {
            throw original;
        } finally {
            ran = true;
        }
    }).toThrow(original);
    expect(ran).toBe(true);
});

test("a timer does not fire before its delay has elapsed", { tags: "p1" }, async () => {
    // HTML §8.6 "Timers" states the task is queued after *at least* the requested wait, so
    // a deadline built on `setTimeout` cannot expire early. This is the one test here that
    // must use the real clock: a fake timer would assert the test runner's own scheduler,
    // and the premise being pinned is the platform's, so replacing the wait would measure
    // the wrong thing. `Date.now` has millisecond resolution, so the assertion allows
    // exactly one millisecond of rounding and nothing more: firing genuinely early fails.
    const delayMs = 25;
    const started = Date.now();
    await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(delayMs - 1);
});

test("absence of an optional host member is discovered by attempting it", { tags: "p2" }, () => {
    // The premise behind a probe-shaped `catch`: for a host object there is no declaration
    // to read, so attempting the access and refusing the failure is the question, not an
    // error path. Reading a missing member is silent; calling it is what reports absence.
    interface OptionalHost {
        readonly present: () => string;
        readonly absent?: () => string;
    }
    const host: OptionalHost = { present: () => "here" };
    expect(host.absent).toBeUndefined();
    let answered = "unknown";
    try {
        // SAFETY: calling a member the host may not provide is the probe itself, so the
        // absent case is reached deliberately through the declared optional shape.
        (host.absent as () => string)();
    } catch {
        answered = "absent";
    }
    expect(answered).toBe("absent");
});

test("a class constructor is distinguishable only by host reflection", { tags: "p1" }, () => {
    // ECMA-262 §20.2.3.5 makes `Function.prototype.toString` return the source text of a
    // class constructor, which is why it begins with `class`; §15.7.14 gives a class's
    // `prototype` non-writable, non-enumerable, non-configurable attributes where
    // MakeConstructor gives an ordinary function's a writable one. `isOrdinaryRecordClass`
    // reads the first of those, so both halves are pinned here: if a runtime ever stops
    // agreeing, the codec's class check is what breaks, and this is where it shows.
    const source = Function.prototype.toString;
    expect(source.call(Probe).startsWith("class")).toBe(true);
    expect(source.call(function ordinary() {}).startsWith("class")).toBe(false);
    expect(source.call(() => 1).startsWith("class")).toBe(false);

    expect(Object.getOwnPropertyDescriptor(Probe, "prototype")).toMatchObject({
        configurable: false,
        enumerable: false,
        writable: false
    });
    expect(Object.getOwnPropertyDescriptor(function ordinary() {}, "prototype")).toMatchObject({
        writable: true
    });
    expect(Object.getOwnPropertyDescriptor(() => 1, "prototype")).toBeUndefined();
});

test("base64 padding declares the decoded byte length", { tags: "p1" }, () => {
    // RFC 4648 §4: a quantum ending `==` carries one byte, `=` two, and none three. The
    // decoder reads the byte count off the padding, which is the encoding's own syntax and
    // not an inference about the text; this pins the mapping the arithmetic depends on.
    expect(decodeBase64("AQ==")).toEqual(Uint8Array.of(1));
    expect(decodeBase64("AQI=")).toEqual(Uint8Array.of(1, 2));
    expect(decodeBase64("AQID")).toEqual(Uint8Array.of(1, 2, 3));
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
});

test("containment in a solidus syntax needs the separator", { tags: "p0" }, () => {
    // RFC 6901 §3 for JSON Pointers and POSIX.1-2017 §4.13 for pathnames both make `/` the
    // component separator, so one name contains another only when the prefix ends at a
    // separator. Testing the bare prefix is the classic sibling bug — `/a/bc` is not inside
    // `/a/b` — and every containment test in the kernel appends the separator for exactly
    // this reason. This is the property those sites rely on, stated once.
    const contains = (owner: string, candidate: string): boolean =>
        candidate === owner || candidate.startsWith(`${owner}/`);
    expect(contains("/a/b", "/a/b")).toBe(true);
    expect(contains("/a/b", "/a/b/c")).toBe(true);
    expect(contains("/a/b", "/a/bc")).toBe(false);
    expect("/a/bc".startsWith("/a/b")).toBe(true);

    expect(new JsonPointer("").tokens).toEqual([]);
    expect(new JsonPointer("/a/b").tokens).toEqual(["a", "b"]);
    expect(() => new JsonPointer("a")).toThrow(TypeError);
    expect(() => new JsonPointer("/~2")).toThrow(TypeError);
});

test("a JSON Schema reference this kernel resolves is fragment-only", { tags: "p1" }, () => {
    // JSON Schema core §8.2.3: a `$ref` beginning `#` is resolved inside the current
    // document. Anything else names another document, which this kernel does not fetch, so
    // the leading `#` is the declared syntax the check reads rather than a guess about the
    // string. A remote reference is refused rather than silently resolved as local.
    expect(new JsonSchema({ $ref: "#/$defs/held", $defs: { held: { type: "integer" } } })).toBeInstanceOf(
        JsonSchema
    );
    expect(() =>
        new JsonSchema({ $ref: "https://example.test/remote.json" }).accepts(1, {
            validate: () => true
        })
    ).toThrow(/Remote JSON Schema reference/);
});

test("a transport port is a sixteen-bit field", { tags: "p2" }, () => {
    // RFC 9293 §3.1 gives the TCP header a 16-bit port field, so 65535 is the transport's
    // ceiling and not a limit this implementation chose. The two port validators compare
    // against it; this pins the number the comparison means.
    expect(0xffff).toBe(65_535);
    expect(Number.isSafeInteger(65_535)).toBe(true);
});
