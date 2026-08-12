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
        if (name.trim().length === 0 || name !== name.trim()) {
            throw new TypeError("Agent-authored code module names must be nonblank and canonical");
        }
        if (!(ref instanceof ContentRef)) {
            throw new TypeError("Agent-authored code modules must be content-addressed");
        }
        canonical.set(name, ref);
    }
    return canonical;
}
