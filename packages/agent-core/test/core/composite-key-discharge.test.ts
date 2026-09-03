import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type ActorKind } from "../../src/actors";
import { RUN_RECORD_KINDS, type RunRecordKind } from "../../src/agents";
import { contentOwnerKey, contentOwnerNamespace } from "../../src/content";
import {
    Digest,
    Revision,
    SemVer,
    canonicalTupleKey,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type DigestAlgorithm,
    type JsonValue
} from "../../src/core";
import type { EnvironmentStoredRecordKind } from "../../src/environments";
import { AgentCoreError } from "../../src/errors";
import {
    MemoryIdentityRepository,
    PrincipalId,
    Team,
    TeamId,
    TenantId,
    type IdentityRecordKind,
    type ScopeKind,
    type StoredIdentityRecord
} from "../../src/identity";

/*
 * The implementation half of AC-KEY-001. The model proves the canonical-JSON key scheme
 * injective outright, and the delimiter join injective only when one side is delimiter-free
 * (`pair_key_injective_of_free_left`, `pair_key_injective_of_free_right`,
 * `pair_key_not_injective`, `prefix_scan_selects_exact_identifier`). Everything it leaves to
 * an implementation is decided here, from the outside:
 *
 *   - the domain of every constrained side a joined record key names excludes the delimiter
 *     that join uses, and the trust boundary refuses a value outside that domain, so no
 *     stored key can be straddled however the free component is spelled;
 *   - distinct JavaScript numbers render to distinct canonical tokens, which is the last
 *     clause of ASM-CANONICAL-KEY-INJECTIVE the model does not carry: it represents a number
 *     by its token and never renders one;
 *   - the UTF-8 encoding of a canonical string is injective, because the encoder's accepted
 *     domain is well-formed text and its decoder is fatal.
 *
 * The per-site naming — which side of which join is the constrained one — is the ACQ-KEY
 * gate's, recorded reason by reason in artifacts/quality/architecture-baseline.json. What is
 * proved here is that each *kind* those reasons name really excludes the delimiter, so a
 * reason naming one of them is a discharge rather than a hope.
 */

/** Every character a joined key in this tree uses to separate two components. */
const DELIMITERS: readonly string[] = ["\u0000", ",", ":", "@"];

/**
 * A closed union whose members sit beside free text in a joined key, with the exhaustive
 * table that makes the enumeration a compile-time obligation: adding a member to the union
 * without adding it here fails to type-check, so the sweep below cannot silently narrow.
 */
const ACTOR_KINDS = {
    tenant: true,
    workspace: true,
    run: true,
    environment: true,
    slate: true
} as const satisfies Record<ActorKind, true>;

const IDENTITY_RECORD_KINDS = {
    membership: true,
    guestTrust: true,
    principal: true,
    project: true,
    role: true,
    shareOffer: true,
    team: true,
    tenant: true,
    workspace: true
} as const satisfies Record<IdentityRecordKind, true>;

const ENVIRONMENT_RECORD_KINDS = {
    head: true,
    revision: true,
    session: true,
    snapshot: true,
    exposure: true
} as const satisfies Record<EnvironmentStoredRecordKind, true>;

const SCOPE_KINDS = {
    tenant: true,
    project: true,
    workspace: true
} as const satisfies Record<ScopeKind, true>;

const RUN_KINDS = {
    configuration: true,
    run: true,
    branch: true,
    commit: true,
    turn: true,
    placement: true,
    checkpoint: true,
    inbox: true,
    spawn: true,
    admission: true,
    forcedCancellation: true,
    acceptance: true,
    verdict: true,
    targetLeaseEvidence: true
} as const satisfies Record<RunRecordKind, true>;

const DIGEST_ALGORITHMS = {
    sha256: true
} as const satisfies Record<DigestAlgorithm, true>;

