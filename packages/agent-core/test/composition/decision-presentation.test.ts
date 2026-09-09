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
    DecidedInput,
    DecisionPlacement,
    DecisionRendering,
    EventCursor,
    MemoryWorkspaceRecords,
    View,
    ViewPosition,
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

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] presents an indeterminate item as unmarked host data and still refuses prose that repeats it",
        { tags: "p1" },
        async () => {
            // A decision whose item is still indeterminate — no verdict, a pending count,
            // and a null reviewer. A value the host originated carries no mark, so the
            // decision View states it with no provenance at all rather than an empty one.
            const indeterminate: JsonValue = { command: "rm -rf /srv", pending: 2 };
            const state = harness({
                body: {
                    headline: "Awaiting a second reviewer",
                    command: "rm -rf /srv",
                    outstanding: 2,
                    reviewer: null
                },
                actions: [{ id: "wait", label: "Keep waiting", emits: "approval.deferred" }],
                placements: [
                    { path: "/headline", position: "platformVoice" },
                    { path: "/command", position: "data", source: "/command" },
                    // A count and a null the host wrote itself: host-authored positions
                    // carrying no source, so neither inherits a mark.
                    { path: "/outstanding", position: "platformVoice" },
                    { path: "/reviewer", position: "data" }
                ]
            });
            const view = await state.presentation.present({
                surface: state.surface,
                context: context(),
                prepared: prepared("approval-indeterminate", indeterminate),
                itemIndex: 0,
                arrival: eventFixture("approval-indeterminate", { trust: "external" }),
                cursor: new EventCursor("decision-cursor-indeterminate")
            });

            // Exactly the attributed position is marked. The host's own count repeats a
            // number the input carries and is admitted anyway: a number carries no voice,
            // and refusing it would refuse an ordinary count.
            expect(view.marks?.map((mark) => [mark.path, mark.tier])).toEqual([
                ["/command", "external"]
            ]);

            // The same Surface saying the input's own words in that position is refused,
            // which is what makes admitting the number a decision rather than a gap.
            const speaking = harness({
                body: {
                    headline: "Awaiting a second reviewer",
                    command: "rm -rf /srv",
                    outstanding: "rm -rf /srv",
                    reviewer: null
                },
                actions: [{ id: "wait", label: "Keep waiting", emits: "approval.deferred" }],
                placements: [
                    { path: "/headline", position: "platformVoice" },
                    { path: "/command", position: "data", source: "/command" },
                    { path: "/outstanding", position: "platformVoice" },
                    { path: "/reviewer", position: "data" }
                ]
            });
            await expect(
                speaking.presentation.present({
                    surface: speaking.surface,
                    context: context(),
                    prepared: prepared("approval-indeterminate", indeterminate),
                    itemIndex: 0,
                    arrival: eventFixture("approval-indeterminate", { trust: "external" }),
                    cursor: new EventCursor("decision-cursor-indeterminate-2")
                })
            ).rejects.toThrow(
                /speaks the decided intent's own text in platform voice: \/outstanding/
            );
            expect(speaking.currentView()).toBeUndefined();
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] declares and marks every leaf a refused item renders, inside arrays and under escaped keys",
        { tags: "p1" },
        async () => {
            // A refused item: the reasons the requester gave, listed, and the escaped
            // pointer keys a real body reaches for. Every leaf is a rendered position, so
            // every leaf is declared — an array entry and a `/`-bearing key included.
            const refusedItem: JsonValue = {
                command: "rm -rf /srv",
                reasons: ["disk is full", "backup is stale"],
                "policy/scope": "production",
                "tilde~key": "escaped"
            };
            const state = harness({
                body: {
                    headline: "This request was refused",
                    reasons: ["disk is full", "backup is stale"],
                    "policy/scope": "production",
                    "tilde~key": "escaped"
                },
                actions: [{ id: "dismiss", label: "Dismiss", emits: "approval.dismissed" }],
                placements: [
                    { path: "/headline", position: "platformVoice" },
                    { path: "/reasons/0", position: "data", source: "/reasons/0" },
                    { path: "/reasons/1", position: "data", source: "/reasons/1" },
                    { path: "/policy~1scope", position: "data", source: "/policy~1scope" },
                    { path: "/tilde~0key", position: "data", source: "/tilde~0key" }
                ]
            });
            const view = await state.presentation.present({
                surface: state.surface,
                context: context(),
                prepared: prepared("approval-refused-item", refusedItem),
                itemIndex: 0,
                arrival: eventFixture("approval-refused-item", { trust: "external" }),
                cursor: new EventCursor("decision-cursor-refused-item")
            });
            expect(view.marks?.map((mark) => mark.path)).toEqual([
                "/policy~1scope",
                "/reasons/0",
                "/reasons/1",
                "/tilde~0key"
            ]);

            // Leaving one array entry undeclared is the hole the placement list closes:
            // an undeclared leaf would inherit neither a mark nor the host-voice refusal.
            const undeclared = harness({
                body: {
                    headline: "This request was refused",
                    reasons: ["disk is full", "backup is stale"],
                    "policy/scope": "production",
                    "tilde~key": "escaped"
                },
                actions: [{ id: "dismiss", label: "Dismiss", emits: "approval.dismissed" }],
                placements: [
                    { path: "/headline", position: "platformVoice" },
                    { path: "/reasons/0", position: "data", source: "/reasons/0" },
                    { path: "/policy~1scope", position: "data", source: "/policy~1scope" },
                    { path: "/tilde~0key", position: "data", source: "/tilde~0key" }
                ]
            });
            await expect(
                undeclared.presentation.present({
                    surface: undeclared.surface,
                    context: context(),
                    prepared: prepared("approval-refused-item", refusedItem),
                    itemIndex: 0,
                    arrival: eventFixture("approval-refused-item", { trust: "external" }),
                    cursor: new EventCursor("decision-cursor-undeclared-entry")
                })
            ).rejects.toThrow(/leaves a rendered position undeclared: \/reasons\/1/);
            expect(undeclared.currentView()).toBeUndefined();
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] refuses host prose that repeats text the decided input carries anywhere inside it",
        { tags: "p0" },
        async () => {
            // The input's text is not only at its top level. A Surface that lifts a string
            // out of a nested object or an array and calls it its own prose has reached
            // platform voice with someone else's words, which is the case the recursive
            // collection exists for.
            const nested: JsonValue = {
                request: { command: "rm -rf /srv", notes: ["urgent", "signed off by mallory"] }
            };
            for (const [subject, headline] of [
                ["a nested object's text", "rm -rf /srv"],
                ["an array entry's text", "signed off by mallory"]
            ] as const) {
                const state = harness({
                    body: { headline, command: "rm -rf /srv" },
                    actions: [{ id: "deny", label: "Deny", emits: "approval.denied" }],
                    placements: [
                        { path: "/headline", position: "platformVoice" },
                        { path: "/command", position: "data", source: "/request/command" }
                    ]
                });
                await expect(
                    state.presentation.present({
                        surface: state.surface,
                        context: context(),
                        prepared: prepared("approval-nested", nested),
                        itemIndex: 0,
                        arrival: eventFixture("approval-nested", { trust: "external" }),
                        cursor: new EventCursor("decision-cursor-nested")
                    }),
                    subject
                ).rejects.toThrow(
                    /speaks the decided intent's own text in platform voice: \/headline/
                );
                expect(state.currentView(), subject).toBeUndefined();
            }

            // The same nested source, honestly attributed, is admitted and marked — so the
            // refusals above are about voice, not about reaching into the input at all.
            const honest = harness({
                body: { headline: "Approve this command?", command: "rm -rf /srv" },
                actions: [{ id: "deny", label: "Deny", emits: "approval.denied" }],
                placements: [
                    { path: "/headline", position: "platformVoice" },
                    { path: "/command", position: "data", source: "/request/command" }
                ]
            });
            const view = await honest.presentation.present({
                surface: honest.surface,
                context: context(),
                prepared: prepared("approval-nested", nested),
                itemIndex: 0,
                arrival: eventFixture("approval-nested", { trust: "external" }),
                cursor: new EventCursor("decision-cursor-nested-honest")
            });
            expect(view.marks?.map((mark) => [mark.path, mark.tier])).toEqual([
                ["/command", "external"]
            ]);
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] refuses a malformed render answer before any of it becomes durable",
        { tags: "p0" },
        async () => {
            // `Surface.render` answers generic FacetData. Everything a decision View
            // depends on — that positions are declared once, that each names a real
            // pointer, that a position label is one this module knows, that an action is
            // an action — is decided here, on the way in, or not at all.
            const refusals: readonly [string, FacetData, RegExp][] = [
                [
                    "an answer that is not an object",
                    ["body", "actions", "placements"],
                    /Decision rendering/
                ],
                [
                    "an answer missing its placements",
                    { body: { headline: "Approve?" }, actions: [] },
                    /Decision rendering/
                ],
                [
                    // An in-process Surface can hand back the key with nothing under it,
                    // which the field check alone admits: the key is present.
                    "an answer whose body key carries nothing",
                    answerWithoutBody(),
                    /A decision rendering carries a body/
                ],
                [
                    "a placement that is not an object",
                    { ...honestRendering(), placements: ["/headline"] },
                    /Decision placement/
                ],
                [
                    "a placement naming no path inside the body",
                    {
                        ...honestRendering(),
                        placements: [{ path: "", position: "platformVoice" }]
                    },
                    /A decision placement names a position inside the View body/
                ],
                [
                    "a placement whose path is not a JSON Pointer",
                    {
                        ...honestRendering(),
                        placements: [{ path: "headline", position: "platformVoice" }]
                    },
                    /pointer/i
                ],
                [
                    "a placement whose source is not a JSON Pointer",
                    {
                        ...honestRendering(),
                        placements: [
                            { path: "/headline", position: "platformVoice" },
                            { path: "/command", position: "data", source: "command" },
                            { path: "/requester", position: "data", source: "/requester" }
                        ]
                    },
                    /pointer/i
                ],
                [
                    "a position label this module does not know",
                    {
                        ...honestRendering(),
                        placements: [{ path: "/headline", position: "quotedAside" }]
                    },
                    /Decision placement position is unknown: quotedAside/
                ],
                [
                    "the same position declared twice",
                    {
                        ...honestRendering(),
                        placements: [
                            { path: "/headline", position: "platformVoice" },
                            { path: "/headline", position: "data", source: "/command" },
                            { path: "/command", position: "data", source: "/command" },
                            { path: "/requester", position: "data", source: "/requester" }
                        ]
                    },
                    /A decision rendering declares each position once/
                ],
                [
                    "an action whose arguments are neither a schema nor a boolean",
                    {
                        ...honestRendering(),
                        actions: [
                            {
                                id: "approve",
                                label: "Approve",
                                emits: "approval.granted",
                                arguments: 7
                            }
                        ]
                    },
                    /A decision action's arguments are a JSON Schema object or boolean/
                ],
                [
                    "an action that is not an object",
                    { ...honestRendering(), actions: ["approve"] },
                    /Decision rendering action/
                ],
                [
                    "a placement naming a position the body does not render",
                    {
                        ...honestRendering(),
                        placements: [
                            { path: "/headline", position: "platformVoice" },
                            { path: "/command", position: "data", source: "/command" },
                            { path: "/requester", position: "data", source: "/requester" },
                            { path: "/approver", position: "data", source: "/requester" }
                        ]
                    },
                    /names no position in the rendered body: \/approver/
                ]
            ];

            for (const [label, answer, refusal] of refusals) {
                const state = harness(answer);
                await expect(
                    state.presentation.present({
                        surface: state.surface,
                        context: context(),
                        prepared: prepared("approval-malformed", decidedArguments),
                        itemIndex: 0,
                        arrival: eventFixture("approval-malformed", { trust: "external" }),
                        cursor: new EventCursor("decision-cursor-malformed")
                    }),
                    label
                ).rejects.toThrow(refusal);
                expect(state.currentView(), label).toBeUndefined();
            }
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] carries an action's declared argument schema onto the decision View",
        { tags: "p2" },
        async () => {
            // An action a decision offers may take arguments, and `true`/`false` are
            // schemas too — the permissive and the closed one. The View a viewer acts
            // through carries whichever the Surface declared, so a client cannot be
            // offered a button whose payload the host never described.
            const state = harness({
                ...honestRendering(),
                actions: [
                    {
                        id: "approve",
                        label: "Approve",
                        emits: "approval.granted",
                        arguments: { type: "object", properties: { note: { type: "string" } } }
                    },
                    { id: "deny", label: "Deny", emits: "approval.denied", arguments: false },
                    { id: "defer", label: "Defer", emits: "approval.deferred", arguments: true }
                ]
            });
            const view = await state.presentation.present({
                surface: state.surface,
                context: context(),
                prepared: prepared("approval-actions", decidedArguments),
                itemIndex: 0,
                arrival: eventFixture("approval-actions", { trust: "external" }),
                cursor: new EventCursor("decision-cursor-actions")
            });
            expect(view.actions.map((action) => action.arguments?.document)).toEqual([
                { type: "object", properties: { note: { type: "string" } } },
                false,
                true
            ]);

            // And it survives the durable codec rather than living only in the composed
            // object this caller happens to hold.
            const decoded = View.decode(View.encode(state.currentView()!));
            expect(decoded.actions.map((action) => action.arguments?.document)).toEqual([
                { type: "object", properties: { note: { type: "string" } } },
                false,
                true
            ]);
        }
    );
});

