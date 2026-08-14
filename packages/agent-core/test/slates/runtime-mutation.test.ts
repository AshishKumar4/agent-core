import { describe, expect, test } from "vitest";
import { malformed } from "../helpers/malformed";
import { ContentRef, Digest, Revision } from "../../src/core";
import {
    EnvironmentId,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    PortExposureId
} from "../../src/environments";
import { InvocationId, ReceiptId } from "../../src/invocations";
import {
    MemorySlateIdSource,
    MemorySlateStore,
    Slate,
    SlateDeployment,
    SlateDeploymentId,
    SlateDeploymentReservation,
    SlateEffectContext,
    SlateId,
    SlateInvocationSeam,
    SlateMutationSeam,
    SlatePreviewValidationSeam,
    SlateProvider,
    SlatePublication,
    SlatePublicationId,
    SlateRuntime,
    SlateStore,
    SlateVersion,
    SlateVersionId,
    type SlateInvocationRequest,
    type SlateInvocationResult,
    type SlateMutationRequest,
    type SlatePreviewLinkIntent,
    type SlateProviderDeployment,
    type SlateProviderDeploymentRequest,
    type SlateProviderResource,
    type SlateProviderResourceRequest
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";

describe("SlateRuntime mutation kills", () => {
    test("rejects non-canonical external keys before reserving", { tags: "p0" }, async () => {
        const fixture = runtimeFixture("external-key");
        const { publication } = await publishedSlate(fixture);
        const error = expect.objectContaining({
            code: "operation.invalid-input",
            message: "Slate deployment external key must be canonical"
        });

        await expect(
            fixture.runtime.deploy(publication.id, "production", " padded ")
        ).rejects.toEqual(error);
        await expect(fixture.runtime.deploy(publication.id, "production", "")).rejects.toEqual(
            error
        );
        await expect(
            fixture.runtime.deploy(publication.id, "production", malformed<string>(7))
        ).rejects.toEqual(error);
        expect(fixture.provider.deployRequests).toHaveLength(0);
        expect(fixture.store.snapshot().deploymentReservations).toHaveLength(0);
    });

    test(
        "reconcile reports activation only for the active deployment",
        { tags: "p0" },
        async () => {
            const fixture = runtimeFixture("activated-flag");
            const { publication } = await publishedSlate(fixture);
            const first = await fixture.runtime.deploy(
                publication.id,
                "first",
                "external-active-1"
            );
            const second = await fixture.runtime.deploy(
                publication.id,
                "second",
                "external-active-2"
            );
            if (first.outcome !== "succeeded" || second.outcome !== "succeeded") {
                throw new TypeError("Expected successful deployments");
            }

            const firstReplay = await fixture.runtime.reconcileDeployment(first.deployment.id);
            const secondReplay = await fixture.runtime.reconcileDeployment(second.deployment.id);
            if (firstReplay.outcome !== "succeeded" || secondReplay.outcome !== "succeeded") {
                throw new TypeError("Expected successful replays");
            }

            expect(firstReplay.activated).toBe(false);
            expect(secondReplay.activated).toBe(true);
        }
    );

    test("reservations pin the frozen expected active deployment", { tags: "p0" }, async () => {
        const fixture = runtimeFixture("expected-pointer");
        const { publication } = await publishedSlate(fixture);
        const first = await fixture.runtime.deploy(publication.id, "first", "external-pointer-1");
        if (first.outcome !== "succeeded") throw new TypeError("Expected first deployment");
        const second = await fixture.runtime.deploy(publication.id, "second", "external-pointer-2");
        if (second.outcome !== "succeeded") throw new TypeError("Expected second deployment");

        const firstReservation = fixture.store.getDeploymentReservation(first.deployment.id);
        const secondReservation = fixture.store.getDeploymentReservation(second.deployment.id);

        expect(firstReservation?.expectedActiveDeploymentId).toBeUndefined();
        expect(secondReservation?.expectedActiveDeploymentId?.equals(first.deployment.id)).toBe(
            true
        );
    });

    test("allocates prefixed IDs for every kind in sequence", { tags: "p1" }, () => {
        const defaultSource = new MemorySlateIdSource();
        expect(defaultSource.allocateSlateId().value).toBe("slate-slate-0");

        const source = new MemorySlateIdSource("wave");
        expect(source.allocateSlateId().value).toBe("wave-slate-0");
        expect(source.allocateVersionId().value).toBe("wave-version-1");
        expect(source.allocatePublicationId().value).toBe("wave-publication-2");
        expect(source.allocateDeploymentId().value).toBe("wave-deployment-3");
        expect(source.allocateResourceId().value).toBe("wave-resource-4");
        expect(source.allocatePreviewId().value).toBe("wave-preview-5");
    });

    test("rejects succeeded invocation results with extra keys", { tags: "p1" }, async () => {
        const fixture = runtimeFixture("succeeded-extra-key");
        const { publication } = await publishedSlate(fixture);
        fixture.invocations.resultOverride = {
            outcome: "succeeded",
            receiptId: new ReceiptId("receipt-extra-key"),
            value: { materialization: ref("extra") },
            extra: true
        };

        await expect(
            fixture.runtime.deploy(publication.id, "production", "external-extra-key")
        ).rejects.toEqual(
            expect.objectContaining({
                code: "invocation.invalid",
                message: "Slate invocation result is malformed"
            })
        );
    });

    test("rejects malformed provider materializations exactly", { tags: "p1" }, async () => {
        const fixture = runtimeFixture("malformed-materialization");
        const { publication } = await publishedSlate(fixture);
        const deploymentError = expect.objectContaining({
            code: "operation.invalid-output",
            message: "Slate provider deployment result is malformed"
        });
        let sequence = 0;
        for (const malformed of [null, "materialized", { materialization: "not-a-ref" }, {}]) {
            fixture.provider.deploymentResult = malformed;
            sequence += 1;
            await expect(
                fixture.runtime.deploy(
                    publication.id,
                    "production",
                    `external-malformed-provider-${sequence}`
                )
            ).rejects.toEqual(deploymentError);
        }
        fixture.provider.deploymentResult = undefined;

        const deployed = await fixture.runtime.deploy(
            publication.id,
            "production",
            "external-resource-host"
        );
        if (deployed.outcome !== "succeeded") throw new TypeError("Expected deployment");
        fixture.provider.resourceResult = null;
        await expect(
            fixture.runtime.materializeResource(deployed.deployment.id, "database", ref("schema"))
        ).rejects.toEqual(
            expect.objectContaining({
                code: "operation.invalid-output",
                message: "Slate provider resource result is malformed"
            })
        );
    });

    test("commit revalidates source lineage inside the transaction", { tags: "p1" }, async () => {
        const fixture = runtimeFixture("commit-lineage");
        const slate = await fixture.runtime.create(fixture.workspace, ref("original"));
        fixture.mutations.beforeMutation = (request) => {
            if (request.operation !== "commit") return;
            const current = fixture.store.getSlate(slate.id)!;
            fixture.store.compareAndSetSlate(current.revision, current.update(ref("interleaved")));
        };

        await expect(fixture.runtime.commit(slate.id, new Revision(1))).rejects.toMatchObject({
            code: "protocol.revision-conflict"
        });
        expect(fixture.store.listVersions(slate.id)).toEqual([]);
    });

    test("commit revalidates head lineage inside the transaction", { tags: "p1" }, async () => {
        const fixture = runtimeFixture("commit-head");
        const slate = await fixture.runtime.create(fixture.workspace, ref("head-source"));
        const first = await fixture.runtime.commit(slate.id);
        fixture.mutations.beforeMutation = (request) => {
            if (request.operation !== "commit") return;
            const current = fixture.store.getSlate(slate.id)!;
            const interleaved = new SlateVersion(
                new SlateVersionId("version-commit-head-interleaved"),
                fixture.workspace,
                slate.id,
                current.source,
                first.id
            );
            fixture.store.addVersion(interleaved);
            fixture.store.compareAndSetSlate(current.revision, current.commit(interleaved.id));
        };

        await expect(fixture.runtime.commit(slate.id, new Revision(2))).rejects.toMatchObject({
            code: "protocol.revision-conflict"
        });
    });

    test("commit refuses a head that vanished inside the transaction", { tags: "p1" }, async () => {
        const store = new DraftDoctoringStore();
        const fixture = runtimeFixture("commit-strip", store);
        const slate = await fixture.runtime.create(fixture.workspace, ref("strip-source"));
        await fixture.runtime.commit(slate.id);
        store.doctorSlate = (current) =>
            current.id.equals(slate.id)
                ? new Slate({
                      id: current.id,
                      workspaceId: current.workspaceId,
                      source: current.source,
                      revision: current.revision
                  })
                : current;

        await expect(fixture.runtime.commit(slate.id)).rejects.toMatchObject({
            code: "protocol.revision-conflict"
        });
    });

    test(
        "fork revalidates the exact source graph inside the transaction",
        { tags: "p1" },
        async () => {
            const store = new DraftDoctoringStore();
            const fixture = runtimeFixture("fork-revalidate", store);
            const slate = await fixture.runtime.create(fixture.workspace, ref("fork-source"));
            const version = await fixture.runtime.commit(slate.id);
            store.doctorSlate = (current) =>
                current.id.equals(slate.id) ? doctoredSlate(current) : current;

            await expect(fixture.runtime.fork(version.id, fixture.workspace)).rejects.toMatchObject(
                {
                    code: "protocol.revision-conflict"
                }
            );
            expect(fixture.store.listSlates()).toHaveLength(1);
        }
    );

    test(
        "publish revalidates the version binding inside the transaction",
        { tags: "p1" },
        async () => {
            const store = new DraftDoctoringStore();
            const fixture = runtimeFixture("publish-revalidate", store);
            const slate = await fixture.runtime.create(fixture.workspace, ref("publish-source"));
            const version = await fixture.runtime.commit(slate.id);
            store.doctorVersion = (current) =>
                current.id.equals(version.id)
                    ? new SlateVersion(
                          current.id,
                          current.workspaceId,
                          current.slateId,
                          ref("publish-drifted"),
                          current.parentVersionId
                      )
                    : current;

            await expect(
                fixture.runtime.publish(version.id, ref("publish-materialization"))
            ).rejects.toMatchObject({ code: "protocol.revision-conflict" });
            expect(fixture.store.listPublications(slate.id)).toEqual([]);
        }
    );

    test(
        "preview links pin the exact revision even when the source is unchanged",
        { tags: "p1" },
        async () => {
            const fixture = runtimeFixture("preview-pin");
            const slate = await fixture.runtime.create(fixture.workspace, ref("preview-source"));
            fixture.mutations.beforeMutation = (request) => {
                if (request.operation !== "preview.link") return;
                const current = fixture.store.getSlate(slate.id)!;
                const version = new SlateVersion(
                    new SlateVersionId("version-preview-pin"),
                    fixture.workspace,
                    slate.id,
                    current.source
                );
                fixture.store.addVersion(version);
                fixture.store.compareAndSetSlate(current.revision, current.commit(version.id));
            };

            await expect(
                fixture.runtime.linkPreview(
                    slate.id,
                    sessionCapability("preview-pin", 0, 0),
                    new PortExposureId("exposure-preview-pin")
                )
            ).rejects.toMatchObject({ code: "protocol.revision-conflict" });
            expect(fixture.store.listPreviews(slate.id)).toEqual([]);
        }
    );

    test(
        "reconciled completed deployments report inactive slates without activation",
        { tags: "p1" },
        async () => {
            const graph = inactiveDeploymentStore("reconcile-inactive");
            const fixture = runtimeFixture("reconcile-inactive", graph.store);

            const outcome = await fixture.runtime.reconcileDeployment(graph.deployment.id);

            if (outcome.outcome !== "succeeded")
                throw new TypeError("Expected completed deployment");
            expect(outcome.activated).toBe(false);
            expect(outcome.deployment.id.equals(graph.deployment.id)).toBe(true);
        }
    );

    test(
        "rollback pins the expected pointer and activates inactive slates",
        { tags: "p0" },
        async () => {
            const graph = inactiveDeploymentStore("rollback-inactive");
            const fixture = runtimeFixture("rollback-inactive", graph.store);

            await expect(
                fixture.runtime.rollback(graph.slate.id, graph.deployment.id, graph.deployment.id)
            ).rejects.toMatchObject({ code: "protocol.revision-conflict" });
            expect(graph.store.getSlate(graph.slate.id)?.activeDeploymentId).toBeUndefined();

            const activated = await fixture.runtime.rollback(graph.slate.id, graph.deployment.id);
            expect(activated.activeDeploymentId?.equals(graph.deployment.id)).toBe(true);
            expect(
                graph.store
                    .getSlate(graph.slate.id)
                    ?.activeDeploymentId?.equals(graph.deployment.id)
            ).toBe(true);
        }
    );

    test("rejects function-shaped and value-less invocation results", { tags: "p1" }, async () => {
        const fixture = runtimeFixture("hostile-results");
        const { publication } = await publishedSlate(fixture);
        const functionResult = Object.assign(() => undefined, {
            outcome: "failed",
            receiptId: new ReceiptId("receipt-function-result")
        });
        Reflect.deleteProperty(functionResult, "length");
        Reflect.deleteProperty(functionResult, "name");
        fixture.invocations.resultOverride = functionResult;
        await expect(
            fixture.runtime.deploy(publication.id, "production", "external-function-result")
        ).rejects.toMatchObject({ code: "invocation.invalid" });

        fixture.invocations.resultOverride = {
            outcome: "succeeded",
            receiptId: new ReceiptId("receipt-value-less"),
            extra: true
        };
        await expect(
            fixture.runtime.deploy(publication.id, "production", "external-value-less")
        ).rejects.toMatchObject({ code: "invocation.invalid" });
    });

    test(
        "canonicalizes mediated and provider results from own data descriptors",
        { tags: "p0" },
        async () => {
            const failedFixture = runtimeFixture("descriptor-invocation-result");
            const { publication: failedPublication } = await publishedSlate(failedFixture);
            failedFixture.invocations.resultOverride = new Proxy(
                {
                    outcome: "failed",
                    receiptId: new ReceiptId("receipt-descriptor-result")
                },
                {
                    get(_target, key) {
                        if (key === "then") return undefined;
                        throw new RangeError("invocation result property read");
                    }
                }
            );

            await expect(
                failedFixture.runtime.deploy(
                    failedPublication.id,
                    "production",
                    "external-descriptor-result"
                )
            ).resolves.toMatchObject({ outcome: "failed" });

            const readyFixture = runtimeFixture("descriptor-provider-result");
            const { publication: readyPublication } = await publishedSlate(readyFixture);
            readyFixture.provider.deploymentResult = new Proxy(
                { materialization: ref("descriptor-provider-materialization") },
                {
                    get(_target, key) {
                        if (key === "then") return undefined;
                        throw new RangeError("provider result property read");
                    }
                }
            );

            const deployed = await readyFixture.runtime.deploy(
                readyPublication.id,
                "production",
                "external-descriptor-provider"
            );

            expect(deployed.outcome).toBe("succeeded");
        }
    );

    test("maps result descriptor traps to stable domain errors", { tags: "p0" }, async () => {
        const invocationFixture = runtimeFixture("descriptor-invocation-trap");
        const { publication: invocationPublication } = await publishedSlate(invocationFixture);
        invocationFixture.invocations.resultOverride = new Proxy(
            {
                outcome: "failed",
                receiptId: new ReceiptId("receipt-descriptor-trap")
            },
            {
                getOwnPropertyDescriptor() {
                    throw new RangeError("invocation result descriptor trap");
                }
            }
        );

        await expect(
            invocationFixture.runtime.deploy(
                invocationPublication.id,
                "production",
                "external-descriptor-trap"
            )
        ).rejects.toMatchObject({ code: "invocation.invalid" });

        const providerFixture = runtimeFixture("descriptor-provider-trap");
        const { publication: providerPublication } = await publishedSlate(providerFixture);
        providerFixture.provider.deploymentResult = new Proxy(
            { materialization: ref("descriptor-provider-trap") },
            {
                getOwnPropertyDescriptor() {
                    throw new RangeError("provider result descriptor trap");
                }
            }
        );

        await expect(
            providerFixture.runtime.deploy(
                providerPublication.id,
                "production",
                "external-provider-descriptor-trap"
            )
        ).rejects.toMatchObject({ code: "operation.invalid-output" });
    });
});

class StubMutationSeam extends SlateMutationSeam {
    public beforeMutation: ((request: SlateMutationRequest) => void) | undefined;

    public mutate<Result>(request: SlateMutationRequest, mutation: () => Result): Promise<Result> {
        expect(Object.isFrozen(request)).toBe(true);
        this.beforeMutation?.(request);
        return Promise.resolve(mutation());
    }
}

class DraftDoctoringStore extends MemorySlateStore {
    public doctorSlate: ((slate: Slate) => Slate) | undefined;
    public doctorVersion: ((version: SlateVersion) => SlateVersion) | undefined;
    #inTransaction = false;

    public override transaction<Result>(operation: (store: SlateStore) => Result): Result {
        this.#inTransaction = true;
        try {
            return operation(this);
        } finally {
            this.#inTransaction = false;
        }
    }

    public override getSlate(id: SlateId): Slate | undefined {
        const slate = super.getSlate(id);
        return slate === undefined || !this.#inTransaction || this.doctorSlate === undefined
            ? slate
            : this.doctorSlate(slate);
    }

    public override getVersion(id: SlateVersionId): SlateVersion | undefined {
        const version = super.getVersion(id);
        return version === undefined || !this.#inTransaction || this.doctorVersion === undefined
            ? version
            : this.doctorVersion(version);
    }
}

class StubInvocationSeam extends SlateInvocationSeam {
    #sequence = 0;
    public resultOverride: unknown | undefined;

    public prepare(request: SlateInvocationRequest): Promise<InvocationId> {
        expect(Object.isFrozen(request)).toBe(true);
        return Promise.resolve(new InvocationId(`invocation-${this.#sequence++}`));
    }

    public async invoke<Result>(
        _request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        return this.run(invocationId, effect);
    }

    public async reconcile<Result>(
        _request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        return this.run(invocationId, effect);
    }

    private async run<Result>(
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        if (this.resultOverride !== undefined) {
            // SAFETY: the override is a provider result the runtime must reject; it is
            // never a well-formed result for the caller's Result, which is the check here.
            return this.resultOverride as SlateInvocationResult<Result>;
        }
        const receiptId = new ReceiptId(`receipt-${this.#sequence++}`);
        const value = await effect(
            new SlateEffectContext(invocationId, 0, 0, `slate-item:${invocationId.value}:0`)
        );
        return { outcome: "succeeded", receiptId, value };
    }
}

class StubPreviewValidation extends SlatePreviewValidationSeam {
    public validate(request: SlatePreviewLinkIntent): Promise<void> {
        expect(Object.isFrozen(request)).toBe(true);
        return Promise.resolve();
    }
}

class StubProvider extends SlateProvider {
    public readonly deployRequests: SlateProviderDeploymentRequest[] = [];
    public deploymentResult: unknown | undefined;
    public resourceResult: unknown | undefined;

    public deploy(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment> {
        this.deployRequests.push(request);
        if (this.deploymentResult !== undefined) {
            // SAFETY: the override carries fields SlateProviderDeployment does not
            // declare, so the runtime's output check is the only thing that turns it away.
            return Promise.resolve(this.deploymentResult as SlateProviderDeployment);
        }
        return Promise.resolve({
            materialization: ref(`deployment-${request.deploymentId.value}`)
        });
    }

    public reconcileDeployment(
        request: SlateProviderDeploymentRequest
    ): Promise<SlateProviderDeployment> {
        return Promise.resolve({
            materialization: ref(`reconciled-${request.deploymentId.value}`)
        });
    }

    public materializeResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        if (this.resourceResult !== undefined) {
            // SAFETY: the override carries fields SlateProviderResource does not declare,
            // so the runtime's output check is the only thing that turns it away.
            return Promise.resolve(this.resourceResult as SlateProviderResource);
        }
        return Promise.resolve({ materialization: ref(`resource-${request.resourceId.value}`) });
    }

    public reconcileResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        return Promise.resolve({ materialization: ref(`resource-${request.resourceId.value}`) });
    }
}

