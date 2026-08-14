import { describe, expect, it } from "vitest";
import { AgentCoreError } from "../../src/errors";
import {
    OperationGateway,
    OperationRequestKey,
    ResolvedFacet,
    ResolvedFacetScope
} from "../../src/operations";
import {
    BindingName,
    FacetPackageId,
    FacetRef,
    OperationName,
    type FacetData,
    type OperationDescriptor
} from "../../src/facets";
import type { OperationDispatchResult, OperationRequest } from "../../src/operations";

class RecordedFacet extends ResolvedFacet {
    public readonly facet = new FacetRef("memory:runtime");
    public readonly package = new FacetPackageId("memory");
    public disposals = 0;

    public constructor(
        private readonly dispatchResult: () => Promise<OperationDispatchResult> = async () => ({
            kind: "direct",
            output: {}
        })
    ) {
        super();
    }

    public descriptor(_name: OperationName): OperationDescriptor | undefined {
        return undefined;
    }

    public dispatch(_request: OperationRequest): Promise<OperationDispatchResult> {
        return this.dispatchResult();
    }

    public [Symbol.dispose](): void {
        this.disposals += 1;
    }
}

class RecordedGateway extends OperationGateway {
    public resolutions = 0;

    public constructor(private readonly facets: readonly RecordedFacet[]) {
        super();
    }

    public async resolve(_binding: BindingName): Promise<ResolvedFacet> {
        const facet = this.facets[this.resolutions];
        if (facet === undefined) throw new TypeError("No recorded Facet remains");
        this.resolutions += 1;
        return facet;
    }
}

class DelayedGateway extends OperationGateway {
    readonly #pending: Promise<ResolvedFacet>;
    #resolve: ((facet: ResolvedFacet) => void) | undefined;

    public constructor() {
        super();
        this.#pending = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    public resolve(_binding: BindingName): Promise<ResolvedFacet> {
        return this.#pending;
    }

    public supply(facet: ResolvedFacet): void {
        const resolve = this.#resolve;
        if (resolve === undefined) throw new TypeError("Delayed gateway is not waiting");
        this.#resolve = undefined;
        resolve(facet);
    }
}

class DeniedAfterGateway extends OperationGateway {
    #resolved = false;

    public constructor(private readonly facet: ResolvedFacet) {
        super();
    }

    public async resolve(): Promise<ResolvedFacet> {
        if (!this.#resolved) {
            this.#resolved = true;
            return this.facet;
        }
        throw new AgentCoreError("authority.denied", "Binding resolution is no longer allowed");
    }
}

function request(): OperationRequest {
    return {
        requestKey: new OperationRequestKey("scope-request"),
        operation: new OperationName("read"),
        payload: { kind: "single", input: {} satisfies FacetData }
    };
}

async function rejectedBy(operation: () => Promise<object>): Promise<AgentCoreError> {
    try {
        await operation();
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected AgentCoreError rejection");
}

function thrownBy(operation: () => void): AgentCoreError {
    try {
        operation();
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected AgentCoreError failure");
}

describe("ResolvedFacetScope", () => {
    it(
        "[C13-FACET-DISPOSAL] releases every resolved Facet exactly once when its owner closes",
        { tags: "p0" },
        async () => {
            const first = new RecordedFacet();
            const second = new RecordedFacet();
            const scope = new ResolvedFacetScope(
                new RecordedGateway([first, second]),
                new AbortController().signal
            );

            await scope.resolve(new BindingName("first"));
            await scope.resolve(new BindingName("second"));
            scope[Symbol.dispose]();
            scope[Symbol.dispose]();

            expect(first.disposals).toBe(1);
            expect(second.disposals).toBe(1);
            const inactive = await rejectedBy(() => scope.resolve(new BindingName("after-close")));
            expect(inactive.code).toBe("facet.inactive");
        }
    );

    it(
        "[C13-FACET-DISPOSAL] releases held and concurrently resolving Facets on cancellation",
        { tags: "p0" },
        async () => {
            const controller = new AbortController();
            const held = new RecordedFacet();
            const heldScope = new ResolvedFacetScope(
                new RecordedGateway([held]),
                controller.signal
            );
            await heldScope.resolve(new BindingName("held"));

            controller.abort();

            expect(held.disposals).toBe(1);
            const cancelled = await rejectedBy(() =>
                heldScope.resolve(new BindingName("cancelled"))
            );
            expect(cancelled.code).toBe("facet.inactive");

            const delayedController = new AbortController();
            const delayedGateway = new DelayedGateway();
            const delayedScope = new ResolvedFacetScope(delayedGateway, delayedController.signal);
            const resolving = delayedScope.resolve(new BindingName("delayed"));
            delayedController.abort();
            const arrivedAfterCancellation = new RecordedFacet();
            delayedGateway.supply(arrivedAfterCancellation);

            const delayed = await rejectedBy(() => resolving);
            expect(delayed.code).toBe("facet.inactive");
            expect(arrivedAfterCancellation.disposals).toBe(1);
        }
    );

    it(
        "[C13-FACET-DISPOSAL] closes the whole scope when protected dispatch reports authority loss",
        { tags: "p0" },
        async () => {
            const denied = new RecordedFacet(async () => {
                throw new AgentCoreError("authority.denied", "Resolution is stale");
            });
            const sibling = new RecordedFacet();
            const scope = new ResolvedFacetScope(
                new RecordedGateway([denied, sibling]),
                new AbortController().signal
            );
            const deniedResolution = await scope.resolve(new BindingName("denied"));
            const siblingResolution = await scope.resolve(new BindingName("sibling"));

            const dispatchDenial = await rejectedBy(() => deniedResolution.dispatch(request()));
            expect(dispatchDenial.code).toBe("authority.denied");

            expect(denied.disposals).toBe(1);
            expect(sibling.disposals).toBe(1);
            const siblingInactive = thrownBy(() => {
                siblingResolution.descriptor(new OperationName("read"));
            });
            expect(siblingInactive.code).toBe("facet.inactive");

            const heldDuringResolution = new RecordedFacet();
            const resolutionScope = new ResolvedFacetScope(
                new DeniedAfterGateway(heldDuringResolution),
                new AbortController().signal
            );
            await resolutionScope.resolve(new BindingName("held-during-resolution"));
            const denial = await rejectedBy(() =>
                resolutionScope.resolve(new BindingName("denied-resolution"))
            );
            expect(denial.code).toBe("authority.denied");
            expect(heldDuringResolution.disposals).toBe(1);
            const inactive = await rejectedBy(() =>
                resolutionScope.resolve(new BindingName("after-resolution-denial"))
            );
            expect(inactive.code).toBe("facet.inactive");
        }
    );
});