/** Every closed union a joined key in this tree puts beside a free component. */
const CLOSED_UNIONS: readonly { readonly union: string; readonly members: readonly string[] }[] = [
    { union: "ActorKind", members: Object.keys(ACTOR_KINDS) },
    { union: "IdentityRecordKind", members: Object.keys(IDENTITY_RECORD_KINDS) },
    { union: "EnvironmentStoredRecordKind", members: Object.keys(ENVIRONMENT_RECORD_KINDS) },
    { union: "ScopeKind", members: Object.keys(SCOPE_KINDS) },
    { union: "RunRecordKind", members: Object.keys(RUN_KINDS) },
    { union: "DigestAlgorithm", members: Object.keys(DIGEST_ALGORITHMS) }
];

/**
 * Numbers that break a naive renderer: extremes, both exponent forms, the shortest
 * round-tripping decimal cases, and neighbouring doubles. Some entries are deliberately the
 * same double written two ways — 5e-324 and Number.MIN_VALUE, and 2 ** 53 beside
 * MAX_SAFE_INTEGER + 2, which both round to 9007199254740992 — because
 * one token for two source spellings of one double is correct and must not read as a
 * collision.
 */
const HOSTILE_NUMBERS: readonly number[] = [
    0,
    1,
    -1,
    0.1,
    0.2,
    0.1 + 0.2,
    1 / 3,
    1e-7,
    1e20,
    1e21,
    1e-323,
    5e-324,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 2,
    -Number.MAX_SAFE_INTEGER,
    2 ** 53,
    2 ** 53 + 2,
    1.7976931348623155e308,
    1e100,
    -1e100,
    0.000001,
    0.0000001
];

/** Text that breaks a delimiter join, for the free side of every key. */
const HOSTILE_TEXT: readonly string[] = [
    "plain",
    "",
    "\u0000",
    "a\u0000b",
    "\u0000a",
    "a\u0000",
    'quote"inside',
    "back\\slash",
    "comma,sep",
    "colon:sep",
    "at@sep",
    '","forged',
    "é",
    "e\u0301",
    "\u{1f600}"
];

function canonicalText(value: JsonValue): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(encodeCanonicalJson(value));
}

describe("canonical number tokens", () => {
    test(
        "[AC-KEY-001] a canonical number token determines the double it was rendered from",
        { tags: "p0" },
        () => {
            for (const value of HOSTILE_NUMBERS) {
                expect(Number(canonicalText(value))).toBe(value);
            }
            fc.assert(
                fc.property(
                    fc.double({ noDefaultInfinity: true, noNaN: true }),
                    (value: number) => {
                        expect(Number(canonicalText(value))).toBe(value === 0 ? 0 : value);
                    }
                ),
                { numRuns: 2000 }
            );
        }
    );

    test(
        "[AC-KEY-001] two distinct canonical numbers never render to one token",
        { tags: "p0" },
        () => {
            const valueByToken = new Map<string, number>();
            for (const value of HOSTILE_NUMBERS) {
                const token = canonicalText(value);
                // Equal tokens must mean equal doubles: that is injectivity, stated so that
                // the two spellings of one double above cannot hide a real collision.
                expect(valueByToken.get(token) ?? value).toBe(value);
                valueByToken.set(token, value);
            }
            expect(valueByToken.size).toBe(new Set(HOSTILE_NUMBERS).size);
            fc.assert(
                fc.property(
                    fc.double({ noDefaultInfinity: true, noNaN: true }),
                    fc.double({ noDefaultInfinity: true, noNaN: true }),
                    (left: number, right: number) => {
                        if (canonicalText(left) === canonicalText(right)) {
                            expect(left).toBe(right);
                        }
                    }
                ),
                { numRuns: 2000 }
            );
        }
    );

    test("[AC-KEY-001] adjacent doubles keep two keys inside one tuple", { tags: "p0" }, () => {
        const bits = new DataView(new ArrayBuffer(8));
        const nextUp = (value: number): number => {
            bits.setFloat64(0, value);
            bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
            return bits.getFloat64(0);
        };
        for (const value of [1, 0.1, 1e20, Number.MIN_VALUE]) {
            const neighbour = nextUp(value);
            expect(neighbour).not.toBe(value);
            expect(canonicalTupleKey("test.key", [value, "free"])).not.toBe(
                canonicalTupleKey("test.key", [neighbour, "free"])
            );
        }
    });

    test(
        "[AC-KEY-001] a negative zero and every non-finite number leave the canonical domain",
        { tags: "p0" },
        () => {
            expect(encodeCanonicalJson(-0)).toStrictEqual(encodeCanonicalJson(0));
            expect(canonicalText(-0)).toBe("0");
            expect(() => decodeCanonicalJson(new TextEncoder().encode("-0"))).toThrow(
                AgentCoreError
            );
            for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
                expect(() => encodeCanonicalJson(value)).toThrowError(
                    expect.objectContaining({ code: "codec.invalid" })
                );
            }
        }
    );

    test(
        "[AC-KEY-001] a rendered number holds no delimiter a joined key uses",
        { tags: "p0" },
        () => {
            const numeric = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-][0-9]+)?$/u;
            for (const value of HOSTILE_NUMBERS) {
                expect(canonicalText(value)).toMatch(numeric);
            }
            fc.assert(
                fc.property(
                    fc.double({ noDefaultInfinity: true, noNaN: true }),
                    (value: number) => {
                        expect(canonicalText(value)).toMatch(numeric);
                    }
                ),
                { numRuns: 2000 }
            );
        }
    );
});

