import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import { Revision } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../src/identity";
import { Binding } from "../../src/authority/binding";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { AuthorityMutationService } from "../../src/authority/service";
import { PrincipalRef, Workspace } from "../identity/internal-fixture";

const tenantId = new TenantId("tenant-namespace-refusal");
const principalId = new PrincipalId("principal-namespace-refusal");
const workspaceId = new WorkspaceId("workspace-namespace-refusal");
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const subject = SubjectRef.principal(new PrincipalRef(tenantId, principalId));
const domain = new ProtectionDomain("backend", "namespace-refusal", "no-secrets");
const facet = new FacetRef("workspace:mail.instance");
const boundGrantId = new GrantId("namespace-refusal-grant");
const BOUND = "mail";
const MAX_NAME_LENGTH = 256;

/**
 * One inadmissible name and the admissible name a host would land on if it repaired the
 * spelling instead of refusing it. The transform is named so a reader can see the hazard is
 * a real one a host might apply, not an arbitrary string pair; the test then proves the
 * target is admissible, so every row is a live renaming opportunity rather than filler.
 */
interface RenamingHazard {
    readonly candidate: string;
    readonly repair: string;
    readonly transform: string;
}

const HAZARDS: readonly RenamingHazard[] = Object.freeze([
    { candidate: " mail", repair: BOUND, transform: "trim" },
    { candidate: "mail ", repair: BOUND, transform: "trim" },
    { candidate: " mail ", repair: BOUND, transform: "trim" },
    { candidate: "\tmail", repair: BOUND, transform: "trim" },
    { candidate: "mail\n", repair: BOUND, transform: "trim" },
    { candidate: "\u00A0mail", repair: BOUND, transform: "trim" },
    { candidate: "Mail", repair: BOUND, transform: "lowercase" },
    { candidate: "MAIL", repair: BOUND, transform: "lowercase" },
    { candidate: "mAiL", repair: BOUND, transform: "lowercase" },
    { candidate: "ｍａｉｌ", repair: BOUND, transform: "NFKC" },
    { candidate: "ma\u2071l", repair: BOUND, transform: "NFKC" },
    { candidate: "\u217Fail", repair: BOUND, transform: "NFKC" },
    { candidate: "mai\u217C", repair: BOUND, transform: "NFKC" },
    { candidate: "mail\u0301", repair: BOUND, transform: "strip combining marks" },
    {
        candidate: "m".padEnd(MAX_NAME_LENGTH + 1, "a"),
        repair: "m".padEnd(MAX_NAME_LENGTH, "a"),
        transform: "truncate to the length limit"
    }
]);

function repaired(hazard: RenamingHazard): string {
    if (hazard.transform === "trim") return hazard.candidate.trim();
    if (hazard.transform === "lowercase") return hazard.candidate.toLowerCase();
    if (hazard.transform === "NFKC") return hazard.candidate.normalize("NFKC");
    if (hazard.transform === "strip combining marks") {
        return hazard.candidate.normalize("NFD").replace(/\p{M}/gu, "");
    }
    return hazard.candidate.slice(0, MAX_NAME_LENGTH);
}

