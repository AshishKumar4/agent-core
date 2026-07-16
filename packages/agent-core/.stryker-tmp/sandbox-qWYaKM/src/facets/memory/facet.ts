// @ts-nocheck
import { ContentRef, type JsonValue } from "../../core";
import { Contributions, Contribution, OperationDescriptor } from "../contribution";
import type { FacetData } from "../data";
import {
    canonicalFacetData,
    requireArray,
    requireDataObject,
    requireSafeInteger,
    requireString
} from "../data";
import { OperationName, SlotName } from "../id";
import type { FacetManifest } from "../manifest";
import { Prompt, PromptContribution } from "../prompt";
import {
    DetailedProfileError,
    InternalProfileFacetRuntime,
    ProfileControlContract,
    ProfileOperationContract,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema
} from "../profile-runtime";

export interface MemoryAccessBackend {
    authorityForRemember(): string;
    canRead(authority: string): boolean;
    canForget(authority: string): boolean;
}

export interface MemoryIndexBackend {
    search(query: string): readonly string[];
    replace(entries: readonly MemoryEntry[], content: MemoryContentBackend): MemoryIndexBackend;
}

export interface MemoryContentBackend {
    resolve(content: ContentRef): JsonValue;
}

export interface RememberInput extends PublicProfileInput {
    readonly id: string;
    readonly content: ContentRef;
    readonly createdAt: number;
    readonly retainUntil?: number;
}

export interface RecallInput extends PublicProfileInput {
    readonly query: string;
    readonly limit?: number;
}

export interface ForgetInput extends PublicProfileInput {
    readonly id: string;
}

export interface MemoryPromptInput extends PublicProfileInput {
    readonly query: string;
    readonly limit?: number;
}

export interface MemoryPromptBounds {
    readonly maximumEntries: number;
    readonly maximumCharacters: number;
    readonly priority: number;
}

export class MemoryEntry {
    public constructor(
        public readonly id: string,
        public readonly content: ContentRef,
        public readonly authority: string,
        public readonly createdAt: number,
        public readonly retainUntil?: number
    ) {
        if (id.trim().length === 0 || id !== id.trim())
            throw new TypeError("Memory ID must be canonical");
        if (authority.trim().length === 0) throw new TypeError("Memory authority must be nonblank");
        if (!Number.isSafeInteger(createdAt) || createdAt < 0)
            throw new TypeError("Memory creation time is invalid");
        if (
            retainUntil !== undefined &&
            (!Number.isSafeInteger(retainUntil) || retainUntil < createdAt)
        ) {
            throw new TypeError("Memory retention must not predate creation");
        }
        Object.freeze(this);
    }
}

const idProperty = { type: "string", minLength: 1 } as const;
const contentRefProperty = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const;
const timeProperty = { type: "integer", minimum: 0 } as const;
const entrySchema = schema({
    type: "object",
    properties: {
        id: idProperty,
        content: contentRefProperty,
        authority: idProperty,
        createdAt: timeProperty,
        retainUntil: timeProperty
    },
    required: ["id", "content", "authority", "createdAt"],
    additionalProperties: false
});
const entryCodec = profileWireCodec<MemoryEntry>(
    (entry) => ({
        id: entry.id,
        content: entry.content.value,
        authority: entry.authority,
        createdAt: entry.createdAt,
        ...(entry.retainUntil === undefined ? {} : { retainUntil: entry.retainUntil })
    }),
    decodeMemoryEntry
);

export const MEMORY_OPERATION_CONTRACTS = Object.freeze({
    remember: new ProfileOperationContract<"remember", RememberInput, MemoryEntry>(
        "remember",
        new OperationDescriptor(
            new OperationName("remember"),
            "mutate",
            strictObjectSchema(
                {
                    id: idProperty,
                    content: contentRefProperty,
                    createdAt: timeProperty,
                    retainUntil: timeProperty
                },
                ["id", "content", "createdAt"]
            ),
            entrySchema
        ),
        profileWireCodec(
            (input) => ({
                id: input.id,
                content: input.content.value,
                createdAt: input.createdAt,
                ...(input.retainUntil === undefined ? {} : { retainUntil: input.retainUntil })
            }),
            (data) => {
                const object = requireDataObject(data, "Remember input");
                return {
                    id: requireString(object["id"], "Memory ID"),
                    content: new ContentRef(requireString(object["content"], "Memory content")),
                    createdAt: requireSafeInteger(object["createdAt"], "Memory created time"),
                    ...(object["retainUntil"] === undefined
                        ? {}
                        : {
                              retainUntil: requireSafeInteger(
                                  object["retainUntil"],
                                  "Memory retention"
                              )
                          })
                };
            }
        ),
        entryCodec,
        "output"
    ),
    recall: new ProfileOperationContract<"recall", RecallInput, readonly MemoryEntry[]>(
        "recall",
        new OperationDescriptor(
            new OperationName("recall"),
            "observe",
            strictObjectSchema(
                { query: { type: "string" }, limit: { type: "integer", minimum: 0 } },
                ["query"]
            ),
            schema({ type: "array", items: entrySchema.document })
        ),
        recallInputCodec(),
        profileWireCodec(
            (entries) => entries.map((entry) => entryCodec.encode(entry)),
            (data) =>
                Object.freeze(requireArray(data, "Memory recall output").map(decodeMemoryEntry))
        ),
        "output"
    ),
    forget: new ProfileOperationContract<"forget", ForgetInput, boolean>(
        "forget",
        new OperationDescriptor(
            new OperationName("forget"),
            "mutate",
            strictObjectSchema({ id: idProperty }, ["id"]),
            schema({ type: "boolean" })
        ),
        profileWireCodec(
            (input) => ({ id: input.id }),
            (data) => ({
                id: requireString(requireDataObject(data, "Forget input")["id"], "Memory ID")
            })
        ),
        profileWireCodec(
            (value) => value,
            (data) => data === true
        ),
        "output"
    )
});

