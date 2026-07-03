import { FacetDataSchemas, type FacetData, type FacetDataMap } from "./data";
import type { EventAddress } from "./event";
import type { SurfaceId } from "./id";
import type { OperationContext } from "../operations";
import { EventKind, EventRecord } from "../workspaces/events";
import type { EventSource, EventVisibility } from "../workspaces/events";
import type { EventId, WorkspaceId } from "../workspaces/id";
import { Revision } from "../record";

const emptyFacetDataMap: FacetDataMap = Object.freeze({});

export class ViewRequest {
    public constructor(public readonly input: FacetDataMap = emptyFacetDataMap) {
        if (!FacetDataSchemas.object().accepts(input)) {
            throw new TypeError("View request input must be Facet data");
        }
    }
}

export class EventCursor {
    public constructor(
        public readonly eventId: EventId | undefined,
        public readonly revision: Revision
    ) {
    }

    public static initial(): EventCursor {
        return new EventCursor(undefined, Revision.initial());
    }
}

export class View {
    public readonly actions: readonly SurfaceAction[];

    public constructor(
        public readonly surface: SurfaceId,
        public readonly revision: Revision,
        public readonly body: FacetData,
        public readonly mediaType: string,
        actions: readonly SurfaceAction[] = [],
        public readonly cursor: EventCursor = EventCursor.initial()
    ) {
        if (!FacetDataSchemas.any().accepts(body)) {
            throw new TypeError("View body must be Facet data");
        }

        this.actions = Object.freeze([...actions]);
    }

}

export class SurfaceAction {
    public constructor(
        public readonly title: string,
        public readonly event: EventAddress,
        public readonly payload: FacetDataMap = emptyFacetDataMap
    ) {
        if (title.length === 0) {
            throw new TypeError("View action title must not be empty");
        }

        if (!FacetDataSchemas.object().accepts(payload)) {
            throw new TypeError("Surface action payload must be Facet data");
        }
    }

    public emit(request: ViewActionEmitRequest): EventRecord {
        return new EventRecord(
            request.id,
            request.workspaceId,
            new EventKind(`${this.event.bindingName.value}.${this.event.eventName.value}`),
            request.source,
            request.visibility,
            this.payload,
            undefined,
            request.occurredAt,
            request.revision
        );
    }
}

export class SurfaceActionSet {
    public readonly actions: readonly SurfaceAction[];

    public constructor(actions: readonly SurfaceAction[]) {
        this.actions = Object.freeze([...actions]);
    }

    public static empty(): SurfaceActionSet {
        return emptySurfaceActionSet;
    }

    public static of(actions: readonly SurfaceAction[]): SurfaceActionSet {
        return new SurfaceActionSet(actions);
    }
}

export interface ViewActionEmitRequest {
    readonly id: EventId;
    readonly workspaceId: WorkspaceId;
    readonly source: EventSource;
    readonly visibility: EventVisibility;
    readonly occurredAt: Date;
    readonly revision: Revision;
}

export abstract class Surface {
    public constructor(
        public readonly id: SurfaceId,
        public readonly title: string
    ) {
    }

    public abstract descriptor(): FacetDataMap;

    public abstract actions(): SurfaceActionSet;

    public abstract render(context: OperationContext, request: ViewRequest): Promise<View>;
}

export class SurfaceSet {
    public readonly surfaces: readonly Surface[];

    public constructor(surfaces: readonly Surface[]) {
        this.surfaces = Object.freeze([...surfaces]);
    }

    public static empty(): SurfaceSet {
        return emptySurfaceSet;
    }

    public static of(surfaces: readonly Surface[]): SurfaceSet {
        return new SurfaceSet(surfaces);
    }

    public merge(other: SurfaceSet): SurfaceSet {
        return new SurfaceSet([...this.surfaces, ...other.surfaces]);
    }
}

const emptySurfaceSet = new SurfaceSet([]);
const emptySurfaceActionSet = new SurfaceActionSet([]);
