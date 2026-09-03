import {
    Digest,
    JsonSchema,
    encodeCanonicalJson,
    isJsonObject,
    isJsonString,
    type JsonValue,
    type Revision
} from "../core";
import { EventKind, JsonPointer, type FacetData, type SurfaceId, type TrustTier } from "../facets";
import {
    requireArray,
    requireFields,
    requireObject,
    requireOptionalFields,
    requireString
} from "./codec";
import { Event } from "./event";
import { ActionId, type EventCursor } from "./id";
import type { SurfaceEpoch } from "./surface-epoch";
import { ActionDescriptor, View, ViewMark, viewDocument } from "./view";
import { canonicalJson, readJsonPointer } from "./value";

/**
 * SPEC §6.3: the position a Surface renders one value in. Rendering as **data** is a
 * position and treatment a reasonable viewer reads as showing someone else's input — a
 * quoted or clearly labeled field. **Platform voice** is any position a viewer would
 * attribute to the platform itself: unquoted body copy, a headline, a button label
 * synthesized from the value. A value the host did not originate is admitted at the first
 * and refused at the second, and that refusal is the whole of the rendering conjunct: a
 * codec that preserved marks would still let a Surface put a marked value in a headline.
 */
export abstract class ViewPosition {
    public static get data(): ViewPosition {
        return dataPosition;
    }

    public static get platformVoice(): ViewPosition {
        return platformVoicePosition;
    }

    /** Whether a value carrying provenance may be rendered here. */
    public abstract admitsAttributed(): boolean;

    /** The wire label, which survives only inside this module's decoder. */
    public abstract get label(): string;

    public equals(other: ViewPosition): boolean {
        return this === other;
    }
}

class DataPosition extends ViewPosition {
    public override admitsAttributed(): boolean {
        return true;
    }

    public override get label(): string {
        return "data";
    }
}

class PlatformVoicePosition extends ViewPosition {
    public override admitsAttributed(): boolean {
        return false;
    }

    public override get label(): string {
        return "platformVoice";
    }
}

const dataPosition: ViewPosition = Object.freeze(new DataPosition());
const platformVoicePosition: ViewPosition = Object.freeze(new PlatformVoicePosition());

export interface DecisionPlacementInit {
    /** JSON Pointer into the rendered View body, in §6.2's pointer vocabulary. */
    readonly path: string;
    readonly position: ViewPosition;
    /**
     * JSON Pointer into the decided input, present exactly when this position renders a
     * value the host did not originate. Absent means host-authored prose, so a Surface can
     * neither claim provenance for a value it invented nor omit it for one it copied.
     */
    readonly source?: string | undefined;
}

/** One rendered position of a decision View, and where its value came from. */
export class DecisionPlacement {
    public readonly path: string;
    public readonly position: ViewPosition;
    public readonly source: string | undefined;

    public constructor(init: DecisionPlacementInit) {
        new JsonPointer(init.path);
        if (init.path.length === 0) {
            throw new TypeError("A decision placement names a position inside the View body");
        }
        if (!(init.position instanceof ViewPosition)) {
            throw new TypeError("A decision placement carries a ViewPosition");
        }
        if (init.source !== undefined) new JsonPointer(init.source);
        this.path = init.path;
        this.position = init.position;
        this.source = init.source;
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return this.source === undefined
            ? { path: this.path, position: this.position.label }
            : { path: this.path, position: this.position.label, source: this.source };
    }

    public static fromData(value: JsonValue): DecisionPlacement {
        const object = requireObject(value, "Decision placement");
        requireOptionalFields(object, ["path", "position"], ["source"], "Decision placement");
        const source = object["source"];
        return new DecisionPlacement({
            path: requireString(object["path"], "Decision placement path"),
            position: requirePosition(
                requireString(object["position"], "Decision placement position")
            ),
            source:
                source === undefined
                    ? undefined
                    : requireString(source, "Decision placement source")
        });
    }
}

export interface DecisionRenderingInit {
    readonly body: JsonValue;
    readonly actions: readonly ActionDescriptor[];
    readonly placements: readonly DecisionPlacement[];
}

/**
 * What a Surface answers when it renders a decision (SPEC §6.3). `Surface.render` returns
 * generic `FacetData`, so this is the shape that answer must decode to before any of it
 * can become a durable decision View: every rendered position is declared exactly once,
 * and the ones carrying someone else's input say which input.
 */
export class DecisionRendering {
    public readonly body: JsonValue;
    public readonly actions: readonly ActionDescriptor[];
    public readonly placements: readonly DecisionPlacement[];

    public constructor(init: DecisionRenderingInit) {
        const declared = new Set<string>();
        for (const placement of init.placements) {
            if (!(placement instanceof DecisionPlacement)) {
                throw new TypeError("A decision rendering carries DecisionPlacements");
            }
            if (declared.has(placement.path)) {
                throw new TypeError("A decision rendering declares each position once");
            }
            declared.add(placement.path);
        }
        for (const action of init.actions) {
            if (!(action instanceof ActionDescriptor)) {
                throw new TypeError("A decision rendering carries ActionDescriptors");
            }
        }
        this.body = canonicalJson(init.body);
        this.actions = Object.freeze([...init.actions]);
        this.placements = Object.freeze([...init.placements]);
        Object.freeze(this);
    }

