import type { FacetDataMap } from "./data";
import type { BindingName, FacetEventName } from "./id";

export class EventAddress {
    public constructor(
        public readonly bindingName: BindingName,
        public readonly eventName: FacetEventName
    ) {
    }

    public equals(other: EventAddress): boolean {
        return this.bindingName.equals(other.bindingName)
            && this.eventName.equals(other.eventName);
    }
}

export class EventDeclaration {
    public constructor(
        public readonly name: FacetEventName,
        public readonly description: string,
        public readonly payloadSchema: FacetDataMap | undefined = undefined
    ) {
    }
}

export class EventDeclarationSet {
    public readonly events: readonly EventDeclaration[];

    public constructor(events: readonly EventDeclaration[]) {
        ensureUniqueEventNames(events);
        this.events = Object.freeze([...events]);
    }

    public static empty(): EventDeclarationSet {
        return emptyEventDeclarationSet;
    }

    public static of(events: readonly EventDeclaration[]): EventDeclarationSet {
        return new EventDeclarationSet(events);
    }

    public merge(other: EventDeclarationSet): EventDeclarationSet {
        return new EventDeclarationSet([...this.events, ...other.events]);
    }

    public resolve(name: FacetEventName): EventDeclaration | undefined {
        return this.events.find(event => event.name.equals(name));
    }
}

function ensureUniqueEventNames(events: readonly EventDeclaration[]): void {
    const names = new Set<string>();

    for (const event of events) {
        const name = event.name.value;
        if (names.has(name)) {
            throw new TypeError(`Facet events must have unique names: ${name}`);
        }

        names.add(name);
    }
}

const emptyEventDeclarationSet = new EventDeclarationSet([]);
