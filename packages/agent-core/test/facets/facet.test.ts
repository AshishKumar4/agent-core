import { describe, expect, test } from "vitest";
import { BindingSet } from "../../src/agents";
import { OperationContext } from "../../src/operations/context";
import { NoopTelemetry } from "../../src/observability/noop";
import { FacetContext } from "../../src/facets/context";
import type { FacetData, FacetDataMap } from "../../src/facets/data";
import { AuthoritySummary, FacetDescription } from "../../src/facets/description";
import { EventAddress, EventDeclaration, EventDeclarationSet } from "../../src/facets/event";
import { Facet, FacetSet } from "../../src/facets/facet";
import {
    BindingName,
    FacetId,
    FacetEventName,
    FacetOperationName,
    FacetVersion,
    SurfaceId
} from "../../src/facets/id";
import {
    FacetOperation,
    FacetOperationHandler,
    OperationAddress,
    OperationCatalog,
    OperationDescriptor,
    OperationSet
} from "../../src/facets/operation";
import { FacetDataSchemas } from "../../src/facets/data";
import { PromptContribution, PromptSection } from "../../src/facets/prompt";
import {
    Surface,
    SurfaceAction,
    SurfaceActionSet,
    SurfaceSet,
    View,
    ViewRequest
} from "../../src/facets/surface";
import { Revision } from "../../src/record";
import { testOperationContext } from "../helpers/context";

const operation = testOperationContext("facet");

function context(name: string): FacetContext {
    return new FacetContext(
        new FacetId(`facet-${name}`),
        new BindingName(name),
        operation,
        new NoopTelemetry()
    );
}

class EchoHandler extends FacetOperationHandler<FacetData, FacetData> {
    public execute(
        _context: OperationContext,
        input: FacetData
    ): Promise<FacetData> {
        return Promise.resolve(input);
    }
}

class TestSurface extends Surface {
    readonly #mediaType = "text/plain";

    public constructor(id: SurfaceId, title: string) {
        super(id, title);
    }

    public descriptor(): FacetDataMap {
        return {
            id: this.id.value,
            kind: "test",
            title: this.title
        };
    }

    public render(
        _context: OperationContext,
        request: ViewRequest
    ): Promise<View> {
        return Promise.resolve(new View(this.id, Revision.initial(), `Rendered ${String(request.input.value)}`, this.#mediaType));
    }

    public actions(): SurfaceActionSet {
        return SurfaceActionSet.of([
            new SurfaceAction(
                "Refresh",
                new EventAddress(new BindingName("surface"), new FacetEventName("surface.refresh"))
            )
        ]);
    }
}

class TestFacet extends Facet {
    public constructor(
        context: FacetContext,
        private readonly title: string,
        private readonly operationName: FacetOperationName,
        private readonly surfaceId: SurfaceId,
        private readonly eventName: string,
        private readonly childFacets: FacetSet = FacetSet.empty()
    ) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            this.title,
            `${this.title} facet`,
            new FacetVersion("1"),
            AuthoritySummary.scoped("test")
        );
    }

    public prompt(): PromptContribution {
        return PromptContribution.of([
            new PromptSection(this.title, `${this.title} prompt`, 10)
        ]);
    }

    public operations(): OperationSet {
        return OperationSet.of([
            new FacetOperation(
                new OperationDescriptor(
                    this.operationName,
                    `Echo through ${this.title}`,
                    "observe",
                    FacetDataSchemas.any(),
                    FacetDataSchemas.any()
                ),
                new EchoHandler()
            )
        ]);
    }

    public surfaces(): SurfaceSet {
        return SurfaceSet.of([
            new TestSurface(this.surfaceId, `${this.title} Surface`)
        ]);
    }

    public events(): EventDeclarationSet {
        return EventDeclarationSet.of([
            new EventDeclaration(
                new FacetEventName(this.eventName),
                `${this.title} event`,
                { facet: this.title }
            )
        ]);
    }

    public children(): FacetSet {
        return this.childFacets;
    }
}

class DuplicateOperationFacet extends Facet {
    public constructor(context: FacetContext) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Duplicate",
            "Duplicate operations",
            new FacetVersion("1"),
            AuthoritySummary.scoped("test")
        );
    }

    public operations(): OperationSet {
        return OperationSet.of([
            new FacetOperation(
                new OperationDescriptor(
                    new FacetOperationName("duplicate.echo"),
                    "First duplicate",
                    "observe",
                    FacetDataSchemas.any(),
                    FacetDataSchemas.any()
                ),
                new EchoHandler()
            ),
            new FacetOperation(
                new OperationDescriptor(
                    new FacetOperationName("duplicate.echo"),
                    "Second duplicate",
                    "observe",
                    FacetDataSchemas.any(),
                    FacetDataSchemas.any()
                ),
                new EchoHandler()
            )
        ]);
    }
}

