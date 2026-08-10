import { describe, expect, test } from "vitest";
import { SemVer } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { ReceiptId } from "../../../src/invocations";
import {
    RunCommit,
    validateCommitWriter,
    type CommitWriter,
    type RunCommitInit
} from "../../../src/agents/runs/commit";
import { BlueprintPin, RunPins } from "../../../src/agents/runs/pins";
import { content, digest, harness, ids, pins, refs } from "./fixture";

const source = new RunCommitId("merge-source");
const stranger = new RunCommitId("outside-parent");

function expectTypeError(label: string, operation: () => unknown, message: string): void {
    let caught: unknown;
    try {
        operation();
    } catch (error) {
        caught = error;
    }
    expect(caught, label).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message, label).toBe(message);
}

function expectCode(
    label: string,
    operation: () => unknown,
    code: AgentCoreError["code"],
    message: string
): void {
    let caught: unknown;
    try {
        operation();
    } catch (error) {
        caught = error;
    }
    expect(caught, label).toBeInstanceOf(AgentCoreError);
    expect((caught as AgentCoreError).code, label).toBe(code);
    expect((caught as AgentCoreError).message, label).toBe(message);
}

function turnWriter(): CommitWriter {
    return { kind: "turn", token: { turn: ids.turn, holder: ids.holder, epoch: 1 } };
}

function receiptWriter(): CommitWriter {
    return {
        kind: "system",
        cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
    };
}

function deliveryWriter(): CommitWriter {
    return {
        kind: "system",
        cause: { kind: "delivery", audit: refs.audit, reservation: refs.route }
    };
}

function controlWriter(): CommitWriter {
    return {
        kind: "system",
        cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
    };
}

function migratedPins(): RunPins {
    const base = pins();
    return new RunPins({
        blueprint: new BlueprintPin("blueprint", new SemVer("9.9.9"), digest("9")),
        packages: base.packages,
        agent: base.agent,
        effectivePolicy: base.effectivePolicy,
        modelPolicy: base.modelPolicy,
        environment: base.environment
    });
}

type MergeOptionals = Pick<
    RunCommitInit,
    | "content"
    | "receipt"
    | "resolution"
    | "selects"
    | "subjectTurn"
    | "treeCheckpoint"
    | "treeResolution"
>;

function mergeInit(id: string, optionals: MergeOptionals): RunCommitInit {
    return {
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "merge",
        parents: [ids.root, source],
        pins: pins(),
        writer: controlWriter(),
        ...optionals
    };
}

function validMerge(id: string): RunCommitInit {
    return mergeInit(id, {
        content: content("2"),
        resolution: { kind: "concat" },
        receipt: refs.receipt
    });
}

function invocationInit(
    id: string,
    optionals: Pick<RunCommitInit, "content" | "invocation" | "receipt" | "subjectTurn">
): RunCommitInit {
    return {
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "invocation",
        parents: [ids.root],
        pins: pins(),
        writer: receiptWriter(),
        ...optionals
    };
}

function deliveryInit(
    id: string,
    optionals: Pick<RunCommitInit, "content" | "reservation">
): RunCommitInit {
    return {
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "eventDelivery",
        parents: [ids.root],
        pins: pins(),
        writer: deliveryWriter(),
        ...optionals
    };
}

function undoInit(
    id: string,
    optionals: Pick<RunCommitInit, "content" | "receipt" | "selects">
): RunCommitInit {
    return {
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "undo",
        parents: [ids.root],
        pins: pins(),
        writer: controlWriter(),
        ...optionals
    };
}

function message(id: string): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [ids.root],
        pins: pins(),
        writer: turnWriter(),
        subjectTurn: ids.turn,
        content: content("1")
    });
}

function invocation(id: string, subjectTurn?: TurnId): RunCommit {
    return new RunCommit({
        ...invocationInit(id, { invocation: refs.invocation, receipt: refs.receipt }),
        ...(subjectTurn === undefined ? {} : { subjectTurn })
    });
}

function delivery(id: string): RunCommit {
    return new RunCommit(deliveryInit(id, { reservation: refs.route }));
}

function undo(id: string): RunCommit {
    return new RunCommit(undoInit(id, { selects: ids.root, receipt: refs.receipt }));
}

