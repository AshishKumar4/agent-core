import {
    Digest,
    JsonSchema,
    RecordCodec,
    Revision,
    isJsonObject,
    type JsonSchemaDocument,
    type JsonValue,
    type RecordVersion
} from "../core";
import { AgentCoreError } from "../errors";
import { EventKind, JsonPointer, SurfaceId, canonicalTrustTiers, type TrustTier } from "../facets";
import {
    decodeRevision,
    encodeRevision,
    requireArray,
    requireFields,
    requireNullableString,
    requireObject,
    requireString
} from "./codec";
import { ActionId, EventCursor } from "./id";
import { canonicalJson } from "./value";

export interface ActionDescriptorInit {
    readonly id: ActionId;
    readonly label: string;
    readonly emits: EventKind;
    readonly arguments?: JsonSchema;
}

class ActionDescriptorCodecV1 extends RecordCodec<ActionDescriptor> {
    public constructor() {
        super("workspace.action-descriptor", { major: 1, minor: 0 });
    }

    protected encodePayload(action: ActionDescriptor): JsonValue {
        return encodeAction(action);
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ActionDescriptor {
        return decodeAction(payload);
    }
}

export class ActionDescriptor {
    public static readonly codec: RecordCodec<ActionDescriptor> = new ActionDescriptorCodecV1();
    public readonly id: ActionId;
    public readonly label: string;
    public readonly emits: EventKind;
    public readonly arguments: JsonSchema | undefined;

    public constructor(init: ActionDescriptorInit) {
        if (!(init.id instanceof ActionId)) {
            throw new TypeError("Action ID must be an ActionId");
        }
        requireCanonicalText(init.label, "Action label");
        this.id = init.id;
        this.label = init.label;
        this.emits = init.emits;
        this.arguments =
            init.arguments === undefined ? undefined : new JsonSchema(init.arguments.document);
        Object.freeze(this);
    }

    public static encode(action: ActionDescriptor): Uint8Array {
        return ActionDescriptor.codec.encode(action);
    }

    public static decode(bytes: Uint8Array): ActionDescriptor {
        return ActionDescriptor.codec.decode(bytes);
    }
}

export interface ViewInit {
    readonly surface: SurfaceId;
    readonly revision: Revision;
    readonly body: JsonValue;
    readonly actions: readonly ActionDescriptor[];
    readonly cursor: EventCursor;
    readonly intentDigest?: Digest | undefined;
    readonly marks?: readonly ViewMark[] | undefined;
}

class ViewMarkCodecV1 extends RecordCodec<ViewMark> {
    public constructor() {
        super("workspace.view-mark", { major: 1, minor: 0 });
    }

    protected encodePayload(mark: ViewMark): JsonValue {
        return encodeViewMark(mark);
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ViewMark {
        return decodeViewMark(payload);
    }
}

export class ViewMark {
    public static readonly codec: RecordCodec<ViewMark> = new ViewMarkCodecV1();
    public readonly path: string;
    public readonly tier: TrustTier;

    public constructor(path: string, tier: TrustTier) {
        new JsonPointer(path);
        this.path = path;
        this.tier = canonicalTrustTiers([tier])[0];
        Object.freeze(this);
    }

    public static encode(mark: ViewMark): Uint8Array {
        return ViewMark.codec.encode(mark);
    }

    public static decode(bytes: Uint8Array): ViewMark {
        return ViewMark.codec.decode(bytes);
    }
}

class ViewCodecV2 extends RecordCodec<View> {
    public constructor() {
        super("workspace.view", { major: 2, minor: 0 });
    }

    protected encodePayload(view: View): JsonValue {
        return {
            surface: view.surface.value,
            revision: encodeRevision(view.revision),
            body: view.body,
            actions: view.actions.map(encodeAction),
            cursor: view.cursor.value,
            intentDigest: view.intentDigest?.value ?? null,
            marks: view.marks?.map(encodeViewMark) ?? null
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): View {
        const object = requireObject(payload, "View payload");
        requireFields(
            object,
            ["actions", "body", "cursor", "intentDigest", "marks", "revision", "surface"],
            "View payload"
        );
        const init = {
            surface: new SurfaceId(requireString(object["surface"], "View Surface ID")),
            revision: decodeRevision(object["revision"], "View revision"),
            body: canonicalJson(object["body"]),
            actions: requireArray(object["actions"], "View actions").map(decodeAction),
            cursor: new EventCursor(requireString(object["cursor"], "View cursor"))
        };
        const intentDigest = requireNullableString(object["intentDigest"], "View intent digest");
        const marks = decodeViewMarks(object["marks"]);
        return intentDigest === undefined
            ? new View(init)
            : new View({ ...init, intentDigest: new Digest(intentDigest), marks });
    }
}

export class View {
    public static readonly codec: RecordCodec<View> = new ViewCodecV2();