class LifecycleFacet extends Facet {
    public constructor(
        context: FacetContext,
        private readonly log: string[],
        private readonly childFacets: FacetSet = FacetSet.empty()
    ) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            this.name.value,
            "Lifecycle facet",
            new FacetVersion("1"),
            AuthoritySummary.none()
        );
    }

    public children(): FacetSet {
        return this.childFacets;
    }

    protected onStart(_context: OperationContext): Promise<void> {
        this.log.push(`start:${this.name.value}`);
        return Promise.resolve();
    }

    protected onStop(_context: OperationContext): Promise<void> {
        this.log.push(`stop:${this.name.value}`);
        return Promise.resolve();
    }
}

function testFacet(name: string, children: FacetSet = FacetSet.empty()): TestFacet {
    return new TestFacet(
        context(name),
        name,
        new FacetOperationName(`${name}.echo`),
        new SurfaceId(`${name}-surface`),
        `${name}.changed`,
        children
    );
}

function operationNames(catalog: OperationCatalog): readonly string[] {
    return catalog.operations.map(entry => entry.name.value);
}

describe("Facet", () => {
    test("aggregates prompt, operation, and surface contributions", async () => {
        const facets = FacetSet.of([
            testFacet("first"),
            testFacet("second")
        ]);

        expect(facets.prompt().sections.map(section => section.title)).toEqual([
            "first",
            "second"
        ]);
        expect(operationNames(facets.operations())).toEqual([
            "first.echo",
            "second.echo"
        ]);
        expect(facets.surfaces().surfaces.map(surface => surface.id.value)).toEqual([
            "first-surface",
            "second-surface"
        ]);

        const operationEntry = facets.operations().operations.find(entry =>
            entry.name.equals(new FacetOperationName("first.echo"))
        );
        if (operationEntry === undefined) {
            throw new Error("Expected first.echo operation");
        }

        await expect(operationEntry.execute(operation, "value"))
            .rejects.toThrow("bound authority");
    });

    test("rejects duplicate local operation names", () => {
        expect(() => new DuplicateOperationFacet(context("duplicate")).operations()).toThrow(TypeError);
    });

    test("renders views and exposes surface actions", async () => {
        const surface = new TestSurface(new SurfaceId("render-surface"), "Renderer");

        expect(surface.descriptor()).toEqual({
            id: "render-surface",
            kind: "test",
            title: "Renderer"
        });

        const view = await surface.render(operation, new ViewRequest({ value: "content" }));
        expect(view.body).toBe("Rendered content");
        expect(view.mediaType).toBe("text/plain");
        expect(surface.actions().actions.map(action => action.title)).toEqual(["Refresh"]);
    });

    test("aggregates event declarations", () => {
        const facets = FacetSet.of([
            testFacet("first"),
            testFacet("second")
        ]);

        expect(facets.events().events.map(event => event.name.value)).toEqual([
            "first.changed",
            "second.changed"
        ]);
    });

    test("aggregates child facet contributions", () => {
        const child = testFacet("child");
        const parent = testFacet("parent", FacetSet.of([child]));
        const facets = FacetSet.of([parent]);

        expect(facets.prompt().sections.map(section => section.title)).toEqual([
            "parent",
            "child"
        ]);
        expect(operationNames(facets.operations())).toEqual([
            "parent.echo",
            "child.echo"
        ]);
        expect(facets.surfaces().surfaces.map(surface => surface.id.value)).toEqual([
            "parent-surface",
            "child-surface"
        ]);
        expect(facets.events().events.map(event => event.name.value)).toEqual([
            "parent.changed",
            "child.changed"
        ]);
    });

    test("resolves child facet operations with parent binding authority", async () => {
        const child = testFacet("child");
        const parent = testFacet("parent", FacetSet.of([child]));
        const bindings = BindingSet.of([parent]);
        await bindings.facets.start(operation);
        const operationEntry = bindings.operations().resolve(new OperationAddress(
            new BindingName("child"),
            new FacetOperationName("child.echo")
        ));
        if (operationEntry === undefined) {
            throw new Error("Expected child.echo operation");
        }

        await expect(operationEntry.execute(operation, "value")).rejects.toThrow("matching Binding authority");
        expect(await operationEntry.execute(
            testOperationContext("child-authorized", new BindingName("child"), bindings.authorityFor(new BindingName("parent")), bindings),
            "value"
        )).toBe("value");
    });

    test("starts parents before children and stops children before parents idempotently", async () => {
        const log: string[] = [];
        const child = new LifecycleFacet(context("child"), log);
        const parent = new LifecycleFacet(context("parent"), log, FacetSet.of([child]));

        await parent.start(operation);
        await parent.start(operation);
        await parent.stop(operation);
        await parent.stop(operation);

        expect(log).toEqual([
            "start:parent",
            "start:child",
            "stop:child",
            "stop:parent"
        ]);
    });
});
