import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../src/actors";
import {
    ContentOwnerEdge,
    type ContentCollectionCandidate,
    type ContentRetention,
    type TenantContentPolicyReader
} from "../../src/content/retention";
import type { ContentStore } from "../../src/content/store";
import type {
    TransientContentAccess,
    TransientContentBinding,
    TransientContentLease
} from "../../src/content/transient";
import { compareCanonicalText, ContentRef, Digest } from "../../src/core";
import { TenantId } from "../../src/identity";
import { expectAgentCoreError, expectAgentCoreRejection } from "../protocol/error-assertion";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const tenant = new TenantId("tenant-a");
const actor = new ActorRef("workspace", new ActorId("actor-a"));
const custodyNamespace: readonly string[] = ["record:"];

export interface TestContentOwner {
    readonly tenant: TenantId;
    readonly actor: ActorRef;
}

interface CollectionResult {
    readonly refs: readonly ContentRef[];
    readonly candidates: readonly ContentCollectionCandidate[];
}

export interface ContentRetentionHarness<TTransaction> {
    readonly store: ContentStore;
    readonly retention: ContentRetention<TTransaction>;
    readonly transient: TransientContentAccess;
    setNow(now: Date): void;
    transaction<Result>(
        operation: (transaction: TTransaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    acquireInTransaction(
        transaction: TTransaction,
        binding: TransientContentBinding,
        operationAt: Date,
        bytes?: Uint8Array
    ): TransientContentLease | undefined;
    reopen(): ContentRetentionHarness<TTransaction>;
}

export function contentRetentionContract<TTransaction>(
    name: string,
    create: () => ContentRetentionHarness<TTransaction>
): void {
    describe(`${name} content-retention contract`, () => {
        test(
            "retains idempotently and starts the tombstone on final release",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("retained"));
                const edge = new ContentOwnerEdge(tenant, actor, "record:result", stored.ref);
                const retainedAt = at(10);
                const releasedAt = at(20);

                harness.transaction((transaction) => {
                    harness.retention.retain(transaction, edge, retainedAt);
                    harness.retention.retain(transaction, edge, at(11));
                });
                expect(collect(harness, at(19), true).refs).toEqual([]);
                harness.transaction((transaction) => {
                    harness.retention.release(transaction, edge, releasedAt);
                    harness.retention.release(transaction, edge, at(21));
                });
                const collected = collect(harness, at(22), true);
                expect(collected.refs).toEqual([stored.ref]);
                expect(collected.candidates[0]?.unownedSince).toEqual(releasedAt);
                expect(collected.candidates[0]?.observedAt).toEqual(at(22));
            }
        );

        test(
            "rejects missing content and immutable owner-key collisions",
            { tags: "p0" },
            async () => {
                const harness = create();
                const first = await harness.store.put(encode("first"));
                const second = await harness.store.put(encode("second"));
                const firstEdge = new ContentOwnerEdge(tenant, actor, "record:slot", first.ref);
                const secondEdge = new ContentOwnerEdge(tenant, actor, "record:slot", second.ref);
                const missingDigest = Digest.sha256(encode("missing"));
                const missing = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:missing",
                    ContentRef.fromDigest(missingDigest)
                );

                harness.transaction((transaction) =>
                    harness.retention.retain(transaction, firstEdge, at(10))
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.retention.retain(transaction, secondEdge, at(11));
                        }),
                    "protocol.invalid-state"
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.retention.release(transaction, secondEdge, at(12));
                        }),
                    "protocol.invalid-state"
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.retention.retain(transaction, missing, at(13));
                        }),
                    "content.not-found"
                );
                await expect(harness.store.get(first.ref)).resolves.toEqual(encode("first"));
                await expect(harness.store.get(second.ref)).resolves.toEqual(encode("second"));
            }
        );

        test("rejects foreign Actor and Tenant edges before mutation", { tags: "p0" }, async () => {
            const harness = create();
            const stored = await harness.store.put(encode("local"));
            const foreign: readonly ContentOwnerEdge[] = [
                new ContentOwnerEdge(new TenantId("tenant-b"), actor, "tenant", stored.ref),
                new ContentOwnerEdge(
                    tenant,
                    new ActorRef("workspace", new ActorId("actor-b")),
                    "actor",
                    stored.ref
                )
            ];
            for (const edge of foreign) {
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.retention.retain(transaction, edge, at(10));
                        }),
                    "protocol.invalid-state"
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.retention.release(transaction, edge, at(11));
                        }),
                    "protocol.invalid-state"
                );
            }
            expect(collect(harness, at(20), true)).toEqual({ candidates: [], refs: [] });
        });

        test(
            "deduplicates content until every owner releases in either order",
            { tags: "p0" },
            async () => {
                for (const reverse of [false, true]) {
                    const harness = create();
                    const first = await harness.store.put(encode("shared"));
                    const duplicate = await harness.store.put(encode("shared"));
                    const left = new ContentOwnerEdge(tenant, actor, "left", first.ref);
                    const right = new ContentOwnerEdge(tenant, actor, "right", duplicate.ref);
                    harness.transaction((transaction) => {
                        harness.retention.retain(transaction, left, at(10));
                        harness.retention.retain(transaction, right, at(11));
                        harness.retention.release(transaction, reverse ? right : left, at(20));
                    });
                    expect(collect(harness, at(21), true).refs).toEqual([]);
                    harness.transaction((transaction) =>
                        harness.retention.release(transaction, reverse ? left : right, at(30))
                    );
                    const collected = collect(harness, at(31), true);
                    expect(collected.refs).toEqual([first.ref]);
                    expect(collected.candidates[0]?.unownedSince).toEqual(at(30));
                }
            }
        );

        test(
            "never collects a direct put without an authenticated Tenant relation",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("orphan"));
                expect(collect(harness, at(100), true)).toEqual({ candidates: [], refs: [] });
                await expect(harness.store.get(stored.ref)).resolves.toEqual(encode("orphan"));
            }
        );

        test(
            "fails closed for absent, denied, and faulting policy decisions",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("policy"));
                const edge = new ContentOwnerEdge(tenant, actor, "policy", stored.ref);
                harness.transaction((transaction) => {
                    harness.retention.retain(transaction, edge, at(10));
                    harness.retention.release(transaction, edge, at(20));
                });
                expect(collect(harness, at(21), undefined).refs).toEqual([]);
                expect(collect(harness, at(22), false).refs).toEqual([]);
                expect(() =>
                    harness.transaction((transaction) =>
                        harness.retention.collect(
                            transaction,
                            {
                                allowsCollection: () => {
                                    throw new TypeError("policy unavailable");
                                }
                            },
                            at(23)
                        )
                    )
                ).toThrow("policy unavailable");
                await expect(harness.store.get(stored.ref)).resolves.toEqual(encode("policy"));
                expect(collect(harness, at(24), true).refs).toEqual([stored.ref]);
            }
        );

        test(
            "blocks GC through active lease and opens at close or exact expiry",
            { tags: "p0" },
            async () => {
                for (const closeEarly of [true, false]) {
                    const harness = create();
                    harness.setNow(at(10));
                    const binding = bindingFor("leased", `lease-${closeEarly}`, at(30));
                    const lease = await harness.transient.acquire(binding, encode("leased"));
                    expect(lease).toBeDefined();
                    expect(lease!.read()).toEqual(encode("leased"));
                    expect(lease!.matches(binding, at(29))).toBe(true);
                    expect(collect(harness, at(29), true).refs).toEqual([]);

                    const inactiveAt = closeEarly ? at(20) : at(30);
                    if (closeEarly) {
                        harness.setNow(inactiveAt);
                        await lease!.close();
                        expect(lease!.matches(binding, at(20))).toBe(false);
                    } else {
                        expect(lease!.matches(binding, at(30))).toBe(false);
                    }
                    const collected = collect(harness, inactiveAt, true);
                    expect(collected.refs).toEqual([binding.ref]);
                    expect(collected.candidates[0]?.unownedSince).toEqual(inactiveAt);
                }
            }
        );

        test(
            "lease-only failure is not eligible before close and reacquisition advances safely",
            { tags: "p0" },
            async () => {
                const harness = create();
                harness.setNow(at(10));
                const firstBinding = bindingFor("failed", "first", at(50));
                const first = await harness.transient.acquire(firstBinding, encode("failed"));
                expect(collect(harness, at(20), true).refs).toEqual([]);
                harness.setNow(at(25));
                await first!.close();

                harness.setNow(at(30));
                const secondBinding = bindingFor("failed", "second", at(60));
                const second = await harness.transient.acquire(secondBinding);
                expect(second).toBeDefined();
                expect(collect(harness, at(40), true).refs).toEqual([]);
                harness.setNow(at(45));
                await second!.close();
                const collected = collect(harness, at(45), true);
                expect(collected.refs).toEqual([secondBinding.ref]);
                expect(collected.candidates[0]?.unownedSince).toEqual(at(45));
            }
        );

        test(
            "replaces closed or expired same-envelope leases but rejects active conflicts",
            { tags: "p1" },
            async () => {
                for (const closeFirst of [true, false]) {
                    const harness = create();
                    harness.setNow(at(10));
                    const initial = bindingFor("same envelope", `same-${closeFirst}`, at(30));
                    const oldLease = await harness.transient.acquire(
                        initial,
                        encode("same envelope")
                    );
                    const conflictingDigest = Digest.sha256(encode("conflicting"));
                    await expectAgentCoreRejection(
                        harness.transient.acquire(
                            {
                                ...initial,
                                ref: ContentRef.fromDigest(conflictingDigest),
                                digest: conflictingDigest,
                                expiresAt: at(40)
                            },
                            encode("conflicting")
                        ),
                        "protocol.invalid-state"
                    );

                    if (closeFirst) {
                        harness.setNow(at(20));
                        await oldLease!.close();
                        harness.setNow(at(21));
                    } else {
                        harness.setNow(at(30));
                    }
                    const replacementBinding = { ...initial, expiresAt: at(60) };
                    const replacement = await harness.transient.acquire(replacementBinding);
                    expect(replacement?.matches(replacementBinding, at(59))).toBe(true);
                    expectAgentCoreError(() => oldLease!.read(), "protocol.invalid-state");
                    harness.setNow(at(40));
                    await replacement!.close();
                    expect(collect(harness, at(40), true).refs).toEqual([initial.ref]);
                }
            }
        );

        test(
            "rejects foreign or mismatched lease acquisition without partial insertion",
            { tags: "p0" },
            async () => {
                const harness = create();
                harness.setNow(at(10));
                const binding = bindingFor("bound lease", "bound", at(30));
                await expectAgentCoreRejection(
                    harness.transient.acquire(
                        { ...binding, tenant: new TenantId("tenant-b") },
                        encode("bound lease")
                    ),
                    "protocol.invalid-state"
                );
                await expectAgentCoreRejection(
                    harness.transient.acquire(
                        {
                            ...binding,
                            actor: new ActorRef("workspace", new ActorId("actor-b"))
                        },
                        encode("bound lease")
                    ),
                    "protocol.invalid-state"
                );
                await expectAgentCoreRejection(
                    harness.transient.acquire(binding, encode("wrong")),
                    "codec.invalid"
                );
                await expect(harness.store.stat(binding.ref)).resolves.toBeUndefined();
                expect(collect(harness, at(40), true)).toEqual({ candidates: [], refs: [] });
            }
        );

        test(
            "owner and lease ordering always waits for both protections",
            { tags: "p0" },
            async () => {
                for (const closeFirst of [true, false]) {
                    const harness = create();
                    const stored = await harness.store.put(encode("ordered"));
                    const edge = new ContentOwnerEdge(tenant, actor, "ordered", stored.ref);
                    harness.transaction((transaction) =>
                        harness.retention.retain(transaction, edge, at(5))
                    );
                    harness.setNow(at(10));
                    const binding = bindingFor("ordered", `ordered-${closeFirst}`, at(40));
                    const lease = await harness.transient.acquire(binding);
                    if (closeFirst) {
                        harness.setNow(at(20));
                        await lease!.close();
                        harness.transaction((transaction) =>
                            harness.retention.release(transaction, edge, at(30))
                        );
                    } else {
                        harness.transaction((transaction) =>
                            harness.retention.release(transaction, edge, at(20))
                        );
                        harness.setNow(at(30));
                        await lease!.close();
                    }
                    const collected = collect(harness, at(31), true);
                    expect(collected.refs).toEqual([stored.ref]);
                    expect(collected.candidates[0]?.unownedSince).toEqual(at(30));
                }
            }
        );

        test(
            "rechecks owners and leases added during policy evaluation",
            { tags: "p0" },
            async () => {
                const ownerHarness = create();
                const ownerStored = await ownerHarness.store.put(encode("policy owner race"));
                const ownerEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "policy-race",
                    ownerStored.ref
                );
                ownerHarness.transaction((transaction) => {
                    ownerHarness.retention.retain(transaction, ownerEdge, at(10));
                    ownerHarness.retention.release(transaction, ownerEdge, at(20));
                });
                const ownerResult = ownerHarness.transaction((transaction) =>
                    ownerHarness.retention.collect(
                        transaction,
                        {
                            allowsCollection(): boolean {
                                ownerHarness.retention.retain(transaction, ownerEdge, at(25));
                                return true;
                            }
                        },
                        at(25)
                    )
                );
                expect(ownerResult).toEqual([]);
                await expect(ownerHarness.store.get(ownerStored.ref)).resolves.toEqual(
                    encode("policy owner race")
                );

                const leaseHarness = create();
                const leaseStored = await leaseHarness.store.put(encode("policy lease race"));
                const leaseEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "policy-lease",
                    leaseStored.ref
                );
                leaseHarness.transaction((transaction) => {
                    leaseHarness.retention.retain(transaction, leaseEdge, at(10));
                    leaseHarness.retention.release(transaction, leaseEdge, at(20));
                });
                const leaseBinding = bindingFor("policy lease race", "policy-lease-race", at(50));
                const leaseResult = leaseHarness.transaction((transaction) =>
                    leaseHarness.retention.collect(
                        transaction,
                        {
                            allowsCollection(): boolean {
                                leaseHarness.acquireInTransaction(
                                    transaction,
                                    leaseBinding,
                                    at(25)
                                );
                                return true;
                            }
                        },
                        at(25)
                    )
                );
                expect(leaseResult).toEqual([]);
                await expect(leaseHarness.store.get(leaseStored.ref)).resolves.toEqual(
                    encode("policy lease race")
                );
            }
        );

        test(
            "normalizes inactive leases without weakening unrelated owners",
            { tags: "p0" },
            async () => {
                const harness = create();
                const owned = await harness.store.put(encode("owned inactive lease"));
                const edge = new ContentOwnerEdge(tenant, actor, "inactive-owner", owned.ref);
                harness.transaction((transaction) =>
                    harness.retention.retain(transaction, edge, at(5))
                );
                harness.setNow(at(10));
                const ownedBinding = {
                    ...bindingFor("owned inactive lease", "owned-inactive", at(30)),
                    ref: owned.ref,
                    digest: owned.digest
                };
                await harness.transient.acquire(ownedBinding);
                const unownedBinding = bindingFor("unowned sibling", "unowned-sibling", at(40));
                const unownedLease = await harness.transient.acquire(
                    unownedBinding,
                    encode("unowned sibling")
                );

                expect(collect(harness, at(30), true).refs).toEqual([]);
                harness.setNow(at(35));
                await unownedLease!.close();
                expect(collect(harness, at(35), true).refs).toEqual([unownedBinding.ref]);
                await expect(harness.store.get(owned.ref)).resolves.toEqual(
                    encode("owned inactive lease")
                );
            }
        );

        test(
            "rolls back owner mutations when the host transaction faults",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("rollback"));
                const edge = new ContentOwnerEdge(tenant, actor, "fault", stored.ref);
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.retention.retain(transaction, edge, at(10));
                        throw new TypeError("fault");
                    })
                ).toThrow("fault");
                const replacement = await harness.store.put(encode("rollback replacement"));
                const replacementEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    edge.ownerKey,
                    replacement.ref
                );
                harness.transaction((transaction) => {
                    harness.retention.retain(transaction, replacementEdge, at(20));
                    harness.retention.release(transaction, replacementEdge, at(30));
                });
                expect(collect(harness, at(30), true).refs).toEqual([replacement.ref]);
                await expect(harness.store.get(stored.ref)).resolves.toEqual(encode("rollback"));
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] registers an owner edge for named content inside the owning transaction",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("named"));
                const edge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:turn.record:1:t:input",
                    stored.ref
                );

                harness.transaction((transaction) => {
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, []);
                    harness.retention.retain(transaction, edge, at(10));
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [edge]);
                });
                harness.transaction((transaction) =>
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [edge])
                );
                expect(collect(harness, at(20), true)).toEqual({ candidates: [], refs: [] });
                await expect(harness.store.get(stored.ref)).resolves.toEqual(encode("named"));
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] swaps an owner key onto new content atomically and refuses a bare re-registration",
            { tags: "p0" },
            async () => {
                const harness = create();
                const original = await harness.store.put(encode("original"));
                const replacement = await harness.store.put(encode("replacement"));
                const ownerKey = "record:workspace.view:1:v:content";
                const before = new ContentOwnerEdge(tenant, actor, ownerKey, original.ref);
                const after = new ContentOwnerEdge(tenant, actor, ownerKey, replacement.ref);

                harness.transaction((transaction) =>
                    harness.retention.retain(transaction, before, at(10))
                );
                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.retention.retain(transaction, after, at(11));
                        }),
                    "protocol.invalid-state"
                );
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.retention.release(transaction, before, at(12));
                        harness.retention.retain(transaction, after, at(12));
                        throw new TypeError("swap fault");
                    })
                ).toThrow("swap fault");
                harness.transaction((transaction) =>
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [before])
                );

                harness.transaction((transaction) => {
                    harness.retention.release(transaction, before, at(20));
                    harness.retention.retain(transaction, after, at(20));
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [after]);
                });
                const collected = collect(harness, at(21), true);
                expect(refValues(collected.refs)).toEqual([original.ref.value]);
                expect(collected.candidates[0]?.unownedSince).toEqual(at(20));
                await expect(harness.store.get(replacement.ref)).resolves.toEqual(
                    encode("replacement")
                );
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] a faulted transaction leaves no owner edge and no retained content",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("rolled back"));
                const edge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:run.commit:1:c:content",
                    stored.ref
                );
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.retention.retain(transaction, edge, at(10));
                        harness.retention.verifyExactNamespace(transaction, custodyNamespace, [
                            edge
                        ]);
                        throw new TypeError("commit fault");
                    })
                ).toThrow("commit fault");
                harness.transaction((transaction) =>
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [])
                );
                expect(collect(harness, at(11), true)).toEqual({ candidates: [], refs: [] });
                harness.transaction((transaction) =>
                    harness.retention.retain(transaction, edge, at(12))
                );
                harness.transaction((transaction) =>
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [edge])
                );
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] refuses a custody verification whose namespace or expectation is not exact",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("verified"));
                const edge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:workspace.view:1:verify:content",
                    stored.ref
                );
                harness.transaction((transaction) =>
                    harness.retention.retain(transaction, edge, at(10))
                );
                const verify = (
                    prefixes: readonly string[],
                    expected: readonly ContentOwnerEdge[]
                ): void => {
                    harness.transaction((transaction) =>
                        harness.retention.verifyExactNamespace(transaction, prefixes, expected)
                    );
                };

                // The prefixes decide which stored edges the verification is answerable for.
                // No prefix reaches nothing and an empty prefix reaches everything, so a store
                // asked either way would report a verified namespace it never compared.
                expectAgentCoreError(() => verify([], [edge]), "protocol.invalid-state");
                expectAgentCoreError(() => verify([""], [edge]), "protocol.invalid-state");
                expectAgentCoreError(
                    () => verify(["record:workspace.other:"], [edge]),
                    "protocol.invalid-state"
                );

                // One owner key holds one ContentRef. An expectation that names a key twice
                // could otherwise match a store holding either of them.
                expectAgentCoreError(() => verify(custodyNamespace, [edge, edge]), "codec.invalid");
                expectAgentCoreError(
                    () =>
                        verify(custodyNamespace, [
                            edge,
                            new ContentOwnerEdge(
                                tenant,
                                actor,
                                edge.ownerKey,
                                ContentRef.fromDigest(Digest.sha256(encode("other")))
                            )
                        ]),
                    "codec.invalid"
                );

                // The exact expectation still verifies, so the refusals above are about the
                // namespace and the expectation rather than the stored custody.
                verify(custodyNamespace, [edge]);
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] a fresh store over the same durable state holds exactly what committed",
            { tags: "p0" },
            async () => {
                const harness = create();
                const kept = await harness.store.put(encode("kept"));
                const dropped = await harness.store.put(encode("dropped"));
                const uncommitted = await harness.store.put(encode("uncommitted"));
                const keptEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:run.commit:1:c:content",
                    kept.ref
                );
                const droppedEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:workspace.view:1:v:content",
                    dropped.ref
                );
                const uncommittedEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:turn.record:1:t:input",
                    uncommitted.ref
                );
                harness.transaction((transaction) => {
                    harness.retention.retain(transaction, keptEdge, at(10));
                    harness.retention.retain(transaction, droppedEdge, at(10));
                });
                harness.transaction((transaction) =>
                    harness.retention.release(transaction, droppedEdge, at(20))
                );
                expect(() =>
                    harness.transaction((transaction) => {
                        harness.retention.retain(transaction, uncommittedEdge, at(21));
                        throw new TypeError("restart fault");
                    })
                ).toThrow("restart fault");

                const restarted = harness.reopen();
                restarted.transaction((transaction) =>
                    restarted.retention.verifyExactNamespace(transaction, custodyNamespace, [
                        keptEdge
                    ])
                );
                const collected = collect(restarted, at(30), true);
                expect(refValues(collected.refs)).toEqual([dropped.ref.value]);
                await expect(restarted.store.get(kept.ref)).resolves.toEqual(encode("kept"));
                await expect(restarted.store.get(uncommitted.ref)).resolves.toEqual(
                    encode("uncommitted")
                );
                restarted.transaction((transaction) =>
                    restarted.retention.verifyExactNamespace(transaction, custodyNamespace, [
                        keptEdge
                    ])
                );
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] a defined removal path releases the edge in the same transaction",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stored = await harness.store.put(encode("removed"));
                const edge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:workspace.view:1:v:content",
                    stored.ref
                );
                harness.transaction((transaction) =>
                    harness.retention.retain(transaction, edge, at(10))
                );
                const collected = harness.transaction((transaction) => {
                    harness.retention.release(transaction, edge, at(20));
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, []);
                    return harness.retention.collect(
                        transaction,
                        { allowsCollection: () => true },
                        at(20)
                    );
                });
                expect(refValues(collected)).toEqual([stored.ref.value]);
                await expectAgentCoreRejection(harness.store.get(stored.ref), "content.not-found");
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] an append-only kind never releases, so every collection pass leaves its content",
            { tags: "p0" },
            async () => {
                const harness = create();
                const appended = await harness.store.put(encode("append-only result"));
                const removable = await harness.store.put(encode("removable revision"));
                const receipt = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:invocation.receipt:1:r:result",
                    appended.ref
                );
                const view = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:workspace.view:1:v:content",
                    removable.ref
                );
                harness.transaction((transaction) => {
                    harness.retention.retain(transaction, receipt, at(10));
                    harness.retention.retain(transaction, view, at(10));
                    harness.retention.release(transaction, view, at(20));
                });
                for (const observedAt of [at(21), at(1_000), at(1_000_000)]) {
                    const collected = collect(harness, observedAt, true);
                    expect(
                        refValues(collected.candidates.map((candidate) => candidate.stat.ref))
                    ).not.toContain(appended.ref.value);
                    expect(refValues(collected.refs)).not.toContain(appended.ref.value);
                    await expect(harness.store.get(appended.ref)).resolves.toEqual(
                        encode("append-only result")
                    );
                }
                harness.transaction((transaction) =>
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [receipt])
                );
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] collection offers only content no declared owner holds",
            { tags: "p0" },
            async () => {
                const harness = create();
                const held = await harness.store.put(encode("held"));
                const shared = await harness.store.put(encode("shared by two owners"));
                const freed = await harness.store.put(encode("freed"));
                const holder = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:run.commit:1:c:content",
                    held.ref
                );
                const firstShare = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:turn.record:1:t:input",
                    shared.ref
                );
                const secondShare = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:turn.record:1:t:result",
                    shared.ref
                );
                const released = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:workspace.view:1:v:content",
                    freed.ref
                );
                harness.transaction((transaction) => {
                    for (const edge of [holder, firstShare, secondShare, released]) {
                        harness.retention.retain(transaction, edge, at(10));
                    }
                    harness.retention.release(transaction, released, at(20));
                });

                const first = collect(harness, at(21), true);
                expect(refValues(first.candidates.map((candidate) => candidate.stat.ref))).toEqual([
                    freed.ref.value
                ]);
                expect(refValues(first.refs)).toEqual([freed.ref.value]);

                harness.transaction((transaction) =>
                    harness.retention.release(transaction, firstShare, at(30))
                );
                expect(collect(harness, at(31), true)).toEqual({ candidates: [], refs: [] });
                await expect(harness.store.get(shared.ref)).resolves.toEqual(
                    encode("shared by two owners")
                );

                harness.transaction((transaction) =>
                    harness.retention.release(transaction, secondShare, at(40))
                );
                const third = collect(harness, at(41), true);
                expect(refValues(third.refs)).toEqual([shared.ref.value]);
                await expect(harness.store.get(held.ref)).resolves.toEqual(encode("held"));
                harness.transaction((transaction) =>
                    harness.retention.verifyExactNamespace(transaction, custodyNamespace, [holder])
                );
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] repeated collection passes never double-collect and never take content a concurrent retain saved",
            { tags: "p0" },
            async () => {
                const harness = create();
                const rescued = await harness.store.put(encode("rescued candidate"));
                const doomed = await harness.store.put(encode("doomed candidate"));
                const rescuedEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:workspace.view:1:rescued:content",
                    rescued.ref
                );
                const doomedEdge = new ContentOwnerEdge(
                    tenant,
                    actor,
                    "record:workspace.view:1:doomed:content",
                    doomed.ref
                );
                harness.transaction((transaction) => {
                    harness.retention.retain(transaction, rescuedEdge, at(10));
                    harness.retention.retain(transaction, doomedEdge, at(10));
                    harness.retention.release(transaction, rescuedEdge, at(20));
                    harness.retention.release(transaction, doomedEdge, at(20));
                });

                const offered: string[] = [];
                const raced = harness.transaction((transaction) =>
                    harness.retention.collect(
                        transaction,
                        {
                            allowsCollection(_transaction, candidate): boolean {
                                offered.push(candidate.stat.ref.value);
                                if (candidate.stat.ref.equals(rescued.ref)) {
                                    harness.retention.retain(transaction, rescuedEdge, at(25));
                                }
                                return true;
                            }
                        },
                        at(25)
                    )
                );
                expect([...offered].sort(compareCanonicalText)).toEqual(
                    [doomed.ref.value, rescued.ref.value].sort(compareCanonicalText)
                );
                expect(refValues(raced)).toEqual([doomed.ref.value]);
                await expect(harness.store.get(rescued.ref)).resolves.toEqual(
                    encode("rescued candidate")
                );
                expect(collect(harness, at(26), true)).toEqual({ candidates: [], refs: [] });

                harness.transaction((transaction) =>
                    harness.retention.release(transaction, rescuedEdge, at(30))
                );
                expect(refValues(collect(harness, at(31), true).refs)).toEqual([rescued.ref.value]);
                expect(collect(harness, at(32), true)).toEqual({ candidates: [], refs: [] });
            }
        );

        test(
            "[C13-CONTENT-CUSTODY] a transient lease holds its content across a restart and stops holding it when the lease ends",
            { tags: "p0" },
            async () => {
                for (const closeEarly of [true, false]) {
                    const harness = create();
                    harness.setNow(at(10));
                    const binding = bindingFor(
                        "leased across restart",
                        `restart-${closeEarly}`,
                        at(30)
                    );
                    expect(
                        await harness.transient.acquire(binding, encode("leased across restart"))
                    ).toBeDefined();

                    const restarted = harness.reopen();
                    restarted.setNow(at(20));
                    expect(collect(restarted, at(20), true)).toEqual({ candidates: [], refs: [] });
                    await expect(restarted.store.get(binding.ref)).resolves.toEqual(
                        encode("leased across restart")
                    );

                    const reacquired = await restarted.transient.acquire(binding);
                    expect(reacquired?.matches(binding, at(20))).toBe(true);
                    const endedAt = closeEarly ? at(25) : at(30);
                    if (closeEarly) {
                        restarted.setNow(endedAt);
                        await reacquired!.close();
                    }
                    const collected = collect(restarted, endedAt, true);
                    expect(refValues(collected.refs)).toEqual([binding.ref.value]);
                    expect(collected.candidates[0]?.unownedSince).toEqual(endedAt);
                }
            }
        );
    });
}