    public static encode(view: View): Uint8Array {
        return View.codec.encode(view);
    }

    public static decode(bytes: Uint8Array): View {
        return View.codec.decode(bytes);
    }

    public readonly surface: SurfaceId;
    public readonly revision: Revision;
    public readonly body: JsonValue;
    public readonly actions: readonly ActionDescriptor[];
    public readonly cursor: EventCursor;
    public readonly intentDigest: Digest | undefined;
    public readonly marks: readonly ViewMark[] | undefined;

    public constructor(init: ViewInit) {
        const actionIds = new Set<string>();
        const actions = init.actions.map(copyAction);
        for (const action of actions) {
            if (actionIds.has(action.id.value)) {
                throw new TypeError("View action IDs must be unique");
            }
            actionIds.add(action.id.value);
        }
        const body = canonicalJson(init.body);
        if (init.marks !== undefined && init.intentDigest === undefined) {
            throw new TypeError("Only a decision View may carry provenance marks");
        }
        const marks = init.marks?.map((mark) => new ViewMark(mark.path, mark.tier)) ?? [];
        marks.sort(compareViewMarks);
        for (const [index, mark] of marks.entries()) {
            if (marks[index - 1]?.path === mark.path) {
                throw new TypeError("View mark paths must be unique");
            }
            requireMarkedValue(body, mark.path);
        }
        this.surface = init.surface;
        this.revision = init.revision;
        this.body = body;
        this.actions = Object.freeze(actions);
        this.cursor = init.cursor;
        this.intentDigest =
            init.intentDigest === undefined ? undefined : new Digest(init.intentDigest.value);
        this.marks = init.intentDigest === undefined ? undefined : Object.freeze(marks);
        Object.freeze(this);
    }
}

export interface ViewDeltaInit {
    readonly surface: SurfaceId;
    readonly baseRevision: Revision;
    readonly revision: Revision;
    readonly patch: readonly JsonValue[];
    readonly cursor: EventCursor;
}

class ViewDeltaCodecV1 extends RecordCodec<ViewDelta> {
    public constructor() {
        super("workspace.view-delta", { major: 1, minor: 0 });
    }