interface RuntimeFixture {
    readonly workspace: WorkspaceId;
    readonly store: MemorySlateStore;
    readonly mutations: StubMutationSeam;
    readonly invocations: StubInvocationSeam;
    readonly provider: StubProvider;
    readonly runtime: SlateRuntime;
}

function runtimeFixture(
    label: string,
    store: MemorySlateStore = new MemorySlateStore()
): RuntimeFixture {
    const mutations = new StubMutationSeam();
    const invocations = new StubInvocationSeam();
    const provider = new StubProvider();
    return {
        workspace: new WorkspaceId(`workspace-${label}`),
        store,
        mutations,
        invocations,
        provider,
        runtime: new SlateRuntime(
            store,
            provider,
            mutations,
            invocations,
            new StubPreviewValidation(),
            new MemorySlateIdSource(label)
        )
    };
}

function sessionCapability(label: string, revision: number, epoch: number) {
    return new EnvironmentSessionCapability(
        new EnvironmentId(`environment-${label}`),
        new EnvironmentSessionId(`session-${label}`),
        new Revision(revision),
        epoch
    );
}

/** A store holding one Slate whose deployment was never made active. */
type InactiveDeploymentStore = {
    readonly store: MemorySlateStore;
    readonly workspace: WorkspaceId;
    readonly slate: Slate;
    readonly deployment: SlateDeployment;
};

