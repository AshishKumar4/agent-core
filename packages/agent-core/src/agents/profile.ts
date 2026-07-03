import type { ContentRef } from "../record";
import type { BindingName, FacetId } from "../facets";
import type { AgentProfileId } from "./id";

export class AgentProfileFacetSpec {
    public constructor(
        public readonly facetId: FacetId,
        public readonly bindingName: BindingName
    ) {
    }
}

export class AgentProfileFacetSpecSet {
    public readonly specs: readonly AgentProfileFacetSpec[];

    public constructor(specs: readonly AgentProfileFacetSpec[]) {
        this.specs = Object.freeze([...specs]);
        this.ensureUniqueBindingNames();
    }

    public static empty(): AgentProfileFacetSpecSet {
        return emptyAgentProfileFacetSpecSet;
    }

    public static of(specs: readonly AgentProfileFacetSpec[]): AgentProfileFacetSpecSet {
        return new AgentProfileFacetSpecSet(specs);
    }

    public merge(other: AgentProfileFacetSpecSet): AgentProfileFacetSpecSet {
        return new AgentProfileFacetSpecSet([...this.specs, ...other.specs]);
    }

    public hasBinding(bindingName: BindingName): boolean {
        return this.specs.some(spec => spec.bindingName.equals(bindingName));
    }

    private ensureUniqueBindingNames(): void {
        const names = new Set<string>();

        for (const spec of this.specs) {
            const name = spec.bindingName.value;
            if (names.has(name)) {
                throw new TypeError("Agent profile facet binding names must be unique");
            }

            names.add(name);
        }
    }
}

export class AgentProfile {
    public constructor(
        public readonly id: AgentProfileId,
        public readonly name: string,
        public readonly instructionsRef: ContentRef,
        public readonly ambientFacetSpecs: AgentProfileFacetSpecSet = AgentProfileFacetSpecSet.empty(),
        public readonly boundFacetSpecs: AgentProfileFacetSpecSet = AgentProfileFacetSpecSet.empty()
    ) {
        if (name.length === 0 || name.length > 256) {
            throw new TypeError("Agent profile name must contain between 1 and 256 characters");
        }

        for (const spec of ambientFacetSpecs.specs) {
            if (boundFacetSpecs.hasBinding(spec.bindingName)) {
                throw new TypeError("Agent profile ambient and bound facet names must be unique");
            }
        }
    }

    public get facetSpecs(): AgentProfileFacetSpecSet {
        return this.ambientFacetSpecs.merge(this.boundFacetSpecs);
    }
}

const emptyAgentProfileFacetSpecSet = new AgentProfileFacetSpecSet([]);
