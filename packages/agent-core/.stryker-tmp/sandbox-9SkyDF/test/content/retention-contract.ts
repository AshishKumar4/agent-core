// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    ContentOwnerEdge,
    type ContentCollectionCandidate,
    type ContentRetention,
    type TenantContentPolicyReader
} from "../../src/content/retention";
import type { ContentStore } from "../../src/content/store";
import type { TransientContentAccess, TransientContentBinding } from "../../src/content/transient";
import { ContentRef, Digest } from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { TenantId } from "../../src/identity";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const tenant = new TenantId("tenant-a");
const actor = new ActorRef("workspace", new ActorId("actor-a"));

export interface ContentRetentionHarness<TTransaction> {
    readonly store: ContentStore;
    readonly retention: ContentRetention<TTransaction>;
    readonly transient: TransientContentAccess;
    setNow(now: Date): void;
    transaction<Result>(operation: (transaction: TTransaction) => Result): Result;
    acquireInTransaction(
        transaction: TTransaction,
        binding: TransientContentBinding,
        operationAt: Date,
        bytes?: Uint8Array
    ): unknown;
}

export function contentRetentionContract<TTransaction>(
    name: string,
    create: () => ContentRetentionHarness<TTransaction>
): void {
    describe(`${name} content-retention contract`, () => {
        test("retains idempotently and starts the tombstone on final release", async () => {
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
        });

        test("rejects missing content and immutable owner-key collisions", async () => {
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
        });

        test("rejects foreign Actor and Tenant edges before mutation", async () => {
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

        test("deduplicates content until every owner releases in either order", async () => {
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
        });

        test("never collects a direct put without an authenticated Tenant relation", async () => {
            const harness = create();
            const stored = await harness.store.put(encode("orphan"));
            expect(collect(harness, at(100), true)).toEqual({ candidates: [], refs: [] });
            await expect(harness.store.get(stored.ref)).resolves.toEqual(encode("orphan"));
        });

        test("fails closed for absent, denied, and faulting policy decisions", async () => {
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
        });

        test("blocks GC through active lease and opens at close or exact expiry", async () => {
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
        });

        test("lease-only failure is not eligible before close and reacquisition advances safely", async () => {
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
        });

        test("replaces closed or expired same-envelope leases but rejects active conflicts", async () => {
            for (const closeFirst of [true, false]) {
                const harness = create();
                harness.setNow(at(10));
                const initial = bindingFor("same envelope", `same-${closeFirst}`, at(30));
                const oldLease = await harness.transient.acquire(initial, encode("same envelope"));
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
        });

        test("rejects foreign or mismatched lease acquisition without partial insertion", async () => {
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
        });

        test("owner and lease ordering always waits for both protections", async () => {
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
        });

        test("rechecks owners and leases added during policy evaluation", async () => {
            const ownerHarness = create();
            const ownerStored = await ownerHarness.store.put(encode("policy owner race"));
            const ownerEdge = new ContentOwnerEdge(tenant, actor, "policy-race", ownerStored.ref);
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
            const leaseEdge = new ContentOwnerEdge(tenant, actor, "policy-lease", leaseStored.ref);
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
                            leaseHarness.acquireInTransaction(transaction, leaseBinding, at(25));
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
        });

        test("normalizes inactive leases without weakening unrelated owners", async () => {
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
        });

        test("rolls back owner mutations when the host transaction faults", async () => {
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
        });
    });
}

export function contentOwner(): { readonly tenant: TenantId; readonly actor: ActorRef } {
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

export function expectAgentCoreError(operation: () => unknown, code: AgentCoreErrorCode): void {
    let failure: unknown;
    try {
        operation();
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ code });
}

export async function expectAgentCoreRejection(
    operation: Promise<unknown>,
    code: AgentCoreErrorCode
): Promise<void> {
    let failure: unknown;
    try {
        await operation;
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ code });
}

function collect<TTransaction>(
    harness: ContentRetentionHarness<TTransaction>,
    observedAt: Date,
    decision: boolean | undefined
): {
    readonly refs: readonly ContentRef[];
    readonly candidates: readonly ContentCollectionCandidate[];
} {
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