    public static fromData(value: FacetData): DecisionRendering {
        const object = requireObject(value, "Decision rendering");
        requireFields(object, ["actions", "body", "placements"], "Decision rendering");
        const body = object["body"];
        if (body === undefined) throw new TypeError("A decision rendering carries a body");
        return new DecisionRendering({
            body,
            actions: requireArray(object["actions"], "Decision rendering actions").map((action) =>
                requireAction(action)
            ),
            placements: requireArray(object["placements"], "Decision rendering placements").map(
                (placement) => DecisionPlacement.fromData(placement)
            )
        });
    }
}

/**
 * The input one decision is about, carrying the tier the host derived for it (§6.1). The
 * tier is read off a record the host owns rather than supplied beside the value, because
 * C13-TRUST-HOST-DERIVED forbids a Facet asserting its own tier and the Surface that
 * renders the decision is exactly such a Facet.
 */
export abstract class DecidedInput {
    /** Arguments that reached this decision on one delivered Event: the Event's own tier. */
    public static delivered(event: Event, value: JsonValue): DecidedInput {
        return new DeliveredInput(event, value);
    }

    /**
     * Arguments a Turn executor assembled under its own valid lease. §6.1 assigns `self` to
     * exactly that emission and only the host may assign it, so there is no tier argument
     * here for a caller to choose.
     */
    public static emitted(value: JsonValue): DecidedInput {
        return new EmittedInput(value);
    }

    public abstract get tier(): TrustTier;
    public abstract get value(): JsonValue;
}

class DeliveredInput extends DecidedInput {
    readonly #value: JsonValue;

    public constructor(
        private readonly event: Event,
        value: JsonValue
    ) {
        super();
        if (!(event instanceof Event)) {
            throw new TypeError("A delivered decision input names the Event it arrived on");
        }
        this.#value = canonicalJson(value);
        Object.freeze(this);
    }

    public override get tier(): TrustTier {
        return this.event.trust;
    }

    public override get value(): JsonValue {
        return this.#value;
    }
}

class EmittedInput extends DecidedInput {
    readonly #value: JsonValue;

    public constructor(value: JsonValue) {
        super();
        this.#value = canonicalJson(value);
        Object.freeze(this);
    }

    public override get tier(): TrustTier {
        return "self";
    }

    public override get value(): JsonValue {
        return this.#value;
    }
}

export interface DecisionViewCompositionInit {
    readonly surface: SurfaceId;
    readonly epoch: SurfaceEpoch;
    readonly revision: Revision;
    readonly cursor: EventCursor;
    /** SPEC §7.3: the exact prepared intent this decision authorizes. */
    readonly intentDigest: Digest;
    readonly decided: DecidedInput;
    readonly rendering: DecisionRendering;
}

/**
 * SPEC §6.3: one decision View, composed rather than accepted. The marks are derived from
 * the decided input and its host-derived tier, so "every value the host did not originate
 * is marked" holds by construction rather than by a caller remembering to say so; the
 * intent digest is the prepared intent's own; and a rendering that puts an attributed
 * value in platform voice, that attributes a value the intent does not hold, that
 * attributes one it altered, that repeats the input's own text as host prose, or that
 * leaves a rendered position undeclared is refused before any of it becomes durable.
 */
export function composeDecisionView(init: DecisionViewCompositionInit): View {
    const { rendering, decided } = init;
    const marks: ViewMark[] = [];
    for (const placement of rendering.placements) {
        const rendered = requireRenderedPosition(rendering.body, placement);
        if (placement.source === undefined) {
            requireHostVoice(rendered, decided.value, placement.path);
            continue;
        }
        requireAttributedPosition(placement);
        requireRenderedInput(rendered, decided.value, placement);
        marks.push(new ViewMark(placement.path, decided.tier));
    }
    for (const action of rendering.actions) {
        requireHostVoice(action.label, decided.value, `the ${action.id.value} action label`);
    }
    requireDeclaredPositions(rendering);
    return new View({
        surface: init.surface,
        epoch: init.epoch,
        revision: init.revision,
        body: rendering.body,
        actions: rendering.actions,
        cursor: init.cursor,
        intentDigest: init.intentDigest,
        marks
    });
}

/**
 * The patch a decision View's next revision states, member by member. A ViewDelta carries
 * an RFC 6902 patch against `viewDocument`, and what a new decision replaces is exactly
 * the rendered members plus the provenance, so the patch is written from the composed
 * View's own document rather than diffed out of it.
 */