    protected encodePayload(delta: ViewDelta): JsonValue {
        return {
            surface: delta.surface.value,
            baseRevision: encodeRevision(delta.baseRevision),
            revision: encodeRevision(delta.revision),
            patch: delta.patch,
            cursor: delta.cursor.value
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ViewDelta {
        const object = requireObject(payload, "View delta payload");
        requireFields(
            object,
            ["baseRevision", "cursor", "patch", "revision", "surface"],
            "View delta payload"
        );
        return new ViewDelta({
            surface: new SurfaceId(requireString(object["surface"], "Delta Surface ID")),
            baseRevision: decodeRevision(object["baseRevision"], "Delta base revision"),
            revision: decodeRevision(object["revision"], "Delta revision"),
            patch: requireArray(object["patch"], "View patch").map(canonicalJson),
            cursor: new EventCursor(requireString(object["cursor"], "Delta cursor"))
        });
    }
}

export class ViewDelta {
    public static readonly codec: RecordCodec<ViewDelta> = new ViewDeltaCodecV1();

    public static encode(delta: ViewDelta): Uint8Array {
        return ViewDelta.codec.encode(delta);
    }

    public static decode(bytes: Uint8Array): ViewDelta {
        return ViewDelta.codec.decode(bytes);
    }

    public readonly surface: SurfaceId;
    public readonly baseRevision: Revision;
    public readonly revision: Revision;
    public readonly patch: readonly JsonValue[];
    public readonly cursor: EventCursor;

    public constructor(init: ViewDeltaInit) {
        if (!init.baseRevision.next().equals(init.revision)) {
            throw new TypeError("View delta revision must immediately follow its base revision");
        }
        this.surface = init.surface;
        this.baseRevision = init.baseRevision;
        this.revision = init.revision;
        this.patch = Object.freeze(init.patch.map(canonicalJson));
        this.cursor = init.cursor;
        Object.freeze(this);
    }
}

export interface JsonPatchEngine {
    apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue;
}

export function viewDocument(view: View): JsonValue {
    return canonicalJson({
        body: view.body,
        actions: view.actions.map(encodeAction),
        intentDigest: view.intentDigest?.value ?? null,
        marks: view.marks?.map(encodeViewMark) ?? null
    });
}

export function viewFromDocument(previous: View, delta: ViewDelta, document: JsonValue): View {
    const object = requireObject(document, "Patched View document");
    requireFields(object, ["actions", "body", "intentDigest", "marks"], "Patched View document");
    if (!previous.surface.equals(delta.surface) || !previous.revision.equals(delta.baseRevision)) {
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "View delta does not continue the supplied View"
        );
    }
    const init = {
        surface: previous.surface,
        revision: delta.revision,
        body: canonicalJson(object["body"]),
        actions: requireArray(object["actions"], "Patched View actions").map(decodeAction),
        cursor: delta.cursor
    };
    const intentDigest = requireNullableString(
        object["intentDigest"],
        "Patched View intent digest"
    );
    const marks = decodeViewMarks(object["marks"]);
    return intentDigest === undefined
        ? new View(init)
        : new View({ ...init, intentDigest: new Digest(intentDigest), marks });
}

function encodeViewMark(mark: ViewMark): JsonValue {
    return { path: mark.path, tier: mark.tier };
}

function decodeViewMark(value: JsonValue): ViewMark {
    const object = requireObject(value, "View mark");
    requireFields(object, ["path", "tier"], "View mark");
    const tier = requireString(object["tier"], "View mark trust tier");
    return new ViewMark(requireString(object["path"], "View mark path"), requireTrustTier(tier));
}

function decodeViewMarks(value: JsonValue | undefined): readonly ViewMark[] | undefined {
    if (value === null) return undefined;
    return requireArray(value, "View marks").map(decodeViewMark);
}

function requireTrustTier(value: string): TrustTier {
    if (
        value === "owner" ||
        value === "authenticated" ||
        value === "external" ||
        value === "self"
    ) {
        return value;
    }
    throw new TypeError("View mark trust tier is invalid");
}

function compareViewMarks(left: ViewMark, right: ViewMark): number {
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function requireMarkedValue(body: JsonValue, pointer: string): void {
    let value = body;
    for (const token of new JsonPointer(pointer).tokens) {
        if (Array.isArray(value)) {
            if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
                throw new TypeError("View mark path does not resolve within the View body");
            }
            const index = Number(token);
            const next = Number.isSafeInteger(index) ? value[index] : undefined;
            if (next === undefined) {
                throw new TypeError("View mark path does not resolve within the View body");
            }
            value = next;
        } else if (isJsonObject(value) && Object.hasOwn(value, token)) {
            const next = value[token];
            if (next === undefined) {
                throw new TypeError("View mark path does not resolve within the View body");
            }
            value = next;
        } else {
            throw new TypeError("View mark path does not resolve within the View body");
        }
    }
}

function encodeAction(action: ActionDescriptor): JsonValue {
    return {
        id: action.id.value,
        label: action.label,
        emits: action.emits.value,
        arguments: action.arguments?.document ?? null
    };
}

function decodeAction(value: JsonValue): ActionDescriptor {
    const object = requireObject(value, "View action");
    requireFields(object, ["arguments", "emits", "id", "label"], "View action");
    const argumentsDocument = object["arguments"];
    const action: ActionDescriptorInit = {
        id: new ActionId(requireString(object["id"], "Action ID")),
        label: requireString(object["label"], "Action label"),
        emits: new EventKind(requireString(object["emits"], "Action Event kind"))
    };
    return new ActionDescriptor(
        argumentsDocument === null
            ? action
            : { ...action, arguments: new JsonSchema(requireSchemaDocument(argumentsDocument)) }
    );
}

function copyAction(action: ActionDescriptor): ActionDescriptor {
    const copy: ActionDescriptorInit = {
        id: action.id,
        label: action.label,
        emits: action.emits
    };
    return new ActionDescriptor(
        action.arguments === undefined ? copy : { ...copy, arguments: action.arguments }
    );
}

function requireSchemaDocument(value: JsonValue): JsonSchemaDocument {
    if (isBooleanValue(value) || isJsonObject(value)) return value;
    throw new TypeError("View action arguments must be a JSON Schema object or boolean");
}

function isBooleanValue(value: JsonValue): value is boolean {
    return typeof value === "boolean";
}

function requireCanonicalText(value: string, subject: string): void {
    if (value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}