describe("a decision rendering built in process", () => {
    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] refuses a rendering assembled from anything but real placements and actions",
        { tags: "p1" },
        () => {
            // An in-process Facet builds these directly rather than through the decoder,
            // so the constructor owes the same refusals the wire path gets: a placement
            // that is not one carries no position to check, and an action that is not one
            // carries no label to hold against the input's text.
            const honest = new DecisionPlacement({ path: "/command", position: ViewPosition.data });
            // SAFETY: DecisionRenderingInit takes DecisionPlacements, so a placement-shaped
            // object literal is unreachable through the type. The instance check has to run
            // before the path is read, which is what this pins.
            const placementShaped = { path: "/command", position: ViewPosition.data } as never;
            expect(
                () =>
                    new DecisionRendering({
                        body: { command: "rm -rf /srv" },
                        actions: [],
                        placements: [placementShaped]
                    })
            ).toThrow(/A decision rendering carries DecisionPlacements/);
            // SAFETY: the same for actions — an ActionDescriptor-shaped literal cannot reach
            // this constructor through the type, and its label is what the host-voice refusal
            // reads, so the instance check guards a value that check would otherwise trust.
            const actionShaped = { id: "approve", label: "Approve" } as never;
            expect(
                () =>
                    new DecisionRendering({
                        body: { command: "rm -rf /srv" },
                        actions: [actionShaped],
                        placements: [honest]
                    })
            ).toThrow(/A decision rendering carries ActionDescriptors/);
            expect(
                () =>
                    new DecisionRendering({
                        body: { command: "rm -rf /srv" },
                        actions: [],
                        placements: [honest, honest]
                    })
            ).toThrow(/A decision rendering declares each position once/);

            // A placement carries a real ViewPosition, not a label that looks like one.
            // SAFETY: `position` is typed ViewPosition, so the wire label it decodes from is
            // unreachable here; admitting one would give the placement no admitsAttributed to
            // ask, which is the check this pins.
            const labelNotPosition = "data" as never;
            expect(
                () => new DecisionPlacement({ path: "/command", position: labelNotPosition })
            ).toThrow(/A decision placement carries a ViewPosition/);
        }
    );

    test(
        "[C13-VIEW-APPROVAL-PROVENANCE] round-trips a placement through its own data without losing where the value came from",
        { tags: "p2" },
        () => {
            // Whether a position is attributed is the difference between a marked value
            // and host prose, so it has to survive the encoding a rendering travels in
            // rather than being reconstructed by whoever decodes it.
            for (const placement of [
                new DecisionPlacement({ path: "/headline", position: ViewPosition.platformVoice }),
                new DecisionPlacement({
                    path: "/command",
                    position: ViewPosition.data,
                    source: "/command"
                })
            ]) {
                const restored = DecisionPlacement.fromData(placement.toData());
                expect(restored.path).toBe(placement.path);
                expect(restored.source).toBe(placement.source);
                expect(restored.position).toBe(placement.position);
                expect(restored.position.admitsAttributed()).toBe(
                    placement.position.admitsAttributed()
                );
            }

            // Host-authored is the absence of a source, not a source spelled empty: an
            // encoded placement that never named one carries no `source` member at all.
            expect(
                new DecisionPlacement({
                    path: "/headline",
                    position: ViewPosition.platformVoice
                }).toData()
            ).toStrictEqual({ path: "/headline", position: "platformVoice" });
        }
    );

    test(
        "[C13-TRUST-HOST-DERIVED] refuses a delivered decision input that names no Event to take its tier from",
        { tags: "p0" },
        () => {
            // The tier is read off the arrival record. An input that carries a value but
            // no Event has nothing host-owned to read it from, and admitting one would
            // let the caller pick the tier by supplying whatever answers `trust`.
            // SAFETY: DecidedInput.delivered takes an Event, so an object that merely
            // answers `trust` is unreachable through the type. Reading the tier off the
            // record the host owns is the whole of C13-TRUST-HOST-DERIVED here, so the
            // instance check must refuse the impostor rather than read its field.
            const notAnEvent = { trust: "owner" } as never;
            expect(() => DecidedInput.delivered(notAnEvent, { command: "rm -rf /srv" })).toThrow(
                /A delivered decision input names the Event it arrived on/
            );

            const arrival = eventFixture("input-tier", { trust: "external" });
            expect(DecidedInput.delivered(arrival, { command: "x" }).tier).toBe("external");
            expect(DecidedInput.emitted({ command: "x" }).tier).toBe("self");
        }
    );
});

function honestRenderingBody(): JsonValue {
    return { command: "rm -rf /srv", headline: "Approve this command?", requester: "mallory" };
}

/**
 * A render answer whose `body` key is present with nothing under it. Canonical JSON cannot
 * express this, but an in-process Facet returning an object literal can, and the exact-field
 * check admits it because the key is there — so the decoder owes its own refusal.
 */
type BodylessAnswer = {
    readonly actions: readonly JsonValue[];
    readonly body: JsonValue | undefined;
    readonly placements: readonly JsonValue[];
};

function answerWithoutBody(): FacetData {
    const answer: BodylessAnswer = { actions: [], body: undefined, placements: [] };
    // SAFETY: FacetData is JsonValue, which has no undefined member to hold; this is the
    // untyped boundary `Surface.render` actually answers across.
    return answer as FacetData;
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
