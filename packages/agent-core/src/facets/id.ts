import { TextId } from "../core";

export class FacetPackageId extends TextId {
    public constructor(value: string) {
        super(value, "Facet package ID");
        requireCanonicalId(value, "Facet package ID");
        Object.freeze(this);
    }
}

export class FacetRef extends TextId {
    public constructor(value: string) {
        super(value, "Facet reference");
        requireFacetRef(value);
        Object.freeze(this);
    }
}

export class BindingName extends TextId {
    public constructor(value: string) {
        super(value, "Binding name");
        requireCanonicalId(value, "Binding name");
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

function requireFacetRef(value: string): void {
    requireCanonicalId(value, "Facet reference");
    const separator = value.indexOf(":");
    if (
        separator <= 0 ||
        separator !== value.lastIndexOf(":") ||
        separator === value.length - 1 ||
        !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*:[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value)
    ) {
        throw new TypeError(
            "Facet reference must be '<facet-package-id>:<instance>' with canonical segments"
        );
    }
}
