import {
    Digest,
    JsonSchema,
    RecordCodec,
    Revision,
    isJsonObject,
    type JsonFields,
    type JsonSchemaDocument,
    type JsonObject,
    type JsonValue,
    type RecordVersion,
    TextId
} from "../core";
import { AgentCoreError } from "../errors";
import { EventKind, JsonPointer, SurfaceId, canonicalTrustTiers, type TrustTier } from "../facets";
import {
    decodeRevision,
    encodeRevision,
    requireArray,
    requireFields,
    requireObject,
    requireOptionalFields,
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
        super(
            [ActionDescriptor, TextId, JsonSchema, EventKind, ActionId],
            "workspace.action-descriptor",
            {
                major: 1,
                minor: 0
            }
        );
    }

    protected encodePayload(action: ActionDescriptor): JsonValue {
        return encodeAction(action);
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ActionDescriptor {
        return decodeAction(payload);
    }
}

export class ActionDescriptor {
    public static get codec(): RecordCodec<ActionDescriptor> {
        return actionDescriptorCodecInstance;
    }
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

const actionDescriptorCodecInstance = new ActionDescriptorCodecV1();

interface ViewBaseInit {
    readonly surface: SurfaceId;
    readonly revision: Revision;
    readonly body: JsonValue;
    readonly actions: readonly ActionDescriptor[];
    readonly cursor: EventCursor;
    readonly terminal?: true | undefined;
}

interface OrdinaryViewInit {
    readonly intentDigest?: never;
    readonly marks?: never;
}

interface DecisionViewInit {
    readonly intentDigest: Digest;
    readonly marks: readonly ViewMark[];
}

export type ViewInit = ViewBaseInit & (OrdinaryViewInit | DecisionViewInit);

class ViewMarkCodecV1 extends RecordCodec<ViewMark> {
    public constructor() {
        super([ViewMark, JsonPointer], "workspace.view-mark", { major: 1, minor: 0 });
    }

    protected encodePayload(mark: ViewMark): JsonValue {
        return encodeViewMark(mark);
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): ViewMark {
        return decodeViewMark(payload);
    }
}

export class ViewMark {
    public static get codec(): RecordCodec<ViewMark> {
        return viewMarkCodecInstance;
    }
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

const viewMarkCodecInstance = new ViewMarkCodecV1();

/**
 * Major 2 carries §6.3's terminal discriminator: a retired Surface's last View encodes
 * `terminal` by presence, and absence is a live Surface. Every key outside the declared
 * set is refused.
 */
class ViewCodecV2 extends RecordCodec<View> {
    public constructor() {
        super(
            [
                View,
                Revision,
                TextId,
                ViewMark,
                JsonPointer,
                Digest,
                ActionDescriptor,
                ActionId,
                SurfaceId,
                EventCursor,
                JsonSchema,
                EventKind
            ],
            "workspace.view",
            { major: 2, minor: 0 }
        );
    }