describe("canonical text and its UTF-8 bytes", () => {
    test(
        "[AC-KEY-001] the encoding is the UTF-8 encoding of exactly one canonical string",
        { tags: "p0" },
        () => {
            for (const text of HOSTILE_TEXT) {
                const encoded = encodeCanonicalJson([text]);
                const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
                expect(encoded).toStrictEqual(new TextEncoder().encode(decoded));
                expect(decodeCanonicalJson(encoded)).toStrictEqual([text]);
            }
        }
    );

    test(
        "[AC-KEY-001] the collision UTF-8 has over lone surrogates is excluded, not encoded",
        { tags: "p0" },
        () => {
            const encoder = new TextEncoder();
            // Two distinct strings, one byte sequence: TextEncoder maps every unpaired
            // surrogate onto U+FFFD, so applying it to unvalidated text is not injective.
            expect(encoder.encode("\ud800")).toStrictEqual(encoder.encode("\udfff"));
            for (const lone of ["\ud800", "\udfff", "a\ud800b", "\ud800\ud800"]) {
                expect(() => encodeCanonicalJson([lone])).toThrowError(
                    expect.objectContaining({ code: "codec.invalid" })
                );
                expect(() => encodeCanonicalJson({ [lone]: 1 })).toThrowError(
                    expect.objectContaining({ code: "codec.invalid" })
                );
            }
            // The paired form is one scalar value and survives the round trip.
            expect(decodeCanonicalJson(encodeCanonicalJson(["\ud800\udc00"]))).toStrictEqual([
                "\ud800\udc00"
            ]);
        }
    );

    test(
        "[AC-KEY-001] bytes that are not the UTF-8 encoding of canonical text are refused",
        { tags: "p0" },
        () => {
            const malformed: readonly Uint8Array[] = [
                Uint8Array.of(0x22, 0xc0, 0x80, 0x22),
                Uint8Array.of(0x22, 0xed, 0xa0, 0x80, 0x22),
                Uint8Array.of(0x22, 0xe2, 0x82, 0x22),
                Uint8Array.of(0x22, 0xff, 0x22)
            ];
            for (const bytes of malformed) {
                expect(() => decodeCanonicalJson(bytes)).toThrowError(
                    expect.objectContaining({ code: "codec.invalid" })
                );
            }
        }
    );

    test(
        "[AC-KEY-001] distinct canonical text keeps distinct bytes, with no normalization",
        { tags: "p0" },
        () => {
            const bytes = new Map<string, string>();
            for (const text of HOSTILE_TEXT) {
                const key = canonicalTupleKey("test.key", [text]);
                const encoded = [...encodeCanonicalJson([key])].join(".");
                expect(bytes.has(encoded)).toBe(false);
                bytes.set(encoded, text);
            }
            expect(bytes.size).toBe(HOSTILE_TEXT.length);
            expect(encodeCanonicalJson(["é"])).not.toStrictEqual(encodeCanonicalJson(["e\u0301"]));
        }
    );
});

