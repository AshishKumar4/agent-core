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
import {
    BindingName,
    CatalogEntryId,
    FacetPackageId,
    FacetRef,
    OperationName,
    OperationRef,
    SlotName
} from "./id";
import { FieldMapping, FieldMove, JsonPointer, MappingRecord } from "./mapping";
import { BoundOperationRef } from "./operation";

/**
 * The §4.1 contribution kinds whose materialization is a catalog entry: an `operations`
 * entry contributes its `OperationDescriptor` and a `commands` entry contributes the
 * `Command` that compiles to a catalog entry plus a derived Subscription (§4.3).
 */
export type CatalogKind = "operation" | "command";

const CATALOG_KINDS: readonly CatalogKind[] = ["operation", "command"];

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
        public readonly declaration: OperationDescriptor | Command,
        public readonly attribution: ContributionAttribution | undefined
    ) {
        if (!(declaration instanceof OperationDescriptor) && !(declaration instanceof Command)) {
            throw new TypeError("A catalog entry carries an operation or command declaration");
        }
        if (!CATALOG_KINDS.includes(kind)) {
            throw new TypeError(`Catalog entry kind must be one of ${CATALOG_KINDS.join(", ")}`);
        }
        requireKindDeclaration(kind, declaration);
        const declared = declaredName(declaration);
        if (name !== declared) {
            throw new TypeError(
                `Catalog entry name must be its declaration's own name ${declared}`
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
    if (value !== "operation" && value !== "command") {
        throw new TypeError(`Catalog entry kind must be one of ${CATALOG_KINDS.join(", ")}`);
    }
    return value;
}

function requireKindDeclaration(
    kind: CatalogKind,
    declaration: OperationDescriptor | Command
): void {
    if (declaresOperation(kind, declaration)) return;
    throw new TypeError(`A ${kind} catalog entry declares a different record`);
}

function declaresOperation(kind: CatalogKind, declaration: OperationDescriptor | Command): boolean {
    const operation = declaration instanceof OperationDescriptor;
    return kind === "operation" ? operation : !operation;
}

function declaredName(declaration: OperationDescriptor | Command): string {
    return declaration instanceof Command ? declaration.name : declaration.name.value;
}

function decodeDeclaration(
    kind: CatalogKind,
    payload: FacetData | undefined
): OperationDescriptor | Command {
    if (payload === undefined) {
        throw new TypeError("Catalog entry carries no declaration");
    }
    return kind === "operation" ? OperationDescriptor.fromData(payload) : Command.fromData(payload);
}

function catalogEntryId(
    kind: CatalogKind,
    name: string,
    declaration: OperationDescriptor | Command,
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
        Command,
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