    protected encodePayload(view: View): JsonValue {
        return {
            surface: view.surface.value,
            revision: encodeRevision(view.revision),
            body: view.body,
            actions: view.actions.map(encodeAction),
            cursor: view.cursor.value,
            ...encodeTerminality(view),
            ...encodeViewProvenance(view)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): View {
        const object = requireObject(payload, "View payload");
        const provenance = decodeViewProvenance(object, "View payload");
        requireViewFields(
            object,
            provenance,
            ["actions", "body", "cursor", "revision", "surface"],
            "View payload"
        );
        const init = {
            surface: new SurfaceId(requireString(object["surface"], "View Surface ID")),
            revision: decodeRevision(object["revision"], "View revision"),
            body: canonicalJson(object["body"]),
            actions: requireArray(object["actions"], "View actions").map(decodeAction),
            cursor: new EventCursor(requireString(object["cursor"], "View cursor")),
            terminal: decodeTerminal(object, "View payload")
        };
        return provenance === undefined ? new View(init) : new View({ ...init, ...provenance });
    }
}

export class View {
    public static get codec(): RecordCodec<View> {
        return viewCodecInstance;
    }

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
    // §6.3: retirement is declared by the field's presence, exactly as a decision View is
    // discriminated by intentDigest — a live Surface carries no terminal key at all.
    public readonly terminal: true | undefined;
    declare public readonly intentDigest?: Digest;
    declare public readonly marks?: readonly ViewMark[];

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
        const provenance = requireViewProvenance(init);
        const marks = provenance?.marks.map((mark) => new ViewMark(mark.path, mark.tier)) ?? [];
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
        if (init.terminal !== undefined && init.terminal !== true) {
            throw new TypeError("View terminality is declared by presence");
        }
        this.terminal = init.terminal;
        if (provenance !== undefined) {
            this.intentDigest = new Digest(provenance.intentDigest.value);
            this.marks = Object.freeze(marks);
        }
        Object.freeze(this);
    }
}

const viewCodecInstance = new ViewCodecV2();

export interface ViewDeltaInit {
    readonly surface: SurfaceId;
    readonly baseRevision: Revision;
    readonly revision: Revision;
    readonly patch: readonly JsonValue[];
    readonly cursor: EventCursor;
}

class ViewDeltaCodecV1 extends RecordCodec<ViewDelta> {
    public constructor() {
        super([ViewDelta, Revision, TextId, SurfaceId, EventCursor], "workspace.view-delta", {
            major: 1,
            minor: 0
        });
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
    public static get codec(): RecordCodec<ViewDelta> {
        return viewDeltaCodecInstance;
    }

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

const viewDeltaCodecInstance = new ViewDeltaCodecV1();

export interface JsonPatchEngine {
    apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue;
}

export function viewDocument(view: View): JsonValue {
    return canonicalJson({
        body: view.body,
        actions: view.actions.map(encodeAction),
        ...encodeTerminality(view),
        ...encodeViewProvenance(view)
    });
}

export function viewFromDocument(previous: View, delta: ViewDelta, document: JsonValue): View {
    const object = requireObject(document, "Patched View document");
    const provenance = decodeViewProvenance(object, "Patched View document");
    requireViewFields(object, provenance, ["actions", "body"], "Patched View document");
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
        cursor: delta.cursor,
        terminal: decodeTerminal(object, "Patched View document")
    };
    return provenance === undefined ? new View(init) : new View({ ...init, ...provenance });
}

function encodeViewMark(mark: ViewMark): JsonValue {
    return { path: mark.path, tier: mark.tier };
}

interface ViewProvenance {
    readonly intentDigest: Digest;
    readonly marks: readonly ViewMark[];
}

function requireViewProvenance(view: ViewInit | View): ViewProvenance | undefined {
    const hasIntent = Object.hasOwn(view, "intentDigest");
    const hasMarks = Object.hasOwn(view, "marks");
    const intentDigest = view.intentDigest;
    const marks = view.marks;
    if (!hasIntent && !hasMarks) return undefined;
    if (!hasIntent || !hasMarks || intentDigest === undefined || marks === undefined) {
        throw new TypeError("Decision View provenance requires both intentDigest and marks");
    }
    return { intentDigest, marks };
}

function encodeViewProvenance(view: View): JsonObject {
    const provenance = requireViewProvenance(view);
    return provenance === undefined
        ? {}
        : {
              intentDigest: provenance.intentDigest.value,
              marks: provenance.marks.map(encodeViewMark)
          };
}

function encodeTerminality(view: View): JsonObject {
    return view.terminal === undefined ? {} : { terminal: view.terminal };
}

function decodeViewMark(value: JsonValue): ViewMark {
    const object = requireObject(value, "View mark");
    requireFields(object, ["path", "tier"], "View mark");
    const tier = requireString(object["tier"], "View mark trust tier");
    return new ViewMark(requireString(object["path"], "View mark path"), requireTrustTier(tier));
}

function decodeViewProvenance(object: JsonObject, subject: string): ViewProvenance | undefined {
    const hasIntent = Object.hasOwn(object, "intentDigest");
    const hasMarks = Object.hasOwn(object, "marks");
    if (!hasIntent && !hasMarks) return undefined;
    if (!hasIntent || !hasMarks) {
        throw new TypeError(`${subject} must carry both intentDigest and marks or omit both`);
    }
    return {
        intentDigest: new Digest(requireString(object["intentDigest"], `${subject} intent digest`)),
        marks: requireArray(object["marks"], `${subject} marks`).map(decodeViewMark)
    };
}

function decodeTerminal(object: JsonObject, subject: string): true | undefined {
    const terminal = object["terminal"];
    if (terminal === undefined) return undefined;
    if (terminal !== true) throw new TypeError(`${subject} terminality is encoded by presence`);
    return true;
}

function requireViewFields<Field extends string>(
    object: JsonObject,
    provenance: ViewProvenance | undefined,
    fields: readonly Field[],
    subject: string
): asserts object is JsonFields<Field> {
    requireOptionalFields(
        object,
        provenance === undefined ? fields : [...fields, "intentDigest", "marks"],
        ["terminal"],
        subject
    );
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
