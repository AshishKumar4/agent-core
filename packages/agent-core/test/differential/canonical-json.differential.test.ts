import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodeCanonicalJson, type JsonValue } from "../../src/core";
import { scopeKey, subjectKey } from "../../src/authority";
import {
    GuestVerificationScheme,
    PrincipalId,
    PrincipalRef,
    ProjectId,
    ScopeRef,
    SubjectRef,
    TeamId,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { LeanOracle } from "./oracle";

/*
 * Differential testing of canonical JSON encoding and the authority key scheme (SPEC §3.4,
 * §8.1) against the verified Lean model.
 *
 * `AgentCore.canonical_encode_injective` proves the modeled encoder determines its value, and
 * `AgentCore.authorityKey_injective` proves the composite key determines the tuple it was
 * built from — the step `ASM-CANONICAL-KEY-INJECTIVE` used to assume. Those theorems bind to
 * `encodeCanonicalJson` only if the modeled encoder is the one the implementation runs, which
 * is what this suite checks byte for byte.
 *
 * The string sweep is exhaustive over the escape table's own decision space rather than
 * random: every code point below U+0020, both characters that take a backslash escape, and
 * the structural characters that would break the grammar if they were emitted raw. Random
 * text reaches a control character essentially never, and the escape table is exactly where
 * a canonical encoder goes wrong.
 *
 * Number tokens cross the oracle boundary already rendered, because the model represents a
 * number by its token and rendering a JavaScript number to one is the obligation the model
 * does not carry. The number cases therefore check placement among delimiters, not the
 * rendering.
 */

/** Every code point the escape table treats specially, plus ordinary neighbours. */
const ESCAPE_DOMAIN: readonly string[] = [
    ...Array.from({ length: 0x20 }, (_unused, code) => String.fromCodePoint(code)),
    '"',
    "\\",
    "/",
    " ",
    "~",
    ":",
    ",",
    "{",
    "}",
    "[",
    "]",
    "é",
    "\u{1f600}"
];

/** Identifier text that breaks a delimiter join, for the key comparison. */
const HOSTILE_IDENTIFIERS: readonly string[] = [
    "plain",
    "a\u0000b",
    'quote"inside',
    "back\\slash",
    "brace}close",
    "comma,sep",
    "colon:sep",
    "\u0001\u001f",
    "é\u{1f600}"
];

interface JsonTreeWire {
    readonly kind: string;
    readonly [field: string]: unknown;
}

let oracle: LeanOracle;
beforeAll(() => {
    oracle = LeanOracle.start();
}, 900_000);
afterAll(() => {
    oracle?.stop();
});

describe("canonical JSON encoding agrees with the verified model", () => {
    test(
        "string encoding agreement over the whole escape decision space",
        { tags: "p0", timeout: 300_000 },
        async () => {
            for (const character of ESCAPE_DOMAIN) {
                for (const shape of [character, `a${character}b`, `${character}${character}`]) {
                    await expectAgreement(shape);
                }
            }
        }
    );

    test(
        "object and array encoding agreement over hostile keys and nesting",
        { tags: "p0", timeout: 300_000 },
        async () => {
            for (const key of HOSTILE_IDENTIFIERS) {
                await expectAgreement({ [key]: "value" });
                await expectAgreement({ [key]: null, zzz: [1, "two", true] });
                await expectAgreement([{ [key]: [] }, { [key]: {} }]);
            }
            await expectAgreement({});
            await expectAgreement([]);
            await expectAgreement([[], [[]], [[[]]]]);
            await expectAgreement({ b: { a: { c: [null, false] } }, a: 0 });
            await expectAgreement([0, -1, 1.5, 1e21, -0, Number.MAX_SAFE_INTEGER]);
        }
    );

    test(
        "authority Scope and Subject keys agree with the verified model",
        { tags: "p0", timeout: 300_000 },
        async () => {
            for (const text of HOSTILE_IDENTIFIERS) {
                const tenant = new TenantId(text);
                const project = new ProjectId(text);
                const workspace = new WorkspaceId(text);
                await expectScopeKey(ScopeRef.tenant(tenant));
                await expectScopeKey(ScopeRef.project(tenant, project));
                await expectScopeKey(ScopeRef.workspace(tenant, workspace));
                await expectScopeKey(ScopeRef.workspace(tenant, project, workspace));
                await expectSubjectKey(
                    SubjectRef.principal(new PrincipalRef(tenant, new PrincipalId(text)))
                );
                await expectSubjectKey(SubjectRef.team(new TeamId(text)));
                for (const scheme of ["token", "callback", "handshake"] as const) {
                    await expectSubjectKey(
                        SubjectRef.foreign(
                            tenant,
                            new PrincipalId(text),
                            GuestVerificationScheme.from(scheme)
                        )
                    );
                }
            }
        }
    );

    test("the delimiter-join collision does not survive canonical encoding", { tags: "p0" }, () => {
        // AC-KEY-001's `pair_key_not_injective` collision, at the delimiter the record
        // stores use: joining `("a", "b\0c")` and `("a\0b", "c")` yields one string. The
        // canonical-JSON scheme escapes instead of trusting the component domain, so the
        // same two tuples keep two keys — which is what `authorityKey_injective` proves
        // and what makes the resolver's key comparison Subject equality.
        const left = SubjectRef.principal(
            new PrincipalRef(new TenantId("a"), new PrincipalId("b\u0000c"))
        );
        const right = SubjectRef.principal(
            new PrincipalRef(new TenantId("a\u0000b"), new PrincipalId("c"))
        );
        expect(`a\u0000${"b\u0000c"}`).toBe(`${"a\u0000b"}\u0000c`);
        expect(subjectKey(left)).not.toBe(subjectKey(right));
    });

    test("a foreign Subject's verification stamp changes its key", { tags: "p0" }, () => {
        // `AgentCore.foreign_subject_key_separates_verification_schemes`, asserted against
        // the implementation. The same foreign Principal under two verification schemes is
        // two subjects to every key comparison, including the deny sweep, whose effective
        // subject set for a guest holds exactly the Binding's own stamped subject.
        const homeTenant = new TenantId("home-tenant");
        const principal = new PrincipalId("guest-principal");
        const stamped = (scheme: "token" | "callback") =>
            subjectKey(
                SubjectRef.foreign(homeTenant, principal, GuestVerificationScheme.from(scheme))
            );
        expect(stamped("token")).not.toBe(stamped("callback"));
    });
});

async function expectAgreement(value: JsonValue): Promise<void> {
    const model = await oracle.ask({ op: "json.canonical", value: toWire(value) });
    expect(String(model["encoded"]), JSON.stringify(value)).toBe(
        new TextDecoder().decode(encodeCanonicalJson(value))
    );
}

async function expectScopeKey(scope: ScopeRef): Promise<void> {
    const model = await oracle.ask({
        op: "authority.scopeKey",
        scope: {
            kind: scope.kind,
            tenant: scope.tenantId.value,
            project: scope.projectId?.value ?? null,
            workspace: scope.workspaceId?.value ?? null
        }
    });
    expect(String(model["key"]), `scope ${scope.kind}`).toBe(scopeKey(scope));
}

async function expectSubjectKey(subject: SubjectRef): Promise<void> {
    const model = await oracle.ask({ op: "authority.subjectKey", subject: subjectWire(subject) });
    expect(String(model["key"]), `subject ${subject.kind}`).toBe(subjectKey(subject));
}

function subjectWire(subject: SubjectRef): Record<string, unknown> {
    if (subject.kind === "principal") {
        return {
            kind: "principal",
            tenant: subject.principal.tenantId.value,
            principal: subject.principal.principalId.value
        };
    }
    if (subject.kind === "team") return { kind: "team", team: subject.teamId.value };
    return {
        kind: "foreign",
        homeTenant: subject.homeTenant.value,
        principal: subject.principalId.value,
        verifiedVia: subject.verifiedVia.value
    };
}

/**
 * The model's tree, tagged so the harness fixes the number token. Object entries are handed
 * over in the sorted order `canonicalString` produces, since the model encodes the entry list
 * it is given and canonicality of that order is a separate property.
 */
function toWire(value: JsonValue): JsonTreeWire {
    if (value === null) return { kind: "null" };
    if (typeof value === "boolean") return { kind: "bool", value };
    if (typeof value === "number") {
        return { kind: "num", token: JSON.stringify(Object.is(value, -0) ? 0 : value) };
    }
    if (typeof value === "string") return { kind: "str", value };
    if (Array.isArray(value)) return { kind: "arr", items: value.map(toWire) };
    return {
        kind: "obj",
        entries: Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => ({ key, value: toWire(entry) }))
    };
}
