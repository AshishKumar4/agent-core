import { ContentRef, isMember, type JsonValue } from "../core";
import type { FacetData } from "./data";
import { compareText, requireDataObject, requireExactFields, requireString } from "./data";

/**
 * The three consumers of the one §4.7 runtime shape. The set is closed: membership in
 * it is what marks code as agent-authored, so nothing else needs a runtime flag saying
 * so. The three differ in lifetime and in nothing else — a programmatic tool call's
 * isolate is gone when the submission ends, a Slate backend's outlives its deployment,
 * an agent-authored Facet's outlives every install that references it.
 */
export type AuthoredCodeConsumer = "programmaticToolCall" | "slateBackend" | "agentAuthoredFacet";

export const AUTHORED_CODE_CONSUMERS: readonly AuthoredCodeConsumer[] = Object.freeze([
    "programmaticToolCall",
    "slateBackend",
    "agentAuthoredFacet"
]);

export function requireAuthoredCodeConsumer(
    value: JsonValue | undefined,
    subject: string
): AuthoredCodeConsumer {
    if (!isMember(AUTHORED_CODE_CONSUMERS, value)) {
        throw new TypeError(`${subject} must name a §4.7 agent-authored code consumer`);
    }
    return value;
}

/**
 * Which caller an Operation is declared for (SPEC §4.7): `native` offers it to the model
 * as a tool call, `code` to agent-authored code, `both` to either. Availability belongs to
 * the composition rather than to a submission, so the catalog §5.6 reconstructs and the
 * passed Binding set an isolate enforces read this one declaration instead of two a host
 * keeps in agreement.
 *
 * The three cases are singletons and equality is identity, so nothing can mint a fourth
 * availability or hold two unequal copies of one meaning.
 */
export abstract class OperationAvailability {
    public static get native(): OperationAvailability {
        return nativeAvailability;
    }
    public static get code(): OperationAvailability {
        return codeAvailability;
    }
    public static get both(): OperationAvailability {
        return bothAvailability;
    }

    /**
     * An absent declaration reads as `native` (SPEC §4.7), so an author who never
     * considered code mode offers it nothing.
     */
    public static fromData(value: FacetData | undefined): OperationAvailability {
        if (value === undefined) {
            return nativeAvailability;
        }
        const declared = OPERATION_AVAILABILITIES.find((candidate) => candidate.label === value);
        if (declared === undefined) {
            throw new TypeError("Operation availability must be native, code, or both");
        }
        return declared;
    }

    /** The wire label this availability declares itself with. */
    public abstract readonly label: "native" | "code" | "both";

    /** May an isolate's passed Binding set name this Operation? */
    public abstract get reachableByAuthoredCode(): boolean;

    /** Is it offered to the model as a tool call? */
    public abstract get offeredToModel(): boolean;

    /**
     * SPEC §4.1's presence rule: `native` is already what an absent declaration means, so
     * its canonical wire form is the absent key. Writing the label too would give one
     * meaning two `manifestDigest` values (§5.2) for the same Operation.
     */
    public toData(): FacetData | undefined {
        return this.equals(nativeAvailability) ? undefined : this.label;
    }

    public equals(other: OperationAvailability): boolean {
        return this === other;
    }
}

class NativeAvailability extends OperationAvailability {
    public readonly label = "native";
    public get reachableByAuthoredCode(): boolean {
        return false;
    }
    public get offeredToModel(): boolean {
        return true;
    }
}

class CodeAvailability extends OperationAvailability {
    public readonly label = "code";
    public get reachableByAuthoredCode(): boolean {
        return true;
    }
    public get offeredToModel(): boolean {
        return false;
    }
}

class BothAvailability extends OperationAvailability {
    public readonly label = "both";
    public get reachableByAuthoredCode(): boolean {
        return true;
    }
    public get offeredToModel(): boolean {
        return true;
    }
}

const nativeAvailability = Object.freeze(new NativeAvailability());
const codeAvailability = Object.freeze(new CodeAvailability());
const bothAvailability = Object.freeze(new BothAvailability());

const OPERATION_AVAILABILITIES: readonly OperationAvailability[] = Object.freeze([
    nativeAvailability,
    codeAvailability,
    bothAvailability
]);

/**
 * Agent-authored code as the submission carries it: content-addressed modules and the
 * one they enter through. Nothing here says where the code will run — that is the
 * backing's business (§10.2) — and nothing here carries authority, because a §4.7
 * isolate holds only what is separately passed to it as Bindings.
 */
export class AuthoredCodeSource {
    public readonly modules: ReadonlyMap<string, ContentRef>;

    public constructor(
        public readonly entry: string,
        modules: ReadonlyMap<string, ContentRef>
    ) {
        this.modules = canonicalModules(modules);
        if (!this.modules.has(entry)) {
            throw new TypeError("Agent-authored code entry must name one of its own modules");
        }
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): AuthoredCodeSource {
        const object = requireDataObject(payload, "Agent-authored code source");
        requireExactFields(object, ["entry", "modules"]);
        const modules = requireDataObject(object["modules"], "Agent-authored code modules");
        return new AuthoredCodeSource(
            requireString(object["entry"], "Agent-authored code entry"),
            new Map(
                Object.entries(modules).map(([name, ref]) => [
                    name,
                    new ContentRef(requireString(ref, `Agent-authored code module ${name}`))
                ])
            )
        );
    }

    public toData(): FacetData {
        return {
            entry: this.entry,
            modules: Object.fromEntries(
                [...this.modules].map(([name, ref]) => [name, ref.value] as const)
            )
        };
    }
}

function canonicalModules(
    modules: ReadonlyMap<string, ContentRef>
): ReadonlyMap<string, ContentRef> {
    if (modules.size === 0) {
        throw new TypeError("Agent-authored code must carry at least one module");
    }
    const canonical = new Map<string, ContentRef>();
    for (const [name, ref] of [...modules].sort(([left], [right]) => compareText(left, right))) {
        if (name.length === 0 || name !== name.trim()) {
            throw new TypeError("Agent-authored code module names must be nonblank and canonical");
        }
        if (!(ref instanceof ContentRef)) {
            throw new TypeError("Agent-authored code modules must be content-addressed");
        }
        canonical.set(name, ref);
    }
    return canonical;
}
