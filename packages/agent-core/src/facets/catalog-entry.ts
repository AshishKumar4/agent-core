import {
    Digest,
    JsonSchema,
    SemVer,
    TextId,
    canonicalTupleKey,
    encodeCanonicalJson
} from "../core";
import { PackageId, PackagePin } from "../definition-references";
import { ContributionAttribution } from "./attribution";
import { OperationAvailability } from "./authored-code";
import { Command } from "./command";
import { OperationDescriptor } from "./contribution";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    dataRecord,
    requireDataObject,
    requireExactFields,
    requireString
} from "./data";
import { EventDeclaration } from "./event";
import { InterceptorDeclaration } from "./interceptor";
import {
    BindingName,
    CatalogEntryId,
    EventKind,
    FacetPackageId,
    FacetRef,
    InterceptorId,
    OperationName,
    OperationRef,
    SlotName
} from "./id";
import {
    FieldMapping,
    FieldMove,
    JsonPointer,
    MappingRecord,
    OperationPattern,
    OperationSelector
} from "./mapping";
import { BoundOperationRef } from "./operation";

/**
 * The §4.2 contribution kinds whose materialization is a catalog entry. An `operations`
 * entry contributes its `OperationDescriptor`, a `commands` entry the `Command` that
 * compiles to a catalog entry plus a derived Subscription (§4.3), an `events` entry the
 * `EventDeclaration` naming an accepted Event kind and its visibility, and an
 * `interceptors` entry the `InterceptorDeclaration` that is one position in the §4.4
 * pipeline. The last two reach no primitive of their own and target no Slot declaration,
 * so the catalog entry is what carries their attribution into the §4.1 withdrawal set.
 */
export type CatalogKind = "command" | "event" | "interceptor" | "operation";

export type CatalogDeclaration =
    Command | EventDeclaration | InterceptorDeclaration | OperationDescriptor;

const CATALOG_KINDS: readonly CatalogKind[] = ["command", "event", "interceptor", "operation"];

/**
 * SPEC §4.2: the position one catalog entry occupies — the declaring Facet, or no Facet
 * for a host's direct declaration, together with the declared kind and name. It is
 * deliberately a different shape from `CatalogEntryId`, because the two answer different
 * questions. The id digests every declared field including the source pin, so it answers
 * whether two materializations are the same record; the origin names the position a
 * changed contribution supersedes. Collapsing them makes a contribution re-read from a
 * later release indistinguishable from an illegal rewrite of the record it replaces.
 */
export class CatalogOrigin {
    /** Lookup key for the at-most-one-owner-per-kind-per-name index. */
    public readonly key: string;

    public constructor(
        public readonly kind: CatalogKind,
        public readonly name: string,
        public readonly owner: FacetRef | undefined
    ) {
        this.key = canonicalTupleKey("catalog.origin", [kind, name, owner?.value ?? null]);
        Object.freeze(this);
    }

    public equals(other: CatalogOrigin): boolean {
        return this.key === other.key;
    }

    public toData(): FacetData {
        return dataRecord({
            kind: this.kind,
            name: this.name,
            owner: this.owner?.value
        });
    }
}

/**
 * A catalog entry as a Scope holds it: SPEC §4.1 materializes an `operations` or
 * `commands` contribution as one, and §4.2 requires every such record to carry the exact
 * `FacetRef` of the contributing Facet and the `PackagePin` of the release the
 * contribution was read from. A host also offers operations imperatively through the same
 * paths (§4.2), so the attribution is what separates a contribution-materialized entry
 * from a direct declaration: a direct declaration carries none and may never claim one,
 * while a contribution-materialized entry carries exactly the authenticated pair and is
 * invalid without it. That split is what makes withdrawal exact — the withdrawal set is a
 * query over these fields alone, so it never reaches a host-direct record or another
 * Facet's entry.
 */
export class CatalogEntry {
    public static get codec(): DataRecordCodec<CatalogEntry> {
        return catalogEntryCodec;
    }

    public readonly origin: CatalogOrigin;
    public readonly id: CatalogEntryId;

    public constructor(
        public readonly kind: CatalogKind,
        public readonly name: string,
        public readonly declaration: CatalogDeclaration,
        public readonly attribution: ContributionAttribution | undefined
    ) {
        // One lookup answers both questions the two checks used to ask separately: a value
        // that is no declaration has no kind, and a declaration whose kind is not the one
        // claimed is the same defect said differently.
        const declared = declarationKind(declaration);
        if (declared === undefined) {
            throw new TypeError(
                `A catalog entry carries one of ${CATALOG_KINDS.join(", ")} declarations`
            );
        }
        if (declared !== kind) {
            throw new TypeError(`A ${kind} catalog entry declares a different record`);
        }
        const declaredName = catalogName(declaration);
        if (name !== declaredName) {
            throw new TypeError(
                `Catalog entry name must be its declaration's own name ${declaredName}`
            );
        }
        if (attribution !== undefined && !(attribution instanceof ContributionAttribution)) {
            throw new TypeError("A contribution-materialized catalog entry requires attribution");
        }
        this.origin = new CatalogOrigin(kind, name, attribution?.contributor);
        this.id = catalogEntryId(kind, name, declaration, attribution);
        Object.freeze(this);
    }

