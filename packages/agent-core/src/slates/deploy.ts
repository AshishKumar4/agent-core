import type { Revision } from "../record";
import type { SlateDeploymentId, SlateId, SlateVersionId } from "./id";

const MIN_SLATE_DEPLOYMENT_TARGET_LENGTH = 1;
const MAX_SLATE_DEPLOYMENT_TARGET_LENGTH = 512;

export type SlateDeploymentStatus = "pending" | "active" | "failed" | "retired";

export class SlateDeploymentTarget {
    readonly #value: string;

    public constructor(value: string) {
        if (
            value.length < MIN_SLATE_DEPLOYMENT_TARGET_LENGTH
            || value.length > MAX_SLATE_DEPLOYMENT_TARGET_LENGTH
        ) {
            throw new TypeError("Slate deployment target must contain between 1 and 512 characters");
        }

        this.#value = value;
    }

    public get value(): string {
        return this.#value;
    }

    public equals(other: SlateDeploymentTarget): boolean {
        return this.#value === other.#value;
    }

    public toString(): string {
        return this.#value;
    }
}

export class SlateDeployment {
    public constructor(
        public readonly id: SlateDeploymentId,
        public readonly slateId: SlateId,
        public readonly versionId: SlateVersionId,
        public readonly target: SlateDeploymentTarget,
        public readonly status: SlateDeploymentStatus,
        public readonly revision: Revision
    ) {
    }

    public activate(): SlateDeployment {
        return new SlateDeployment(
            this.id,
            this.slateId,
            this.versionId,
            this.target,
            "active",
            this.revision.next()
        );
    }

    public fail(): SlateDeployment {
        return new SlateDeployment(
            this.id,
            this.slateId,
            this.versionId,
            this.target,
            "failed",
            this.revision.next()
        );
    }

    public retire(): SlateDeployment {
        return new SlateDeployment(
            this.id,
            this.slateId,
            this.versionId,
            this.target,
            "retired",
            this.revision.next()
        );
    }
}