describe("the delimiter-free side of a joined record key", () => {
    test(
        "[AC-KEY-001] every closed union beside free text excludes every delimiter",
        { tags: "p0" },
        () => {
            for (const { union, members } of CLOSED_UNIONS) {
                expect(members.length).toBeGreaterThan(0);
                for (const member of members) {
                    for (const delimiter of DELIMITERS) {
                        expect(
                            member.includes(delimiter),
                            `${union} member ${JSON.stringify(member)} holds ${JSON.stringify(delimiter)}`
                        ).toBe(false);
                    }
                }
            }
            expect(Object.keys(RUN_KINDS)).toStrictEqual([...RUN_RECORD_KINDS]);
        }
    );

    test(
        "[AC-KEY-001] a Digest is 64 lowercase hexadecimal characters or it is not a Digest",
        { tags: "p0" },
        () => {
            const hexadecimal = /^[0-9a-f]{64}$/u;
            fc.assert(
                fc.property(fc.uint8Array({ maxLength: 64 }), (bytes: Uint8Array) => {
                    expect(Digest.sha256(bytes).value).toMatch(hexadecimal);
                }),
                { numRuns: 200 }
            );
            const valid = Digest.sha256(Uint8Array.of(1)).value;
            for (const candidate of [
                valid.toUpperCase(),
                valid.slice(0, 63),
                `${valid}0`,
                `${valid.slice(0, 63)}\u0000`,
                `${valid.slice(0, 32)},${valid.slice(33)}`,
                `${valid.slice(0, 32)}@${valid.slice(33)}`
            ]) {
                expect(() => new Digest(candidate)).toThrow(TypeError);
            }
        }
    );

    test(
        "[AC-KEY-001] a SemVer rendering excludes every delimiter its keys join with",
        { tags: "p0" },
        () => {
            const rendering = /^[0-9A-Za-z.+-]+$/u;
            for (const value of [
                "0.0.0",
                "1.2.3",
                "1.0.0-beta.1",
                "1.0.0-0.3.7",
                "1.0.0+build.11",
                "1.0.0-alpha+001",
                "10.20.30"
            ]) {
                expect(new SemVer(value).toString()).toMatch(rendering);
                expect(new SemVer(value).toString()).toBe(value);
            }
            for (const rejected of [
                "1.0.0\u0000",
                "1.0.0@1",
                "1.0.0,1",
                "1.0.0:1",
                "1.0.0-β",
                "1.0.0-alpha\u0000beta"
            ]) {
                expect(() => SemVer.parse(rejected)).toThrow(TypeError);
            }
        }
    );

    test(
        "[AC-KEY-001] a Revision renders as decimal digits or refuses construction",
        { tags: "p0" },
        () => {
            for (const value of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
                expect(String(new Revision(value).value)).toMatch(/^[0-9]+$/u);
            }
            for (const value of [-1, 1.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY]) {
                expect(() => new Revision(value)).toThrow(TypeError);
            }
        }
    );

    test(
        "[AC-KEY-001] the canonical tuple scheme needs no delimiter-free side at all",
        { tags: "p0" },
        () => {
            const keys = new Map<string, readonly JsonValue[]>();
            for (const left of HOSTILE_TEXT) {
                for (const right of HOSTILE_TEXT) {
                    const key = canonicalTupleKey("record", [left, right]);
                    expect(keys.has(key)).toBe(false);
                    keys.set(key, [left, right]);
                    expect(decodeCanonicalJson(new TextEncoder().encode(key))).toStrictEqual([
                        "record",
                        left,
                        right
                    ]);
                }
            }
            expect(keys.size).toBe(HOSTILE_TEXT.length ** 2);
        }
    );
});