export function contentOwner(): TestContentOwner {
    return { tenant, actor };
}

export function bindingFor(
    value: string,
    envelope: string,
    expiresAt: Date
): TransientContentBinding {
    const bytes = encode(value);
    const digest = Digest.sha256(bytes);
    return {
        tenant,
        actor,
        envelopeDigest: Digest.sha256(encode(`envelope:${envelope}`)),
        ref: ContentRef.fromDigest(digest),
        digest,
        expiresAt
    };
}

export function at(milliseconds: number): Date {
    return new Date(milliseconds);
}

function collect<TTransaction>(
    harness: ContentRetentionHarness<TTransaction>,
    observedAt: Date,
    decision: boolean | undefined
): CollectionResult {
    const candidates: ContentCollectionCandidate[] = [];
    const policy: TenantContentPolicyReader<TTransaction> = {
        allowsCollection(_transaction, candidate): boolean | undefined {
            expect(candidate.tenant.equals(tenant)).toBe(true);
            expect(candidate.actor.equals(actor)).toBe(true);
            candidates.push(candidate);
            return decision;
        }
    };
    const refs = harness.transaction((transaction) =>
        harness.retention.collect(transaction, policy, observedAt)
    );
    return { refs, candidates };
}

function refValues(refs: readonly ContentRef[]): readonly string[] {
    return refs.map((ref) => ref.value);
}
