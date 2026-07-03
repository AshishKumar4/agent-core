import type { OperationContext } from "../operations/context";
import type { FacetContext } from "./context";
import type { FacetDescription } from "./description";
import { EventDeclarationSet } from "./event";
import { OperationCatalog, OperationSet } from "./operation";
import { PromptContribution } from "./prompt";
import { SurfaceSet } from "./surface";

export abstract class Facet {
    #started = false;
    #starting: Promise<void> | undefined;
    #stopping: Promise<void> | undefined;

    protected constructor(protected readonly context: FacetContext) {
    }

    public get id() {
        return this.context.id;
    }

    public get name() {
        return this.context.name;
    }

    public get domain() {
        return this.context.operation.domain;
    }

    public get active(): boolean {
        return this.#started;
    }

    public abstract describe(): FacetDescription;

    public prompt(): PromptContribution {
        return PromptContribution.empty();
    }

    public operations(): OperationSet {
        return OperationSet.empty();
    }

    public surfaces(): SurfaceSet {
        return SurfaceSet.empty();
    }

    public events(): EventDeclarationSet {
        return EventDeclarationSet.empty();
    }

    public children(): FacetSet {
        return FacetSet.empty();
    }

    public start(context: OperationContext): Promise<void> {
        if (this.#started) {
            return Promise.resolve();
        }

        if (this.#starting !== undefined) {
            return this.#starting;
        }

        this.#starting = this.startFacet(context);
        return this.#starting;
    }

    public stop(context: OperationContext): Promise<void> {
        if (!this.#started && this.#starting === undefined) {
            return Promise.resolve();
        }

        if (this.#stopping !== undefined) {
            return this.#stopping;
        }

        this.#stopping = this.stopFacet(context);
        return this.#stopping;
    }

    protected onStart(_context: OperationContext): Promise<void> {
        return Promise.resolve();
    }

    protected onStop(_context: OperationContext): Promise<void> {
        return Promise.resolve();
    }

    private async startFacet(context: OperationContext): Promise<void> {
        try {
            await this.onStart(context);
            await this.children().start(context);
            this.#started = true;
        } catch (error) {
            this.#starting = undefined;
            throw error;
        }
    }

    private async stopFacet(context: OperationContext): Promise<void> {
        try {
            if (this.#starting !== undefined) {
                await this.#starting;
            }

            if (!this.#started) {
                return;
            }

            await this.children().stop(context);
            await this.onStop(context);
            this.#started = false;
            this.#starting = undefined;
        } finally {
            this.#stopping = undefined;
        }
    }
}

export class FacetSet {
    public readonly facets: readonly Facet[];

    public constructor(facets: readonly Facet[]) {
        this.facets = Object.freeze([...facets]);
    }

    public static empty(): FacetSet {
        return emptyFacetSet;
    }

    public static of(facets: readonly Facet[]): FacetSet {
        return new FacetSet(facets);
    }

    public prompt(): PromptContribution {
        return this.facets.reduce(
            (contribution, facet) => contribution
                .merge(facet.prompt())
                .merge(facet.children().prompt()),
            PromptContribution.empty()
        );
    }

    public operations(): OperationCatalog {
        return this.facets.reduce(
            (catalog, facet) => catalog
                .merge(OperationCatalog.from(facet.name, facet.operations()))
                .merge(facet.children().operations()),
            OperationCatalog.empty()
        );
    }

    public surfaces(): SurfaceSet {
        return this.facets.reduce(
            (surfaces, facet) => surfaces
                .merge(facet.surfaces())
                .merge(facet.children().surfaces()),
            SurfaceSet.empty()
        );
    }

    public events(): EventDeclarationSet {
        return this.facets.reduce(
            (events, facet) => events
                .merge(facet.events())
                .merge(facet.children().events()),
            EventDeclarationSet.empty()
        );
    }

    public async start(context: OperationContext): Promise<void> {
        for (const facet of this.facets) {
            await facet.start(context);
        }
    }

    public async stop(context: OperationContext): Promise<void> {
        for (const facet of this.facets.toReversed()) {
            await facet.stop(context);
        }
    }
}

const emptyFacetSet = new FacetSet([]);
