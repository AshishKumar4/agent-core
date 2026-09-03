import { describe, expect, test } from "vitest";
import { MemoryActorStore, type SynchronousResultGuard } from "../../src/actors";
import { ContentStore, type ContentPutResult } from "../../src/content";
import { Revision, type JsonValue } from "../../src/core";
import { InvocationId } from "../../src/interaction-references";
import {
    Surface,
    SurfaceDescriptor,
    SurfaceId,
    type FacetData,
    type OperationContext
} from "../../src/facets";
import { DecisionSurfacePresentation } from "../../src/composition";
import {
    EventCursor,
    MemoryWorkspaceRecords,
    View,
    WorkspacePersistence
} from "../../src/workspaces";
import { prepared } from "../invocations/fixture";
import {
    DeterministicJsonPatchEngine,
    eventFixture,
    registerSurface,
    sourceActor,
    tenant
} from "../workspaces/fixtures";

/** The arguments a human is deciding about: someone else's command, and who asked. */
const decidedArguments: JsonValue = { command: "rm -rf /srv", requester: "mallory" };
const surfaceId = new SurfaceId("approval-gateway.decision");

/** One scripted approval Surface, answering whatever the case under test hands it. */
class ScriptedDecisionSurface extends Surface {
    public readonly seen: FacetData[] = [];

    public constructor(
        public readonly descriptor: SurfaceDescriptor,
        private readonly answer: FacetData
    ) {
        super();
    }

    public override async render(_context: OperationContext, input: FacetData): Promise<FacetData> {
        this.seen.push(input);
        return this.answer;
    }
}

/** A ContentStore no decision reaches: a View body is data, never a live reference. */
class UnreachedContentStore extends ContentStore {
    public async put(): Promise<ContentPutResult> {
        throw new TypeError("A decision presentation stores no content");
    }

    public async get(): Promise<Uint8Array> {
        throw new TypeError("A decision presentation resolves no content");
    }

    public async stat(): Promise<undefined> {
        return undefined;
    }
}

/**
 * The Workspace Actor's own state. The records live behind one field because an Actor
 * transaction hands the callback a Proxy over the state, and a class instance reached
 * through that Proxy cannot read its own private fields.
 */
interface DecisionState {
    readonly records: MemoryWorkspaceRecords;
}

interface Harness {
    readonly persistence: WorkspacePersistence<DecisionState>;
    readonly transaction: <Result>(
        operation: (state: DecisionState) => Result,
        ...guard: SynchronousResultGuard<Result>
    ) => Result;
    readonly patches: DeterministicJsonPatchEngine;
    readonly surface: ScriptedDecisionSurface;
    readonly presentation: DecisionSurfacePresentation<DecisionState>;
    readonly currentView: () => View | undefined;
}