    /**
     * A wire payload names its attribution fields only when one exists. Absence is the
     * encoding of a direct declaration, so a lone contributor or pin is malformed rather
     * than an unattributed record.
     */
    public static fromData(payload: FacetData): CatalogEntry {
        const object = requireDataObject(payload, "Catalog entry");
        requireExactFields(
            object,
            ["declaration", "id", "kind", "name"],
            ["contributor", "package"]
        );
        const attributed =
            (object["contributor"] !== undefined) === (object["package"] !== undefined);
        if (!attributed) {
            throw new TypeError(
                "Catalog entry attribution requires its contributing FacetRef and source Package pin together"
            );
        }
        return new CatalogEntry(
            requireKind(object["kind"]),
            requireString(object["name"], "Catalog entry name"),
            decodeDeclaration(requireKind(object["kind"]), object["declaration"]),
            object["contributor"] === undefined
                ? undefined
                : ContributionAttribution.decodeFields(object, "Catalog entry")
        ).requireId(new CatalogEntryId(requireString(object["id"], "Catalog entry ID")));
    }

    public static encode(entry: CatalogEntry): Uint8Array {
        return catalogEntryCodec.encode(entry);
    }

    public static decode(bytes: Uint8Array): CatalogEntry {
        return catalogEntryCodec.decode(bytes);
    }

    public toData(): FacetData {
        return dataRecord({
            ...this.attribution?.encodeFields(),
            declaration: this.declaration.toData(),
            id: this.id.value,
            kind: this.kind,
            name: this.name
        });
    }

    private requireId(expected: CatalogEntryId): this {
        if (!this.id.equals(expected)) {
            throw new TypeError("Catalog entry ID does not match its canonical contents");
        }
        return this;
    }
}

function requireKind(value: FacetData | undefined): CatalogKind {
    const kind = CATALOG_KINDS.find((candidate) => candidate === value);
    if (kind === undefined) {
        throw new TypeError(`Catalog entry kind must be one of ${CATALOG_KINDS.join(", ")}`);
    }
    return kind;
}

/** The kind a declaration is, or nothing when the value declares no catalog record. */
function declarationKind(declaration: CatalogDeclaration): CatalogKind | undefined {
    if (declaration instanceof Command) return "command";
    if (declaration instanceof EventDeclaration) return "event";
    if (declaration instanceof InterceptorDeclaration) return "interceptor";
    if (declaration instanceof OperationDescriptor) return "operation";
    return undefined;
}

/**
 * The name a declaration answers to inside its kind. Each kind carries its own declared
 * identity — an Event kind, an interceptor id, an Operation or Command name — so the
 * catalog never invents one and an entry cannot be filed under a name its declaration
 * does not state.
 */
function catalogName(declaration: CatalogDeclaration): string {
    if (declaration instanceof Command) return declaration.name;
    if (declaration instanceof EventDeclaration) return declaration.kind.value;
    if (declaration instanceof InterceptorDeclaration) return declaration.id.value;
    return declaration.name.value;
}

function decodeDeclaration(kind: CatalogKind, payload: FacetData | undefined): CatalogDeclaration {
    if (payload === undefined) {
        throw new TypeError("Catalog entry carries no declaration");
    }
    switch (kind) {
        case "command":
            return Command.fromData(payload);
        case "event":
            return EventDeclaration.fromData(payload);
        case "interceptor":
            return InterceptorDeclaration.fromData(payload);
        case "operation":
            return OperationDescriptor.fromData(payload);
    }
}

function catalogEntryId(
    kind: CatalogKind,
    name: string,
    declaration: CatalogDeclaration,
    attribution: ContributionAttribution | undefined
): CatalogEntryId {
    const digest = Digest.sha256(
        encodeCanonicalJson({
            ...attribution?.encodeFields(),
            declaration: declaration.toData(),
            kind,
            name
        })
    );
    return new CatalogEntryId(`catalog:${digest.value}`);
}

const catalogEntryCodec = new DataRecordCodec(
    [
        CatalogEntry,
        CatalogOrigin,
        ContributionAttribution,
        OperationDescriptor,
        OperationAvailability,
        Command,
        EventDeclaration,
        EventKind,
        InterceptorDeclaration,
        InterceptorId,
        OperationPattern,
        OperationSelector,
        BindingName,
        SlotName,
        JsonSchema,
        JsonPointer,
        OperationName,
        OperationRef,
        BoundOperationRef,
        MappingRecord,
        FieldMapping,
        FieldMove,
        CatalogEntryId,
        TextId,
        FacetRef,
        FacetPackageId,
        Digest,
        SemVer,
        PackageId,
        PackagePin
    ],
    "facet.catalog-entry",
    (entry: CatalogEntry) => entry.toData(),
    (payload) => CatalogEntry.fromData(payload)
);
