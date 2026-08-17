import { TextId } from "../core";

export class FacetPackageId extends TextId {
    public constructor(value: string) {
        super(value, "Facet package ID");
        requireCanonicalId(value, "Facet package ID");
        Object.freeze(this);
    }
}

export class FacetRef extends TextId {
    public readonly packageId: FacetPackageId;

    public constructor(value: string) {
        super(value, "Facet reference");
        requireFacetRef(value);
        this.packageId = new FacetPackageId(value.slice(0, value.indexOf(":")));
        Object.freeze(this);
    }
}

export class BindingName extends TextId {
    public constructor(value: string) {
        super(value, "Binding name");
        requireCanonicalId(value, "Binding name");
        requireBindingName(value);
        Object.freeze(this);
    }
}

// A hosting mechanism for a `dynamic` domain, named by the substrate profile that
// offers it (SPEC §4.7). The identifier is opaque here on purpose: the SPEC fixes no
// enum of backings, so a profile may offer any backing it can hold to the same
// authority semantics.
export class AuthoredCodeBackingId extends TextId {
    public constructor(value: string) {
        super(value, "Agent-authored code backing ID");
        requireCanonicalId(value, "Agent-authored code backing ID");
        Object.freeze(this);
    }
}

export class OperationName extends TextId {
    public constructor(value: string) {
        super(value, "Operation name");
        requireCanonicalId(value, "Operation name");
        Object.freeze(this);
    }
}

export class OperationRef extends TextId {
    public readonly facet: FacetPackageId;
    public readonly operation: OperationName;

    public constructor(value: string) {
        super(value, "Operation reference");
        requireCanonicalId(value, "Operation reference");
        const separator = value.indexOf(":");
        if (
            separator <= 0 ||
            separator !== value.lastIndexOf(":") ||
            separator === value.length - 1
        ) {
            throw new TypeError(
                "Operation reference must be '<facet-package-id>:<operation-name>'"
            );
        }
        this.facet = new FacetPackageId(value.slice(0, separator));
        this.operation = new OperationName(value.slice(separator + 1));
        Object.freeze(this);
    }
}

export class EventKind extends TextId {
    public constructor(value: string) {
        super(value, "Event kind");
        requireCanonicalId(value, "Event kind");
        Object.freeze(this);
    }
}

export class SurfaceId extends TextId {
    public constructor(value: string) {
        super(value, "Surface ID");
        requireCanonicalId(value, "Surface ID");
        Object.freeze(this);
    }
}

export class SlotName extends TextId {
    public constructor(value: string) {
        super(value, "Slot name");
        requireCanonicalId(value, "Slot name");
        Object.freeze(this);
    }
}

export class InterceptorId extends TextId {
    public constructor(value: string) {
        super(value, "Interceptor ID");
        requireCanonicalId(value, "Interceptor ID");
        Object.freeze(this);
    }
}

export class SlotEntryId extends TextId {
    public constructor(value: string) {
        super(value, "Slot entry ID");
        requireCanonicalId(value, "Slot entry ID");
        Object.freeze(this);
    }
}

function requireCanonicalId(value: string, subject: string): void {
    if (value.length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}

// §1.4 fixes one canonical segment form for the identifiers that name things across a
// protection domain boundary. A FacetRef spends it twice; a BindingName spends it once
// (SPEC §3.4). Sharing the source keeps the two from drifting into two forms.
const CANONICAL_SEGMENT = "[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*";
const BINDING_NAME = new RegExp(`^${CANONICAL_SEGMENT}$`, "u");
const FACET_REF = new RegExp(`^${CANONICAL_SEGMENT}:${CANONICAL_SEGMENT}$`, "u");

// The form is decided from the name alone, so an inadmissible name is refused where it is
// written rather than surfacing as a failed lookup at the call that used it.
function requireBindingName(value: string): void {
    if (!BINDING_NAME.test(value)) {
        throw new TypeError("Binding name must be one canonical segment");
    }
}

// The pattern already fixes the separator: exactly one colon, with a canonical segment
// on each side of it. Restating that as separator arithmetic beforehand decides nothing
// the pattern does not.
function requireFacetRef(value: string): void {
    requireCanonicalId(value, "Facet reference");
    if (!FACET_REF.test(value)) {
        throw new TypeError(
            "Facet reference must be '<facet-package-id>:<instance>' with canonical segments"
        );
    }
}
