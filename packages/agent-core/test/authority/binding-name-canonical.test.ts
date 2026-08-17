import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import { Binding } from "../../src/authority/binding";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { AuthorityMutationService } from "../../src/authority/service";
import { CompatRange, Revision, type JsonValue } from "../../src/core";
import {
    BindingName,
    BindingRequirement,
    CapabilitySpec,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    ProtectionDomain
} from "../../src/facets";
import {
    PrincipalId,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { Contributions } from "../../src/facets/contribution";
import { PrincipalRef, Workspace } from "../identity/internal-fixture";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tenantId = new TenantId("binding-name-tenant");
const ownerId = new PrincipalId("binding-name-owner");
const workspaceId = new WorkspaceId("binding-name-workspace");
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const subject = SubjectRef.principal(new PrincipalRef(tenantId, ownerId));
const domain = new ProtectionDomain("backend", "binding-name-domain", "no-secrets");
const facet = new FacetRef("workspace:mail");
const boundGrantId = new GrantId("binding-name-grant");
const anchor = {
    actorId: new ActorId("binding-name-actor"),
    tenantId,
    principalId: ownerId,
    trustAnchor: Uint8Array.of(7, 7, 7)
};

/**
 * The §1.4 form, spelled out rather than derived, so a drift in either the SPEC or the
 * implementation shows up as a disagreement with a fixed corpus rather than as two sides
 * moving together.
 */
const ADMISSIBLE = Object.freeze([
    "a",
    "z9",
    "mail",
    "a1",
    "binding.route",
    "cross-tenant",
    "a.b-c.d9",
    "mail1.route2"
]);

/**
 * Every class §3.4 names — empty, blank, uppercase — plus the separator and script cases a
 * host might be tempted to normalize into an admissible neighbour.
 */
const INADMISSIBLE = Object.freeze([
    "",
    " ",
    "\t",
    "Mail",
    "MAIL",
    "mAil",
    " mail",
    "mail ",
    "mail.",
    ".mail",
    "mail-",
    "-mail",
    "mail..route",
    "mail--route",
    "mail_route",
    "mail route",
    "mail:route",
    "mail/route",
    "1mail",
    "9",
    "_mail",
    "maıl",
    "mailé",
    "mail\n"
]);

/** The admissible name a normalizing host would fold each inadmissible one into. */
const FOLDS_TO_MAIL = Object.freeze(["Mail", "MAIL", "mAil", " mail", "mail ", "mail\n"]);

function boundBinding(name: BindingName): Binding {
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

function boundFixture() {
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
    service.createBinding(boundBinding(new BindingName("mail")));
    return { store, service };
}

function requirementData(name: string): JsonValue {
    return {
        compat: { host: "^1.0.0", spec: "^1.0.0" },
        facet: "core.mail",
        name
    };
}

function manifestData(bindingName: string): JsonValue {
    return {
        bindings: [requirementData(bindingName)],
        compat: { host: "^1.0.0", spec: "^1.0.0" },
        contributions: {},
        id: "core.mail",
        isolation: ["bundled"],
        version: "1.0.0"
    };
}

describe("canonical Binding names in the one authority plane", () => {
    test(
        "[C13-AUTH-BINDING-NAME-CANONICAL] admits exactly the §1.4 canonical segment form at every authority-plane site that writes a name",
        { tags: "p0" },
        () => {
            for (const admissible of ADMISSIBLE) {
                expect(new BindingName(admissible).value, admissible).toBe(admissible);
                expect(boundBinding(new BindingName(admissible)).name.value, admissible).toBe(
                    admissible
                );
                expect(
                    BindingRequirement.fromData(requirementData(admissible)).name.value,
                    admissible
                ).toBe(admissible);
            }
            for (const inadmissible of INADMISSIBLE) {
                // The refusal is the whole outcome at each site the SPEC enumerates: the name
                // itself, the Binding record the authority plane stores, the §4.1 manifest
                // requirement, and the manifest a §9.2 Blueprint carries.
                expect(() => new BindingName(inadmissible), inadmissible).toThrow(TypeError);
                expect(
                    () => BindingRequirement.fromData(requirementData(inadmissible)),
                    inadmissible
                ).toThrow(TypeError);
                expect(
                    () => FacetManifest.fromData(manifestData(inadmissible)),
                    inadmissible
                ).toThrow(TypeError);
            }
        }
    );

    test(
        "[C13-AUTH-BINDING-NAME-CANONICAL] refuses a noncanonical name where it is written rather than folding it onto an admissible neighbour",
        { tags: "p0" },
        () => {
            const { store, service } = boundFixture();
            const bound = boundBinding(new BindingName("mail"));
            expect(store.binding(bound.key)?.grantId.equals(boundGrantId)).toBe(true);

            for (const folding of FOLDS_TO_MAIL) {
                // A host that case-folded or trimmed would reach the Grant `mail` holds. The
                // refusal happens before any record exists, so there is nothing to reach: the
                // authority plane never sees a second spelling of one key.
                expect(() => new BindingName(folding), folding).toThrow(TypeError);
                expect(
                    () => service.createBinding(boundBinding(new BindingName(folding))),
                    folding
                ).toThrow(TypeError);
            }
            // Exactly one Binding exists, and it is the one that was written.
            expect(store.bindings().map((binding) => binding.name.value)).toEqual(["mail"]);

            const stored = Binding.decode(Binding.encode(bound)).toData();
            for (const inadmissible of INADMISSIBLE) {
                // The trust boundary refuses too: a stored record renamed in transit does not
                // decode into an admissible Binding.
                expect(
                    () => Binding.fromData({ ...stored, name: inadmissible }),
                    inadmissible
                ).toThrow(TypeError);
            }
        }
    );

    test(
        "[C13-AUTH-BINDING-NAME-CANONICAL] two distinct canonical names cannot fold to one Binding key, so a name cannot reach the Grant another name was bound to",
        { tags: "p0" },
        () => {
            const { store, service } = boundFixture();
            const keys = new Map<string, string>();
            for (const name of ADMISSIBLE) {
                const key = Binding.keyFor(workspaceScope, subject, domain, new BindingName(name));
                expect(keys.has(key), `${name} collides with ${keys.get(key) ?? ""}`).toBe(false);
                keys.set(key, name);
            }
            expect(keys.size).toBe(ADMISSIBLE.length);

            // `mail` is bound; every other admissible name — including the separator-substituted
            // neighbours a case-insensitive or delimiter-folding key would merge with it —
            // addresses nothing, so it reaches no Grant.
            for (const other of ADMISSIBLE.filter((name) => name !== "mail")) {
                const key = Binding.keyFor(workspaceScope, subject, domain, new BindingName(other));
                expect(store.binding(key), other).toBeUndefined();
                expect(() => service.deactivateBinding(key), other).toThrow(/Binding/u);
            }
            for (const separatorNeighbour of ["ma.il", "ma-il", "mail.route", "mail-route"]) {
                const key = Binding.keyFor(
                    workspaceScope,
                    subject,
                    domain,
                    new BindingName(separatorNeighbour)
                );
                expect(store.binding(key), separatorNeighbour).toBeUndefined();
            }
        }
    );

    test(
        "[C13-AUTH-BINDING-NAME-CANONICAL] the §1.4 form SPEC.md fixes and the set the authority plane admits share one source",
        { tags: "p0" },
        async () => {
            const spec = await readFile(resolve(packageRoot, "SPEC.md"), "utf8");
            const quoted = [
                ...spec.matchAll(/`(\^\[a-z\][^`]*\$)`/gu)
            ].map((match) => match[1]!);
            // §1.4 fixes the form and §3.4 spends it on a BindingName. Both must be the one
            // form, or the document itself carries two.
            expect(quoted.length).toBe(2);
            expect(new Set(quoted).size).toBe(1);

            const declared = new RegExp(quoted[0]!, "u");
            for (const candidate of [...ADMISSIBLE, ...INADMISSIBLE]) {
                let admitted = true;
                try {
                    new BindingName(candidate);
                } catch {
                    admitted = false;
                }
                expect(admitted, `${JSON.stringify(candidate)} vs SPEC form`).toBe(
                    declared.test(candidate)
                );
            }
        }
    );

    test(
        "[C13-AUTH-BINDING-NAME-CANONICAL] the form constrains a requirement's key and never a provider's identity",
        { tags: "p0" },
        () => {
            // §3.4's last clause: the name is the key of a requirement, and the provider stays
            // the exact FacetRef. A manifest may therefore name a Binding whose spelling differs
            // from the Facet it requires, and the plane keeps both exactly.
            const manifest = FacetManifest.fromData(manifestData("cross-tenant"));
            expect(manifest.bindings.map((binding) => binding.name.value)).toEqual(["cross-tenant"]);
            expect(manifest.bindings[0]!.facet.value).toBe("core.mail");

            const requirement = new BindingRequirement(
                new BindingName("mail"),
                new FacetPackageId("core.mail"),
                CompatRange.any()
            );
            expect(
                new FacetManifest({
                    id: new FacetPackageId("core.mail"),
                    version: manifest.version,
                    compat: manifest.compat,
                    isolation: ["bundled"],
                    bindings: [requirement],
                    contributions: Contributions.empty()
                }).bindings[0]!.name.value
            ).toBe("mail");

            const bound = boundBinding(new BindingName("cross-tenant"));
            expect(bound.facet.equals(facet)).toBe(true);
            expect(bound.key).not.toBe(
                Binding.keyFor(workspaceScope, subject, domain, new BindingName("mail"))
            );
        }
    );
});