function harness(answer: FacetData): Harness {
    const persistence = new WorkspacePersistence<DecisionState>(
        (state) => state.records,
        { verify: () => true, retain: () => {}, release: () => {}, discard: () => {} },
        sourceActor,
        tenant
    );
    const store = new MemoryActorStore<DecisionState>(
        { records: new MemoryWorkspaceRecords() },
        (state) => ({ records: state.records.clone() })
    );
    const transaction = <Result>(
        operation: (state: DecisionState) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result => store.transaction(operation, ...guard);
    transaction((state) => registerSurface(persistence, state, surfaceId));
    const patches = new DeterministicJsonPatchEngine();
    return {
        persistence,
        transaction,
        patches,
        surface: new ScriptedDecisionSurface(
            new SurfaceDescriptor(surfaceId, "Approval decisions"),
            answer
        ),
        presentation: new DecisionSurfacePresentation({ persistence, transaction, patches }),
        currentView: () =>
            transaction((state) =>
                persistence.currentView(
                    state,
                    surfaceId.value,
                    persistence.currentSurfaceEpoch(state, surfaceId.value)
                )
            )
    };
}

function context(): OperationContext {
    return {
        invocation: new InvocationId("decision-invocation"),
        itemIndex: 0,
        idempotencyKey: "decision-key",
        signal: new AbortController().signal,
        content: new UnreachedContentStore()
    };
}

/** The shape a Surface's decision answer travels in, so a case can vary one member. */
type RenderingAnswer = {
    readonly body: JsonValue;
    readonly actions: readonly JsonValue[];
    readonly placements: readonly JsonValue[];
};

/** The honest answer: prose in the platform's own voice, the input's values as data. */
function honestRendering(): RenderingAnswer {
    return {
        body: {
            headline: "Approve this command?",
            command: "rm -rf /srv",
            requester: "mallory"
        },
        actions: [
            { id: "approve", label: "Approve", emits: "approval.granted" },
            { id: "deny", label: "Deny", emits: "approval.denied" }
        ],
        placements: [
            { path: "/headline", position: "platformVoice" },
            { path: "/command", position: "data", source: "/command" },
            { path: "/requester", position: "data", source: "/requester" }
        ]
    };
}

describe("the decision presentation path", () => {
    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] composes a decision View from the exact prepared intent and marks every value the host did not originate",
        { tags: "p0" },
        async () => {
            const state = harness(honestRendering());
            const intent = prepared("approval-external", decidedArguments);
            const arrival = eventFixture("approval-external", { trust: "external" });

            const view = await state.presentation.present({
                surface: state.surface,
                context: context(),
                prepared: intent,
                itemIndex: 0,
                arrival,
                cursor: new EventCursor("decision-cursor-0")
            });

            // The Surface was asked about the exact intent, by digest, and answered
            // positions into arguments it did not write.
            expect(state.surface.seen).toEqual([
                { decided: decidedArguments, intentDigest: intent.intentDigest.value }
            ]);
            expect(view.intentDigest?.value).toBe(intent.intentDigest.value);
            expect(view.revision.value).toBe(0);
            expect(view.marks?.map((mark) => [mark.path, mark.tier])).toEqual([
                ["/command", "external"],
                ["/requester", "external"]
            ]);

            // Durable, and the provenance survives its own codec rather than living only
            // in the object the caller happens to hold.
            const stored = state.currentView();
            expect(stored).toBeDefined();
            const decoded = View.decode(View.encode(stored!));
            expect(decoded.intentDigest?.value).toBe(intent.intentDigest.value);
            expect(decoded.marks?.map((mark) => mark.tier)).toEqual(["external", "external"]);
            expect(decoded.body).toEqual(honestRenderingBody());
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] takes every mark's tier from the arrival record rather than from the Surface's answer",
        { tags: "p0" },
        async () => {
            // The identical rendering, presented three times: nothing the Surface says
            // changes the tier, because its answer carries no tier to say it with.
            const tiers: string[] = [];
            for (const arrival of [
                eventFixture("owner-arrival", { trust: "owner" }),
                eventFixture("external-arrival", { trust: "external" })
            ]) {
                const state = harness(honestRendering());
                const view = await state.presentation.present({
                    surface: state.surface,
                    context: context(),
                    prepared: prepared("approval-tier", decidedArguments),
                    itemIndex: 0,
                    arrival,
                    cursor: new EventCursor("decision-cursor-tier")
                });
                tiers.push(...(view.marks ?? []).map((mark) => mark.tier));
            }
            expect(tiers).toEqual(["owner", "owner", "external", "external"]);

            // No arrival Event means the Turn executor assembled the arguments under its
            // own lease, which §6.1 tiers `self` and only the host may assign.
            const emitted = harness(honestRendering());
            const view = await emitted.presentation.present({
                surface: emitted.surface,
                context: context(),
                prepared: prepared("approval-self", decidedArguments),
                itemIndex: 0,
                cursor: new EventCursor("decision-cursor-self")
            });
            expect(view.marks?.map((mark) => mark.tier)).toEqual(["self", "self"]);
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] refuses a Surface that renders someone else's input as platform voice, alters it, invents it, or leaves it undeclared",
        { tags: "p0" },
        async () => {
            const refusals: readonly [string, FacetData, RegExp][] = [
                [
                    "an attributed value in the headline",
                    {
                        ...honestRendering(),
                        placements: [
                            { path: "/headline", position: "platformVoice", source: "/command" },
                            { path: "/command", position: "data", source: "/command" },
                            { path: "/requester", position: "data", source: "/requester" }
                        ]
                    },
                    /renders an attributed value as data, never as platform voice: \/headline/
                ],
                [
                    "an attributed value the Surface altered",
                    {
                        ...honestRendering(),
                        body: {
                            headline: "Approve this command?",
                            command: "rm -rf /tmp",
                            requester: "mallory"
                        }
                    },
                    /renders a value its own source does not carry: \/command/
                ],
                [
                    "an attribution the intent does not hold",
                    {
                        ...honestRendering(),
                        placements: [
                            { path: "/headline", position: "platformVoice" },
                            { path: "/command", position: "data", source: "/command" },
                            { path: "/requester", position: "data", source: "/approver" }
                        ]
                    },
                    /attributes a value the decided intent does not hold: \/approver/
                ],
                [
                    "a rendered position no placement declares",
                    {
                        ...honestRendering(),
                        placements: [
                            { path: "/headline", position: "platformVoice" },
                            { path: "/command", position: "data", source: "/command" }
                        ]
                    },
                    /leaves a rendered position undeclared: \/requester/
                ],
                [
                    "host prose that repeats the input's own text",
                    {
                        ...honestRendering(),
                        body: {
                            headline: "mallory",
                            command: "rm -rf /srv",
                            requester: "mallory"
                        }
                    },
                    /speaks the decided intent's own text in platform voice: \/headline/
                ],
                [
                    "a button label synthesized from the input",
                    {
                        ...honestRendering(),
                        actions: [
                            { id: "approve", label: "rm -rf /srv", emits: "approval.granted" }
                        ]
                    },
                    /speaks the decided intent's own text in platform voice: the approve action label/
                ]
            ];

            for (const [label, answer, refusal] of refusals) {
                const state = harness(answer);
                await expect(
                    state.presentation.present({
                        surface: state.surface,
                        context: context(),
                        prepared: prepared("approval-refused", decidedArguments),
                        itemIndex: 0,
                        arrival: eventFixture("approval-refused", { trust: "external" }),
                        cursor: new EventCursor("decision-cursor-refused")
                    }),
                    label
                ).rejects.toThrow(refusal);
                // The refusal lands before durability: the stream never opened.
                expect(state.currentView(), label).toBeUndefined();
            }
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] carries a decision onto the next revision of an ordinary stream and replaces it on the one after",
        { tags: "p1" },
        async () => {
            const state = harness(honestRendering());
            // An ordinary View opens the stream, so the first decision must ADD the
            // provenance members and the second must REPLACE them.
            state.transaction((records) =>
                state.persistence.saveView(
                    records,
                    new View({
                        surface: surfaceId,
                        epoch: state.persistence.currentSurfaceEpoch(records, surfaceId.value),
                        revision: Revision.initial(),
                        body: { headline: "Nothing to decide" },
                        actions: [],
                        cursor: new EventCursor("decision-cursor-ordinary")
                    }),
                    undefined,
                    []
                )
            );

            const first = await state.presentation.present({
                surface: state.surface,
                context: context(),
                prepared: prepared("approval-first", decidedArguments),
                itemIndex: 0,
                arrival: eventFixture("approval-first", { trust: "external" }),
                cursor: new EventCursor("decision-cursor-1")
            });
            expect(first.revision.value).toBe(1);
            expect(state.patches.calls[0]?.patch).toEqual([
                { op: "replace", path: "/body", value: first.body },
                { op: "replace", path: "/actions", value: renderedActions(first) },
                { op: "add", path: "/intentDigest", value: first.intentDigest?.value },
                { op: "add", path: "/marks", value: renderedMarks(first) }
            ]);

            const second = await state.presentation.present({
                surface: state.surface,
                context: context(),
                prepared: prepared("approval-second", decidedArguments),
                itemIndex: 0,
                arrival: eventFixture("approval-second", { trust: "owner" }),
                cursor: new EventCursor("decision-cursor-2")
            });
            expect(second.revision.value).toBe(2);
            expect(state.patches.calls[1]?.patch).toEqual([
                { op: "replace", path: "/body", value: second.body },
                { op: "replace", path: "/actions", value: renderedActions(second) },
                { op: "replace", path: "/intentDigest", value: second.intentDigest?.value },
                { op: "replace", path: "/marks", value: renderedMarks(second) }
            ]);
            expect(second.marks?.map((mark) => mark.tier)).toEqual(["owner", "owner"]);
            expect(second.intentDigest?.value).not.toBe(first.intentDigest?.value);
            expect(state.currentView()?.revision.value).toBe(2);
        }
    );
});

function honestRenderingBody(): JsonValue {
    return { command: "rm -rf /srv", headline: "Approve this command?", requester: "mallory" };
}

function renderedActions(view: View): JsonValue {
    return view.actions.map((action) => ({
        arguments: action.arguments?.document ?? null,
        emits: action.emits.value,
        id: action.id.value,
        label: action.label
    }));
}

function renderedMarks(view: View): JsonValue {
    return (view.marks ?? []).map((mark) => ({ path: mark.path, tier: mark.tier }));
}
