import { TextId } from "../core";

export class FacetId extends TextId {
    public constructor(value: string) {
        super(value, "Facet ID");
    }

    protected get type(): "facet" {
        return "facet";
    }
}

export class BindingName extends TextId {
    public constructor(value: string) {
        super(value, "Binding name");
    }

    protected get type(): "binding" {
        return "binding";
    }
}

export class FacetVersion extends TextId {
    public constructor(value: string) {
        super(value, "Facet version");
    }

    protected get type(): "facet-version" {
        return "facet-version";
    }
}

export class FacetOperationName extends TextId {
    public constructor(value: string) {
        super(value, "Facet operation name");
    }

    protected get type(): "facet-operation" {
        return "facet-operation";
    }
}

export class FacetEventName extends TextId {
    public constructor(value: string) {
        super(value, "Facet event name");
    }

    protected get type(): "facet-event" {
        return "facet-event";
    }
}

export class SurfaceId extends TextId {
    public constructor(value: string) {
        super(value, "Surface ID");
    }

    protected get type(): "surface" {
        return "surface";
    }
}