describe("an inadmissible capability name is refused, never renamed", () => {
    test(
        "[C13-AUTH-ISOLATE-NAMESPACE-CLOSED] every repair a host might apply reaches an admissible name the plane has already bound",
        { tags: "p0" },
        () => {
            for (const hazard of HAZARDS) {
                // The hazard is real only if repairing it produces something the plane would
                // accept. Asserting that first keeps the refusals below from passing on names
                // no host would ever have folded.
                expect(repaired(hazard), hazard.candidate).toBe(hazard.repair);
                expect(new BindingName(hazard.repair).value).toBe(hazard.repair);
                expect(hazard.repair).not.toBe(hazard.candidate);
            }
            // Every whitespace, case and Unicode hazard aims at the one name this Workspace
            // actually binds, so a repairing host would reach that Binding's Grant.
            expect(HAZARDS.filter((hazard) => hazard.repair === BOUND).length).toBe(
                HAZARDS.length - 1
            );
        }
    );

    test(
        "[C13-AUTH-ISOLATE-NAMESPACE-CLOSED] refuses the inadmissible spelling at the name, the record, and the decode boundary",
        { tags: "p0" },
        () => {
            const { store } = boundFixture();
            const stored = Binding.decode(Binding.encode(bound(new BindingName(BOUND)))).toData();

            for (const hazard of HAZARDS) {
                // A `BindingName` is the only way to name a capability, so the refusal happens
                // before a Binding, a Binding key, or an isolate namespace entry can exist.
                expect(() => new BindingName(hazard.candidate), hazard.candidate).toThrow(
                    TypeError
                );
                // The decode boundary is the one place a foreign spelling can arrive from, and
                // it refuses too rather than decoding into a repaired record.
                expect(
                    () => Binding.fromData({ ...stored, name: hazard.candidate }),
                    hazard.candidate
                ).toThrow(TypeError);
            }

            // Nothing was created, renamed, or merged: the plane still holds exactly the one
            // Binding that was written, under exactly the spelling it was written with.
            expect(store.bindings().map((binding) => binding.name.value)).toEqual([BOUND]);
            expect(store.binding(keyFor(BOUND))?.grantId.equals(boundGrantId)).toBe(true);
        }
    );

    test(
        "[C13-AUTH-ISOLATE-NAMESPACE-CLOSED] refuses an empty name without substituting one",
        { tags: "p0" },
        () => {
            const { store } = boundFixture();
            for (const blank of ["", " ", "\t", "\n", "\u00A0"]) {
                // No repair reaches an admissible name here, so the only conforming answer is
                // a refusal — a host inventing a default would be renaming from nothing.
                expect(blank.trim().length).toBe(0);
                expect(() => new BindingName(blank), JSON.stringify(blank)).toThrow(TypeError);
            }
            expect(store.bindings().map((binding) => binding.name.value)).toEqual([BOUND]);
        }
    );

    test(
        "[C13-AUTH-ISOLATE-NAMESPACE-CLOSED] admits the longest canonical name and refuses the next character rather than truncating it",
        { tags: "p0" },
        () => {
            const { service, store } = boundFixture();
            const longest = "m".padEnd(MAX_NAME_LENGTH, "a");
            const overLong = `${longest}a`;
            expect(longest.length).toBe(MAX_NAME_LENGTH);
            expect(overLong.length).toBe(MAX_NAME_LENGTH + 1);

            // The boundary is admissible, so the refusal above it is a length rule and not an
            // accidental rejection of long names.
            service.createBinding(bound(new BindingName(longest)));
            expect(store.binding(keyFor(longest))?.name.value).toBe(longest);

            expect(() => new BindingName(overLong)).toThrow(
                new TypeError("Binding name must contain between 1 and 256 characters")
            );
            // A truncating host would have landed on the Binding just written. It cannot:
            // the over-long name never becomes a name, so it addresses nothing.
            expect(
                store
                    .bindings()
                    .map((binding) => binding.name.value)
                    .sort()
            ).toEqual([BOUND, longest].sort());
        }
    );
});

function keyFor(name: string): string {
    return Binding.keyFor(workspaceScope, subject, domain, new BindingName(name));
}

function bound(name: BindingName): Binding {
    return new Binding(
        workspaceScope,
        subject,
        domain,
        name,
        boundGrantId,
        facet,
        0,
        "active",
        Revision.initial()
    );
}

/** A Workspace whose capability namespace holds exactly one passed Binding, named `mail`. */
function boundFixture() {
    const anchor = {
        actorId: new ActorId("namespace-refusal-actor"),
        tenantId,
        principalId,
        trustAnchor: Uint8Array.of(2, 4, 6)
    };
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    service.createGrant(
        new Grant(
            boundGrantId,
            workspaceScope,
            subject,
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" }
        )
    );
    service.createBinding(bound(new BindingName(BOUND)));
    return { store, service };
}