export function decisionViewPatch(composed: View, previous: View): readonly JsonValue[] {
    const document = requireObject(viewDocument(composed), "Composed decision View document");
    requireFields(document, ["actions", "body", "intentDigest", "marks"], "Decision View");
    const provenance = previous.intentDigest === undefined ? "add" : "replace";
    return Object.freeze([
        Object.freeze({ op: "replace", path: "/body", value: document["body"] }),
        Object.freeze({ op: "replace", path: "/actions", value: document["actions"] }),
        Object.freeze({ op: provenance, path: "/intentDigest", value: document["intentDigest"] }),
        Object.freeze({ op: provenance, path: "/marks", value: document["marks"] })
    ]);
}

function requireRenderedPosition(body: JsonValue, placement: DecisionPlacement): JsonValue {
    const rendered = readJsonPointer(body, placement.path);
    if (rendered === undefined) {
        throw new TypeError(
            `A decision placement names no position in the rendered body: ${placement.path}`
        );
    }
    return rendered;
}

function requireAttributedPosition(placement: DecisionPlacement): void {
    if (!placement.position.admitsAttributed()) {
        throw new TypeError(
            `A decision View renders an attributed value as data, never as platform voice: ${placement.path}`
        );
    }
}

/**
 * An attributed position renders exactly the decided input's value at the source it names.
 * A Surface that attributed one value and rendered another would produce a View whose mark
 * describes something the viewer never saw.
 */
function requireRenderedInput(
    rendered: JsonValue,
    input: JsonValue,
    placement: DecisionPlacement
): void {
    const source = readJsonPointer(input, placement.source ?? "");
    if (source === undefined) {
        throw new TypeError(
            `A decision rendering attributes a value the decided intent does not hold: ${placement.source}`
        );
    }
    if (
        !Digest.sha256(encodeCanonicalJson(canonicalJson(source))).equals(
            Digest.sha256(encodeCanonicalJson(rendered))
        )
    ) {
        throw new TypeError(
            `A decision rendering renders a value its own source does not carry: ${placement.path}`
        );
    }
}

/**
 * Host prose is refused when it repeats text the decided input carries. A Surface can
 * reach platform voice with someone else's words in exactly one other way — copy the text
 * into prose and declare that position host-authored — and this is that case. Only text is
 * checked: a number or a boolean carries no voice, and refusing one because the input held
 * the same digits would refuse an ordinary count.
 */
function requireHostVoice(rendered: JsonValue, input: JsonValue, subject: string): void {
    if (!isJsonString(rendered) || rendered.length === 0) return;
    if (inputText(input).has(rendered)) {
        throw new TypeError(
            `A decision rendering speaks the decided intent's own text in platform voice: ${subject}`
        );
    }
}

function inputText(value: JsonValue, collected: Set<string> = new Set()): Set<string> {
    if (isJsonString(value)) collected.add(value);
    else if (Array.isArray(value)) for (const entry of value) inputText(entry, collected);
    else if (isJsonObject(value)) {
        for (const entry of Object.values(value)) {
            if (entry !== undefined) inputText(entry, collected);
        }
    }
    return collected;
}

/**
 * Every rendered leaf is declared. Without this a Surface could leave a copied value at an
 * undeclared position and inherit neither a mark nor the host-voice refusal, which is the
 * hole the placement list exists to close.
 */
function requireDeclaredPositions(rendering: DecisionRendering): void {
    const declared = new Set(rendering.placements.map((placement) => placement.path));
    for (const path of renderedPositions(rendering.body)) {
        if (!declared.has(path)) {
            throw new TypeError(
                `A decision rendering leaves a rendered position undeclared: ${path}`
            );
        }
    }
}

function renderedPositions(
    value: JsonValue,
    prefix = "",
    collected: string[] = []
): readonly string[] {
    if (Array.isArray(value)) {
        for (const [index, entry] of value.entries()) {
            renderedPositions(entry, `${prefix}/${index}`, collected);
        }
        return collected;
    }
    if (isJsonObject(value)) {
        for (const [key, entry] of Object.entries(value)) {
            if (entry === undefined) continue;
            renderedPositions(
                entry,
                `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
                collected
            );
        }
        return collected;
    }
    if (prefix.length > 0) collected.push(prefix);
    return collected;
}

function requirePosition(label: string): ViewPosition {
    if (label === ViewPosition.data.label) return ViewPosition.data;
    if (label === ViewPosition.platformVoice.label) return ViewPosition.platformVoice;
    throw new TypeError(`Decision placement position is unknown: ${label}`);
}

function requireAction(value: JsonValue): ActionDescriptor {
    const object = requireObject(value, "Decision rendering action");
    requireOptionalFields(
        object,
        ["emits", "id", "label"],
        ["arguments"],
        "Decision rendering action"
    );
    const schema = object["arguments"];
    if (schema !== undefined && schema !== true && schema !== false && !isJsonObject(schema)) {
        throw new TypeError("A decision action's arguments are a JSON Schema object or boolean");
    }
    const init = {
        id: new ActionId(requireString(object["id"], "Decision action ID")),
        label: requireString(object["label"], "Decision action label"),
        emits: new EventKind(requireString(object["emits"], "Decision action Event kind"))
    };
    return new ActionDescriptor(
        schema === undefined ? init : { ...init, arguments: new JsonSchema(schema) }
    );
}