describe("identifier validation at the trust boundary", () => {
    test(
        "[AC-KEY-001] a kind outside its closed union is refused where a key would join it",
        { tags: "p0" },
        () => {
            for (const forged of ["tenant\u0000forged", "tenant,forged", "", "Tenant"]) {
                // SAFETY: the assertion is the test. Each spelling is a kind an older or
                // hostile writer could present where the type says the union holds, and the
                // point is that the constructor decides it at run time rather than trusting
                // the declaration.
                expect(() => new ActorRef(forged as ActorKind, new ActorId("actor"))).toThrow(
                    TypeError
                );
            }
            const tenantId = new TenantId("key-discharge-tenant");
            const team = new Team(
                new TeamId("key-discharge-team"),
                tenantId,
                "Key discharge",
                [new PrincipalId("key-discharge-principal")],
                Revision.initial()
            );
            // SAFETY: same reason, at the durable boundary: a stored record whose kind holds
            // the join's delimiter is exactly what the snapshot restore must refuse, and only
            // an assertion can present one.
            const forgedRecord = {
                kind: "team\u0000forged" as IdentityRecordKind,
                id: team.id.value,
                bytes: Team.encode(team)
            };
            expect(
                () => new MemoryIdentityRepository({ version: 1, records: [forgedRecord] })
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        }
    );

    test(
        "[AC-KEY-001] a free identifier holding the delimiter still keys its own record",
        { tags: "p0" },
        () => {
            const tenantId = new TenantId("key-discharge-tenant");
            const principal = new PrincipalId("key-discharge-principal");
            const teams = ["a", "a\u0000b", "a\u0000", "\u0000a", "a\u0000b\u0000c"].map(
                (id) =>
                    new Team(
                        new TeamId(id),
                        tenantId,
                        "Key discharge",
                        [principal],
                        Revision.initial()
                    )
            );
            const repository = new MemoryIdentityRepository({
                version: 1,
                records: teams.map((team): StoredIdentityRecord => ({
                    kind: "team",
                    id: team.id.value,
                    bytes: Team.encode(team)
                }))
            });

            for (const team of teams) {
                expect(repository.loadTeam(team.id)?.id.value).toBe(team.id.value);
            }
            expect(repository.snapshot().records).toHaveLength(teams.length);
        }
    );

    test(
        "[AC-KEY-001] an identifier that is not well-formed Unicode never reaches a key",
        { tags: "p0" },
        () => {
            for (const lone of ["\ud800", "\udc00", "a\ud800"]) {
                expect(() => new TeamId(lone)).toThrow(TypeError);
                expect(() => new ActorId(lone)).toThrow(TypeError);
            }
            expect(new TeamId("\ud800\udc00").value).toBe("\ud800\udc00");
        }
    );

    test(
        "[AC-KEY-001] a custody namespace prefix selects exactly the kind it names",
        { tags: "p0" },
        () => {
            const namespace = contentOwnerNamespace("slate");
            expect(contentOwnerKey("slate", "id", "source").startsWith(namespace)).toBe(true);
            // "slate" is a prefix of "slate.version" as text; the quoted canonical form is
            // prefix-free, so the longer kind's keys are outside the shorter kind's namespace.
            expect(contentOwnerKey("slate.version", "id", "source").startsWith(namespace)).toBe(
                false
            );
            for (const forged of ['slate","forged', "slate\u0000", 'slate"', "slate."]) {
                expect(contentOwnerKey(forged, "id", "source").startsWith(namespace)).toBe(false);
            }
            // A free record identity cannot reach the kind position however it is spelled.
            for (const identity of HOSTILE_TEXT) {
                expect(
                    contentOwnerKey("slate.version", identity, "source").startsWith(namespace)
                ).toBe(false);
                expect(contentOwnerKey("slate", identity, "source").startsWith(namespace)).toBe(
                    true
                );
            }
        }
    );
});
