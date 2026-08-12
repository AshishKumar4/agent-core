import { ContentRef, isMember, type JsonValue } from "../core";
import type { FacetData } from "./data";
import { compareText, requireDataObject, requireExactFields, requireString } from "./data";
import { AuthoredCodeBackingId } from "./id";

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

/**
 * Which backing serves which §4.7 consumer, as `policies.placement` declares it
 * (§9.2). The mapping is partial on purpose: a consumer the Blueprint does not name
 * uses the substrate profile's declared default backing rather than an arbitrary one.
 * Backings differ operationally and never in authority, so this record is a hosting
 * choice and carries no capability.
 */
export class AuthoredCodeBackingPolicy {
    readonly #backings: ReadonlyMap<AuthoredCodeConsumer, AuthoredCodeBackingId>;

    public constructor(backings: ReadonlyMap<AuthoredCodeConsumer, AuthoredCodeBackingId>) {
        this.#backings = new Map(
            [...backings]
                .map(([consumer, backing]) => {
                    if (!isMember(AUTHORED_CODE_CONSUMERS, consumer)) {
                        throw new TypeError(
                            "Agent-authored code backing policy names an unknown consumer"
                        );
                    }
                    if (!(backing instanceof AuthoredCodeBackingId)) {
                        throw new TypeError(
                            "Agent-authored code backing policy requires backing identifiers"
                        );
                    }
                    return [consumer, backing] as const;
                })
                .sort(([left], [right]) => compareText(left, right))
        );
        Object.freeze(this);
    }

    public static get unmapped(): AuthoredCodeBackingPolicy {
        return unmappedBackingPolicy;
    }

    public static fromData(payload: JsonValue | undefined): AuthoredCodeBackingPolicy {
        if (payload === undefined) return unmappedBackingPolicy;
        const object = requireDataObject(payload, "Agent-authored code backing policy");
        return new AuthoredCodeBackingPolicy(
            new Map(
                Object.entries(object).map(([consumer, backing]) => [
                    requireAuthoredCodeConsumer(consumer, "Agent-authored code backing consumer"),
                    new AuthoredCodeBackingId(
                        requireString(backing, `Agent-authored code backing for ${consumer}`)
                    )
                ])
            )
        );
    }

    /**
     * The backing that serves `consumer`: the declared mapping when the Blueprint names
     * one, and otherwise the profile's declared default. There is no third outcome —
     * an unmapped consumer never reaches an arbitrary offered backing.
     */
    public backingFor(
        consumer: AuthoredCodeConsumer,
        profileDefault: AuthoredCodeBackingId
    ): AuthoredCodeBackingId {
        return this.#backings.get(consumer) ?? profileDefault;
    }

    public get isEmpty(): boolean {
        return this.#backings.size === 0;
    }

    public get consumers(): readonly AuthoredCodeConsumer[] {
        return Object.freeze([...this.#backings.keys()]);
    }

    public toData(): JsonValue {
        return Object.fromEntries(
            [...this.#backings].map(([consumer, backing]) => [consumer, backing.value] as const)
        );
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

const unmappedBackingPolicy = new AuthoredCodeBackingPolicy(new Map());