export const MEMORY_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(MEMORY_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);
export const MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR = new PromptContribution([
    new Prompt(
        "Relevant memory",
        "Materialize only bounded memory content readable through the protected recall Operation.",
        0
    )
]);
export const MEMORY_PROMPT_CONTROL = new ProfileControlContract<
    "memory.prompt",
    MemoryPromptInput,
    PromptContribution
>(
    "memory.prompt",
    strictObjectSchema({ query: { type: "string" }, limit: { type: "integer", minimum: 0 } }, [
        "query"
    ]),
    schema({
        type: "array",
        items: {
            type: "object",
            properties: {
                title: { type: "string", minLength: 1 },
                body: { type: "string", minLength: 1 },
                priority: { type: "integer" }
            },
            required: ["title", "body", "priority"],
            additionalProperties: false
        }
    }),
    recallInputCodec(),
    profileWireCodec(
        (contribution) => contribution.toData(),
        (data) =>
            new PromptContribution(
                requireArray(data, "Memory prompt contribution").map(Prompt.fromData)
            )
    )
);
export const MEMORY_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        MEMORY_OPERATIONS.map((operation) => operation.toData())
    ),
    new Contribution(new SlotName("prompt"), [MEMORY_PROMPT_CONTRIBUTION_DESCRIPTOR.toData()])
]);

export class MemoryBackend {
    #entries: ReadonlyMap<string, MemoryEntry> = new Map();
    #index: MemoryIndexBackend;

    public constructor(
        index: MemoryIndexBackend,
        private readonly access: MemoryAccessBackend,
        private readonly content: MemoryContentBackend
    ) {
        this.#index = index;
    }

    public remember(input: RememberInput): MemoryEntry {
        if (this.#entries.has(input.id)) {
            throw new MemoryError("memory.exists", "Memory ID already exists");
        }
        const entry = new MemoryEntry(
            input.id,
            input.content,
            this.access.authorityForRemember(),
            input.createdAt,
            input.retainUntil
        );
        const candidate = new Map(this.#entries).set(entry.id, entry);
        this.commit(candidate);
        return entry;
    }

    public recall(input: RecallInput): readonly MemoryEntry[] {
        const limit = input.limit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new MemoryError(
                "memory.limit",
                "Recall limit must be a non-negative safe integer"
            );
        }
        if (limit === 0) return Object.freeze([]);
        const visible: MemoryEntry[] = [];
        for (const id of this.#index.search(input.query)) {
            const entry = this.#entries.get(id);
            if (entry !== undefined && this.access.canRead(entry.authority)) visible.push(entry);
            if (visible.length === limit) break;
        }
        return Object.freeze(visible);
    }