/** The same Slate re-homed to another Workspace, which fork revalidation must catch. */
function doctoredSlate(current: Slate): Slate {
    const init = {
        id: current.id,
        workspaceId: new WorkspaceId("workspace-fork-elsewhere"),
        source: current.source,
        revision: current.revision
    };
    return new Slate(
        current.headVersionId === undefined
            ? init
            : { ...init, headVersionId: current.headVersionId }
    );
}

function inactiveDeploymentStore(label: string): InactiveDeploymentStore {
    const store = new MemorySlateStore();
    const workspace = new WorkspaceId(`workspace-${label}`);
    const slate = Slate.initial(new SlateId(`slate-${label}`), workspace, ref(`${label}-source`));
    expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
    const version = new SlateVersion(
        new SlateVersionId(`version-${label}`),
        workspace,
        slate.id,
        slate.source
    );
    store.addVersion(version);
    const publication = new SlatePublication(
        new SlatePublicationId(`publication-${label}`),
        workspace,
        slate.id,
        version.id,
        ref(`${label}-publication`)
    );
    store.addPublication(publication);
    const invocationId = new InvocationId(`invocation-${label}`);
    const deployment = new SlateDeployment(
        new SlateDeploymentId(`deployment-${label}`),
        workspace,
        slate.id,
        publication.id,
        "production",
        ref(`${label}-deployment`),
        invocationId,
        new ReceiptId(`receipt-${label}`)
    );
    store.reserveDeployment(
        new SlateDeploymentReservation({
            id: deployment.id,
            workspaceId: workspace,
            slateId: slate.id,
            publicationId: publication.id,
            publicationMaterialization: publication.materialization,
            target: deployment.target,
            externalKey: `external-${label}`,
            invocationId
        })
    );
    store.addDeployment(deployment);
    return { store, workspace, slate, deployment };
}

async function publishedSlate(fixture: RuntimeFixture): Promise<{
    readonly publication: Awaited<ReturnType<SlateRuntime["publish"]>>;
}> {
    const slate = await fixture.runtime.create(fixture.workspace, ref("source"));
    const version = await fixture.runtime.commit(slate.id);
    const publication = await fixture.runtime.publish(version.id, ref("publication"));
    return { publication };
}

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}
