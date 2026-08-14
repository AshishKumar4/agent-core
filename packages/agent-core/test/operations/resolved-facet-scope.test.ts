import { describe, expect, it } from "vitest";
import { AgentCoreError } from "../../src/errors";
import { OperationGateway, OperationRequestKey, ResolvedFacet } from "../../src/operations";
import { ResolvedFacetScope } from "../../src/operations/resolved-facet-scope";
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

function request(): OperationRequest {
    return {
        requestKey: new OperationRequestKey("scope-request"),
        operation: new OperationName("read"),
        payload: { kind: "single", input: {} satisfies FacetData }
    };
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
            await expect(scope.resolve(new BindingName("after-close"))).rejects.toMatchObject({
                code: "facet.inactive"
            });
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
            await expect(heldScope.resolve(new BindingName("cancelled"))).rejects.toMatchObject({
                code: "facet.inactive"
            });

            const delayedController = new AbortController();
            const delayedGateway = new DelayedGateway();
            const delayedScope = new ResolvedFacetScope(delayedGateway, delayedController.signal);
            const resolving = delayedScope.resolve(new BindingName("delayed"));
            delayedController.abort();
            const arrivedAfterCancellation = new RecordedFacet();
            delayedGateway.supply(arrivedAfterCancellation);

            await expect(resolving).rejects.toMatchObject({ code: "facet.inactive" });
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

            await expect(deniedResolution.dispatch(request())).rejects.toMatchObject({
                code: "authority.denied"
            });

            expect(denied.disposals).toBe(1);
            expect(sibling.disposals).toBe(1);
            expect(() => siblingResolution.descriptor(new OperationName("read"))).toThrowError(
                expect.objectContaining({ code: "facet.inactive" })
            );
        }
    );
});