function synthesize(id: string): RunCommit {
    return new RunCommit(
        mergeInit(id, {
            subjectTurn: ids.turn,
            content: content("2"),
            resolution: {
                kind: "synthesize",
                token: { turn: ids.turn, holder: ids.holder, epoch: 1 },
                receipt: new ReceiptId("synthesis-receipt")
            },
            receipt: refs.receipt
        })
    );
}

describe("closed commit shape single violations", () => {
    test("rejects root commits that carry any non-root field or writer", { tags: "p0" }, () => {
        const base: RunCommitInit = {
            id: new RunCommitId("root-case"),
            run: ids.run,
            branch: ids.branch,
            kind: "root",
            parents: [],
            pins: pins(),
            writer: { kind: "root" }
        };
        const cases: ReadonlyArray<{ readonly label: string; readonly init: RunCommitInit }> = [
            { label: "turn writer", init: { ...base, writer: turnWriter() } },
            { label: "subject turn", init: { ...base, subjectTurn: ids.turn } },
            { label: "selected commit", init: { ...base, selects: ids.root } }
        ];
        for (const { label, init } of cases) {
            expectTypeError(label, () => new RunCommit(init), "Root commit fields are invalid");
        }
    });

    test("rejects merge commits that violate exactly one merge requirement", { tags: "p0" }, () => {
        const cases: ReadonlyArray<{ readonly label: string; readonly init: RunCommitInit }> = [
            {
                label: "single parent",
                init: { ...validMerge("merge-single-parent"), parents: [ids.root] }
            },
            {
                label: "three parents",
                init: {
                    ...validMerge("merge-three-parents"),
                    parents: [ids.root, source, stranger]
                }
            },
            {
                label: "turn writer",
                init: { ...validMerge("merge-turn-writer"), writer: turnWriter() }
            },
            {
                label: "receipt cause",
                init: { ...validMerge("merge-receipt-cause"), writer: receiptWriter() }
            },
            {
                label: "missing resolution",
                init: mergeInit("merge-missing-resolution", {
                    content: content("2"),
                    receipt: refs.receipt
                })
            },
            {
                label: "missing content",
                init: mergeInit("merge-missing-content", {
                    resolution: { kind: "concat" },
                    receipt: refs.receipt
                })
            },
            {
                label: "missing receipt",
                init: mergeInit("merge-missing-receipt", {
                    content: content("2"),
                    resolution: { kind: "concat" }
                })
            },
            {
                label: "selected commit",
                init: { ...validMerge("merge-selects"), selects: ids.root }
            }
        ];
        for (const { label, init } of cases) {
            expectTypeError(label, () => new RunCommit(init), "Merge commit fields are invalid");
        }
    });

    test("requires the tree resolution and checkpoint to occur together", { tags: "p0" }, () => {
        expectTypeError(
            "resolution without checkpoint",
            () =>
                new RunCommit({
                    ...validMerge("merge-tree-no-checkpoint"),
                    treeResolution: {
                        policy: "ours",
                        side: ids.root,
                        base: content("d"),
                        environment: "environment"
                    }
                }),
            "Tree resolution and checkpoint must occur together"
        );
        expectTypeError(
            "checkpoint without resolution",
            () =>
                new RunCommit({
                    ...validMerge("merge-checkpoint-no-resolution"),
                    treeCheckpoint: content("3")
                }),
            "Tree resolution and checkpoint must occur together"
        );
    });

    test("constrains merge pick and tree sides to the ordered parents", { tags: "p0" }, () => {
        expectTypeError(
            "pick outside parents",
            () =>
                new RunCommit(
                    mergeInit("merge-pick-outside", {
                        content: content("2"),
                        resolution: { kind: "pick", parent: stranger },
                        receipt: refs.receipt
                    })
                ),
            "Merge pick must name one ordered parent"
        );
        const picked = new RunCommit(
            mergeInit("merge-pick-second", {
                content: content("2"),
                resolution: { kind: "pick", parent: source },
                receipt: refs.receipt
            })
        );
        expect(picked.resolution?.kind).toBe("pick");
        expect(
            picked.resolution?.kind === "pick" ? picked.resolution.parent.value : undefined
        ).toBe("merge-source");

        const treeCases: ReadonlyArray<{
            readonly label: string;
            readonly tree: NonNullable<RunCommitInit["treeResolution"]>;
        }> = [
            {
                label: "ours names the second parent",
                tree: {
                    policy: "ours",
                    side: source,
                    base: content("d"),
                    environment: "environment"
                }
            },
            {
                label: "theirs names the first parent",
                tree: {
                    policy: "theirs",
                    side: ids.root,
                    base: content("d"),
                    environment: "environment"
                }
            },
            {
                label: "per-path names a stranger",
                tree: {
                    policy: "perPath",
                    base: content("d"),
                    environment: "environment",
                    resolutions: [
                        { path: "/kept", side: ids.root },
                        { path: "/lost", side: stranger }
                    ]
                }
            }
        ];
        for (const { label, tree } of treeCases) {
            expectTypeError(
                label,
                () =>
                    new RunCommit({
                        ...validMerge("merge-tree-sides"),
                        treeResolution: tree,
                        treeCheckpoint: content("c")
                    }),
                "Tree resolution sides must name ordered merge parents"
            );
        }
    });

    test(
        "rejects invocation commits that violate exactly one receipt requirement",
        { tags: "p0" },
        () => {
            const complete = { invocation: refs.invocation, receipt: refs.receipt };
            const cases: ReadonlyArray<{ readonly label: string; readonly init: RunCommitInit }> = [
                {
                    label: "turn writer",
                    init: {
                        ...invocationInit("invocation-turn-writer", complete),
                        writer: turnWriter()
                    }
                },
                {
                    label: "delivery cause",
                    init: {
                        ...invocationInit("invocation-delivery-cause", complete),
                        writer: deliveryWriter()
                    }
                },
                {
                    label: "missing invocation",
                    init: invocationInit("invocation-missing-invocation", { receipt: refs.receipt })
                },
                {
                    label: "missing receipt",
                    init: invocationInit("invocation-missing-receipt", {
                        invocation: refs.invocation
                    })
                },
                {
                    label: "content present",
                    init: invocationInit("invocation-content", {
                        ...complete,
                        content: content("3")
                    })
                }
            ];
            for (const { label, init } of cases) {
                expectTypeError(
                    label,
                    () => new RunCommit(init),
                    "Invocation commit fields are invalid"
                );
            }
        }
    );

    test(
        "rejects event delivery commits that violate exactly one delivery requirement",
        { tags: "p0" },
        () => {
            const cases: ReadonlyArray<{ readonly label: string; readonly init: RunCommitInit }> = [
                {
                    label: "turn writer",
                    init: {
                        ...deliveryInit("delivery-turn-writer", { reservation: refs.route }),
                        writer: turnWriter()
                    }
                },
                {
                    label: "receipt cause",
                    init: {
                        ...deliveryInit("delivery-receipt-cause", { reservation: refs.route }),
                        writer: receiptWriter()
                    }
                },
                {
                    label: "missing reservation",
                    init: deliveryInit("delivery-missing-reservation", {})
                },
                {
                    label: "content present",
                    init: deliveryInit("delivery-content", {
                        reservation: refs.route,
                        content: content("3")
                    })
                }
            ];
            for (const { label, init } of cases) {
                expectTypeError(
                    label,
                    () => new RunCommit(init),
                    "Event delivery commit fields are invalid"
                );
            }
        }
    );

    test(
        "rejects undo commits that violate exactly one control requirement",
        { tags: "p0" },
        () => {
            const complete = { selects: ids.root, receipt: refs.receipt };
            const cases: ReadonlyArray<{
                readonly label: string;
                readonly init: RunCommitInit;
                readonly message: string;
            }> = [
                {
                    label: "turn writer",
                    init: { ...undoInit("undo-turn-writer", complete), writer: turnWriter() },
                    message: "Control commit requires exact control evidence"
                },
                {
                    label: "receipt cause",
                    init: { ...undoInit("undo-receipt-cause", complete), writer: receiptWriter() },
                    message: "Control commit requires exact control evidence"
                },
                {
                    label: "missing receipt",
                    init: undoInit("undo-missing-receipt", { selects: ids.root }),
                    message: "Control commit requires exact control evidence"
                },
                {
                    label: "missing selection",
                    init: undoInit("undo-missing-selects", { receipt: refs.receipt }),
                    message: "Undo commit fields are invalid"
                },
                {
                    label: "content present",
                    init: undoInit("undo-content", { ...complete, content: content("3") }),
                    message: "Undo commit fields are invalid"
                }
            ];
            for (const { label, init, message: expected } of cases) {
                expectTypeError(label, () => new RunCommit(init), expected);
            }
        }
    );

    test(
        "rejects migration commits that break the pin bind and accepts the exact migration",
        { tags: "p0" },
        () => {
            const migrated = migratedPins();
            const base = (id: string): Omit<RunCommitInit, "migration" | "pins"> => ({
                id: new RunCommitId(id),
                run: ids.run,
                branch: ids.branch,
                kind: "migration",
                parents: [ids.root],
                writer: controlWriter(),
                receipt: refs.receipt
            });
            expectTypeError(
                "missing migration",
                () => new RunCommit({ ...base("migration-missing"), pins: pins() }),
                "Migration commit fields are invalid"
            );
            expectTypeError(
                "pins differ from the migration target",
                () =>
                    new RunCommit({
                        ...base("migration-mismatched-pins"),
                        pins: pins(),
                        migration: { from: pins(), to: migrated }
                    }),
                "Migration commit fields are invalid"
            );
            expectTypeError(
                "content present",
                () =>
                    new RunCommit({
                        ...base("migration-content"),
                        pins: migrated,
                        migration: { from: pins(), to: migrated },
                        content: content("3")
                    }),
                "Migration commit fields are invalid"
            );
            const exact = new RunCommit({
                ...base("migration-exact"),
                pins: migrated,
                migration: { from: pins(), to: migrated }
            });
            expect(exact.migration).toBeDefined();
            expect(
                exact.migration === undefined ? false : exact.pins.equals(exact.migration.to)
            ).toBe(true);
            expect(
                exact.migration === undefined ? false : exact.migration.from.equals(pins())
            ).toBe(true);
        }
    );

    test(
        "rejects turn-authored commits that violate exactly one turn requirement",
        { tags: "p0" },
        () => {
            expectTypeError(
                "system writer",
                () =>
                    new RunCommit({
                        id: new RunCommitId("turn-system-writer"),
                        run: ids.run,
                        branch: ids.branch,
                        kind: "message",
                        parents: [ids.root],
                        pins: pins(),
                        writer: receiptWriter(),
                        subjectTurn: ids.turn,
                        content: content("1")
                    }),
                "Turn-authored commit fields are invalid"
            );
            expectTypeError(
                "missing content",
                () =>
                    new RunCommit({
                        id: new RunCommitId("turn-missing-content"),
                        run: ids.run,
                        branch: ids.branch,
                        kind: "message",
                        parents: [ids.root],
                        pins: pins(),
                        writer: turnWriter(),
                        subjectTurn: ids.turn
                    }),
                "Turn-authored commit fields are invalid"
            );
        }
    );

    test("rejects lease tokens whose members are not canonical references", { tags: "p0" }, () => {
        const init = (writer: CommitWriter): RunCommitInit => ({
            id: new RunCommitId("token-members"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [ids.root],
            pins: pins(),
            writer,
            subjectTurn: ids.turn,
            content: content("1")
        });
        expectTypeError(
            "turn member",
            () =>
                new RunCommit(
                    init({
                        kind: "turn",
                        token: { turn: "turn-1" as never, holder: ids.holder, epoch: 1 }
                    })
                ),
            "Lease token turn must be a TurnId"
        );
        expectTypeError(
            "holder member",
            () =>
                new RunCommit(
                    init({
                        kind: "turn",
                        token: { turn: ids.turn, holder: "holder-1" as never, epoch: 1 }
                    })
                ),
            "Lease token holder must be a PrincipalRef"
        );
    });
});

describe("writer authority single mismatches", () => {
    test(
        "states the exact refusal for a root writer beyond the root commit",
        { tags: "p2" },
        () => {
            const value = harness();
            expectCode(
                "root writer on a message commit",
                () =>
                    value.repository.transaction((tx) =>
                        validateCommitWriter(
                            tx,
                            {
                                ...message("forged-root-writer"),
                                writer: { kind: "root" }
                            } as RunCommit,
                            value.evidence
                        )
                    ),
                "run.invalid-state",
                "Root writer may append only the root commit"
            );
        }
    );

    test("denies a turn writer when the commit carries no subject Turn", { tags: "p0" }, () => {
        const value = harness();
        expectCode(
            "missing subject turn",
            () =>
                value.repository.transaction((tx) =>
                    validateCommitWriter(
                        tx,
                        { ...message("turn-no-subject"), subjectTurn: undefined } as RunCommit,
                        value.evidence
                    )
                ),
            "run.invalid-state",
            "Turn writer is incompatible with the Run commit"
        );
    });

    test(
        "denies system writers whose commit kind does not match the cause evidence",
        { tags: "p0" },
        () => {
            const receiptCase = harness();
            receiptCase.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "receipt",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                invocation: refs.invocation
            });
            expectCode(
                "receipt cause on a message kind",
                () =>
                    receiptCase.repository.transaction((tx) =>
                        validateCommitWriter(
                            tx,
                            { ...invocation("receipt-kind-forged"), kind: "message" } as RunCommit,
                            receiptCase.evidence
                        )
                    ),
                "authority.denied",
                "Receipt writer evidence does not match the Run commit"
            );

            const deliveryCase = harness();
            deliveryCase.evidence.deliveries.set(`${refs.route.value}:${refs.audit.value}`, {
                kind: "delivery",
                run: ids.run,
                reservation: refs.route,
                audit: refs.audit
            });
            expectCode(
                "delivery cause on a message kind",
                () =>
                    deliveryCase.repository.transaction((tx) =>
                        validateCommitWriter(
                            tx,
                            { ...delivery("delivery-kind-forged"), kind: "message" } as RunCommit,
                            deliveryCase.evidence
                        )
                    ),
                "authority.denied",
                "Delivery writer evidence does not match the Run commit"
            );

            const controlCase = harness();
            const forgedControl = { ...undo("control-kind-forged"), kind: "message" } as RunCommit;
            controlCase.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "control",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                proposalDigest: forgedControl.proposalDigest.value
            });
            expectCode(
                "control cause on a message kind",
                () =>
                    controlCase.repository.transaction((tx) =>
                        validateCommitWriter(tx, forgedControl, controlCase.evidence)
                    ),
                "authority.denied",
                "Control writer evidence does not bind the complete Run commit proposal"
            );
        }
    );

    test("denies commits that omit their own evidence reference fields", { tags: "p0" }, () => {
        const receiptCase = harness();
        receiptCase.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "receipt",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            invocation: refs.invocation
        });
        expectCode(
            "invocation commit without its receipt",
            () =>
                receiptCase.repository.transaction((tx) =>
                    validateCommitWriter(
                        tx,
                        { ...invocation("no-own-receipt"), receipt: undefined } as RunCommit,
                        receiptCase.evidence
                    )
                ),
            "authority.denied",
            "Receipt writer evidence does not match the Run commit"
        );
        expectCode(
            "invocation commit without its invocation",
            () =>
                receiptCase.repository.transaction((tx) =>
                    validateCommitWriter(
                        tx,
                        { ...invocation("no-own-invocation"), invocation: undefined } as RunCommit,
                        receiptCase.evidence
                    )
                ),
            "authority.denied",
            "Receipt writer evidence does not match the Run commit"
        );

        const deliveryCase = harness();
        deliveryCase.evidence.deliveries.set(`${refs.route.value}:${refs.audit.value}`, {
            kind: "delivery",
            run: ids.run,
            reservation: refs.route,
            audit: refs.audit
        });
        expectCode(
            "delivery commit without its reservation",
            () =>
                deliveryCase.repository.transaction((tx) =>
                    validateCommitWriter(
                        tx,
                        { ...delivery("no-own-reservation"), reservation: undefined } as RunCommit,
                        deliveryCase.evidence
                    )
                ),
            "authority.denied",
            "Delivery writer evidence does not match the Run commit"
        );

        const controlCase = harness();
        const withoutReceipt = {
            ...undo("control-no-own-receipt"),
            receipt: undefined
        } as RunCommit;
        controlCase.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: withoutReceipt.proposalDigest.value
        });
        expectCode(
            "undo commit without its receipt",
            () =>
                controlCase.repository.transaction((tx) =>
                    validateCommitWriter(tx, withoutReceipt, controlCase.evidence)
                ),
            "authority.denied",
            "Control writer evidence does not bind the complete Run commit proposal"
        );

        const synthesisCase = harness();
        const withoutContent = {
            ...synthesize("synthesis-no-own-content"),
            content: undefined
        } as RunCommit;
        synthesisCase.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: withoutContent.proposalDigest.value
        });
        synthesisCase.evidence.syntheses.set("synthesis-receipt", {
            kind: "synthesis",
            run: ids.run,
            receipt: new ReceiptId("synthesis-receipt"),
            token: { turn: ids.turn, holder: ids.holder, epoch: 1 },
            content: content("2")
        });
        expectCode(
            "synthesis commit without its content",
            () =>
                synthesisCase.repository.transaction((tx) =>
                    validateCommitWriter(tx, withoutContent, synthesisCase.evidence)
                ),
            "authority.denied",
            "Synthesis evidence does not match the exact token and content"
        );
    });

    test(
        "matches receipt evidence subject Turns exactly in both directions",
        { tags: "p0" },
        () => {
            const matching = harness();
            matching.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "receipt",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                invocation: refs.invocation,
                subjectTurn: ids.turn
            });
            expect(() =>
                matching.repository.transaction((tx) =>
                    validateCommitWriter(
                        tx,
                        invocation("subject-both", ids.turn),
                        matching.evidence
                    )
                )
            ).not.toThrow();

            const missing = harness();
            missing.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "receipt",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                invocation: refs.invocation
            });
            expectCode(
                "commit subject without evidence subject",
                () =>
                    missing.repository.transaction((tx) =>
                        validateCommitWriter(
                            tx,
                            invocation("subject-commit-only", ids.turn),
                            missing.evidence
                        )
                    ),
                "authority.denied",
                "Receipt writer evidence does not match the Run commit"
            );

            const different = harness();
            different.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "receipt",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                invocation: refs.invocation,
                subjectTurn: new TurnId("turn-other")
            });
            expectCode(
                "subjects present on both sides but different",
                () =>
                    different.repository.transaction((tx) =>
                        validateCommitWriter(
                            tx,
                            invocation("subject-different", ids.turn),
                            different.evidence
                        )
                    ),
                "authority.denied",
                "Receipt writer evidence does not match the Run commit"
            );
        }
    );

    test(
        "accepts exact synthesis evidence and denies token identity mismatches",
        { tags: "p0" },
        () => {
            const otherHolder = new PrincipalRef(
                new TenantId("tenant-1"),
                new PrincipalId("principal-other")
            );
            const tokens = [
                { label: "exact token", token: { turn: ids.turn, holder: ids.holder, epoch: 1 } },
                {
                    label: "different turn",
                    token: { turn: new TurnId("turn-other"), holder: ids.holder, epoch: 1 }
                },
                {
                    label: "different holder",
                    token: { turn: ids.turn, holder: otherHolder, epoch: 1 }
                }
            ] as const;
            for (const { label, token } of tokens) {
                const value = harness();
                const commit = synthesize("synthesis-token-identity");
                value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
                    kind: "control",
                    run: ids.run,
                    receipt: refs.receipt,
                    audit: refs.audit,
                    proposalDigest: commit.proposalDigest.value
                });
                value.evidence.syntheses.set("synthesis-receipt", {
                    kind: "synthesis",
                    run: ids.run,
                    receipt: new ReceiptId("synthesis-receipt"),
                    token,
                    content: content("2")
                });
                if (label === "exact token") {
                    expect(() =>
                        value.repository.transaction((tx) =>
                            validateCommitWriter(tx, commit, value.evidence)
                        )
                    ).not.toThrow();
                    continue;
                }
                expectCode(
                    label,
                    () =>
                        value.repository.transaction((tx) =>
                            validateCommitWriter(tx, commit, value.evidence)
                        ),
                    "authority.denied",
                    "Synthesis evidence does not match the exact token and content"
                );
            }
        }
    );
});
