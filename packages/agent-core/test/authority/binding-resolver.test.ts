import { describe, expect, test } from "vitest";
import { BindingSet } from "../../src/agents";
import {
    BindingId,
    BindingRecord,
    GrantId,
    GrantRecord,
    MemoryBindingStore,
    MemoryFacetRegistry,
    MemoryGrantStore,
    StoredBindingResolver,
    type AuthorityVerifier,
    type BindingAuthority
} from "../../src/authority";
import {
    AuthoritySummary,
    BindingName,
    Facet,
    FacetContext,
    FacetDataSchemas,
    FacetDescription,
    FacetId,
    FacetOperation,
    FacetOperationHandler,
    FacetOperationName,
    FacetVersion,
    OperationAddress,
    OperationDescriptor,
    OperationSet,
    type FacetDataMap
} from "../../src/facets";
import { NoopTelemetry } from "../../src/observability";
import type { OperationContext } from "../../src/operations";
import { Revision } from "../../src/record";
import { testOperationContext } from "../helpers/context";

const operationName = new FacetOperationName("tasks.record");

function operation(
    name: string,
    binding: BindingName = new BindingName("tasks"),
    authority: BindingAuthority | undefined = undefined,
    authorityVerifier: AuthorityVerifier | undefined = undefined
) {
    return testOperationContext(name, binding, authority, authorityVerifier);
}

function facetContext(name: string): FacetContext {
    return new FacetContext(
        new FacetId(`facet-${name}`),
        new BindingName(name),
        operation(`facet-${name}`),
        new NoopTelemetry()
    );
}

class RecordingHandler extends FacetOperationHandler<FacetDataMap, FacetDataMap> {
    public readonly inputs: FacetDataMap[] = [];

    public execute(
        _context: OperationContext,
        input: FacetDataMap
    ): Promise<FacetDataMap> {
        this.inputs.push(input);
        return Promise.resolve({ ok: true });
    }
}

class TaskFacet extends Facet {
    public constructor(
        context: FacetContext,
        private readonly handler: RecordingHandler
    ) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Tasks",
            "Records task state",
            new FacetVersion("1"),
            AuthoritySummary.scoped("tasks")
        );
    }

    public operations(): OperationSet {
        return OperationSet.of([
            new FacetOperation(
                new OperationDescriptor(
                    operationName,
                    "Record task state",
                    "mutate",
                    FacetDataSchemas.object(),
                    FacetDataSchemas.object()
                ),
                this.handler
            )
        ]);
    }
}

describe("Stored binding resolver", () => {
    test("uses current durable Grant state when authorizing a previously resolved operation", async () => {
        const handler = new RecordingHandler();
        const facet = new TaskFacet(facetContext("tasks"), handler);
        const revision = Revision.initial();
        const grant = new GrantRecord(
            new GrantId("grant-tasks"),
            facet.domain,
            "active",
            revision
        );
        const binding = new BindingRecord(
            new BindingId("binding-tasks"),
            facet.name,
            grant.id,
            revision
        );
        const grants = new MemoryGrantStore([grant]);
        const bindings = new MemoryBindingStore([binding]);
        const registry = new MemoryFacetRegistry([facet]);
        const resolver = new StoredBindingResolver(bindings, grants);

        const initialBindings = await BindingSet.fromResolver(resolver, registry);
        await initialBindings.facets.start(operation("start"));
        const operationBinding = initialBindings.operations().resolve(
            new OperationAddress(facet.name, operationName)
        );
        const authority = initialBindings.authorityFor(facet.name);
        if (operationBinding === undefined || authority === undefined) {
            throw new Error("Expected initial binding authority");
        }

        await expect(operationBinding.execute(
            operation("active", facet.name, authority, initialBindings),
            { taskId: "task-1" }
        )).resolves.toEqual({ ok: true });

        await grants.put(grant.revoke());
        const revokedBindings = await BindingSet.fromResolver(resolver, registry);
        expect(revokedBindings.resolve(facet.name)).toBeUndefined();
        expect(revokedBindings.permits(authority)).toBe(false);
        await expect(operationBinding.execute(
            operation("revoked", facet.name, authority, revokedBindings),
            { taskId: "task-2" }
        )).rejects.toMatchObject({ code: "authority.denied" });
        expect(handler.inputs).toEqual([{ taskId: "task-1" }]);
    });
});
