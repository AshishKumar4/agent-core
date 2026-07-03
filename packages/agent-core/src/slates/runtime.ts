import { AgentCoreError } from "../errors";
import type { OperationContext } from "../operations";
import type { View, ViewRequest } from "../facets";
import type { SlateVersionId } from "./id";
import type { Slate } from "./slate";
import type { SlateVersion } from "./version";

export interface SlateVersionStore {
    get(id: SlateVersionId): Promise<SlateVersion | undefined>;
    put(version: SlateVersion): Promise<SlateVersion>;
}

export class MemorySlateVersionStore implements SlateVersionStore {
    readonly #versions = new Map<string, SlateVersion>();

    public constructor(versions: readonly SlateVersion[] = []) {
        for (const version of versions) {
            this.#versions.set(version.id.value, version);
        }
    }

    public async get(id: SlateVersionId): Promise<SlateVersion | undefined> {
        return this.#versions.get(id.value);
    }

    public async put(version: SlateVersion): Promise<SlateVersion> {
        this.#versions.set(version.id.value, version);
        return version;
    }
}

export class SlateRuntime {
    public constructor(
        public readonly slate: Slate,
        private readonly versions: SlateVersionStore
    ) {
    }

    public async activeVersion(): Promise<SlateVersion> {
        const versionId = this.slate.activeVersionId;
        if (versionId === undefined) {
            throw new AgentCoreError("slate.unpublished", "Slate has no active version");
        }

        const version = await this.versions.get(versionId);
        if (version === undefined || !version.slateId.equals(this.slate.id)) {
            throw new AgentCoreError("slate.invalid-version", "Slate active version is missing or belongs to another Slate");
        }

        return version;
    }

    public async render(context: OperationContext, request: ViewRequest): Promise<View> {
        const version = await this.activeVersion();
        return await version.application.surface.render(context, request);
    }
}