    public forget(input: ForgetInput): boolean {
        const entry = this.#entries.get(input.id);
        if (entry === undefined || !this.access.canForget(entry.authority)) return false;
        const candidate = new Map(this.#entries);
        candidate.delete(input.id);
        this.commit(candidate);
        return true;
    }

    public prune(now: number): readonly string[] {
        if (!Number.isSafeInteger(now) || now < 0) {
            throw new MemoryError("memory.time", "Prune time is invalid");
        }
        const candidate = new Map(this.#entries);
        const removed: string[] = [];
        for (const entry of this.#entries.values()) {
            if (entry.retainUntil !== undefined && entry.retainUntil <= now) {
                candidate.delete(entry.id);
                removed.push(entry.id);
            }
        }
        if (removed.length > 0) this.commit(candidate);
        return Object.freeze(removed.sort());
    }

    public rebuildIndex(): void {
        this.#index = this.#index.replace(Object.freeze([...this.#entries.values()]), this.content);
    }

    public resolve(entry: MemoryEntry): JsonValue {
        return canonicalFacetData(this.content.resolve(entry.content));
    }

    private commit(candidate: ReadonlyMap<string, MemoryEntry>): void {
        const replacement = this.#index.replace(
            Object.freeze([...candidate.values()]),
            this.content
        );
        this.#entries = candidate;
        this.#index = replacement;
    }
}

export class MemoryFacet<Receipt> {
    public static readonly operations = MEMORY_OPERATIONS;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: MemoryBackend,
        private readonly promptBounds: MemoryPromptBounds
    ) {
        if (
            !Number.isSafeInteger(promptBounds.maximumEntries) ||
            promptBounds.maximumEntries < 0 ||
            !Number.isSafeInteger(promptBounds.maximumCharacters) ||
            promptBounds.maximumCharacters < 0 ||
            !Number.isSafeInteger(promptBounds.priority)
        ) {
            throw new TypeError("Memory prompt bounds and priority must be safe integers");
        }
    }

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(MEMORY_OPERATION_CONTRACTS.remember, (input) =>
                    this.backend.remember(input)
                ),
                this.runtime.operation(MEMORY_OPERATION_CONTRACTS.recall, (input) =>
                    this.backend.recall(input)
                ),
                this.runtime.operation(MEMORY_OPERATION_CONTRACTS.forget, (input) =>
                    this.backend.forget(input)
                )
            ]
        });
    }

    public remember(input: RememberInput): Promise<MemoryEntry> {
        return this.runtime.invoke(MEMORY_OPERATION_CONTRACTS.remember, input, (admitted) =>
            this.backend.remember(admitted)
        );
    }

    public recall(input: RecallInput): Promise<readonly MemoryEntry[]> {
        return this.runtime.invoke(MEMORY_OPERATION_CONTRACTS.recall, input, (admitted) =>
            this.backend.recall(admitted)
        );
    }

    public forget(input: ForgetInput): Promise<boolean> {
        return this.runtime.invoke(MEMORY_OPERATION_CONTRACTS.forget, input, (admitted) =>
            this.backend.forget(admitted)
        );
    }

    public prompt(input: MemoryPromptInput): Promise<PromptContribution> {
        return this.runtime.control(MEMORY_PROMPT_CONTROL, input, (admitted) => {
            const requested = Math.min(
                admitted.limit ?? this.promptBounds.maximumEntries,
                this.promptBounds.maximumEntries
            );
            const entries = this.backend.recall({ query: admitted.query, limit: requested });
            let remaining = this.promptBounds.maximumCharacters;
            const sections: Prompt[] = [];
            for (const entry of entries) {
                const body = JSON.stringify(this.backend.resolve(entry));
                if (body.length > remaining) break;
                sections.push(new Prompt(`Memory ${entry.id}`, body, this.promptBounds.priority));
                remaining -= body.length;
            }
            return new PromptContribution(sections);
        });
    }
}

export class InMemoryMemoryIndexBackend implements MemoryIndexBackend {
    readonly #terms: ReadonlyMap<string, ReadonlySet<string>>;
    readonly #all: ReadonlySet<string>;

    public constructor(
        terms: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
        all: ReadonlySet<string> = new Set()
    ) {
        this.#terms = new Map([...terms].map(([term, ids]) => [term, new Set(ids)]));
        this.#all = new Set(all);
    }

    public search(query: string): readonly string[] {
        const terms = tokenize(query);
        const ids =
            terms.length === 0
                ? [...this.#all]
                : [...(this.#terms.get(terms[0]!) ?? [])].filter((id) =>
                      terms.every((term) => this.#terms.get(term)?.has(id) === true)
                  );
        return Object.freeze(ids.sort());
    }

    public replace(
        entries: readonly MemoryEntry[],
        content: MemoryContentBackend
    ): MemoryIndexBackend {
        const terms = new Map<string, Set<string>>();
        const all = new Set<string>();
        for (const entry of entries) {
            all.add(entry.id);
            for (const term of tokenize(JSON.stringify(content.resolve(entry.content)))) {
                const ids = terms.get(term) ?? new Set<string>();
                ids.add(entry.id);
                terms.set(term, ids);
            }
        }
        return new InMemoryMemoryIndexBackend(terms, all);
    }
}

export type MemoryErrorCode = "memory.exists" | "memory.limit" | "memory.time";

export class MemoryError extends DetailedProfileError<MemoryErrorCode> {
    public constructor(detailCode: MemoryErrorCode, message: string) {
        super("operation.invalid-input", detailCode, message);
        this.name = "MemoryError";
    }
}

function tokenize(value: string): string[] {
    return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function recallInputCodec() {
    return profileWireCodec<RecallInput | MemoryPromptInput>(
        (input) => ({
            query: input.query,
            ...(input.limit === undefined ? {} : { limit: input.limit })
        }),
        (data) => {
            const object = requireDataObject(data, "Memory query input");
            return {
                query: requireString(object["query"], "Memory query"),
                ...(object["limit"] === undefined
                    ? {}
                    : {
                          limit: requireSafeInteger(object["limit"], "Memory query limit")
                      })
            };
        }
    );
}

function decodeMemoryEntry(data: FacetData): MemoryEntry {
    const object = requireDataObject(data, "Memory entry");
    return new MemoryEntry(
        requireString(object["id"], "Memory ID"),
        new ContentRef(requireString(object["content"], "Memory content")),
        requireString(object["authority"], "Memory authority"),
        requireSafeInteger(object["createdAt"], "Memory created time"),
        object["retainUntil"] === undefined
            ? undefined
            : requireSafeInteger(object["retainUntil"], "Memory retention")
    );
}
