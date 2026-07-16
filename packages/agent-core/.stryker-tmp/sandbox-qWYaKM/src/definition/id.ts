// @ts-nocheck
import { Digest, TextId, encodeCanonicalJson } from "../core";
import type { TenantId } from "../identity";

export class PackageId extends TextId {
    public constructor(value: string) {
        super(value, "Package ID");
        if (value.trim().length === 0 || value !== value.trim()) {
            throw new TypeError("Package ID must be a nonblank canonical string");
        }
        Object.freeze(this);
    }
}

export class MaterializationGenerationId extends TextId {
    public constructor(value: string) {
        super(value, "Materialization generation ID");
        if (!/^[a-f0-9]{64}$/.test(value)) {
            throw new TypeError("Materialization generation ID must be a SHA-256 digest");
        }
        Object.freeze(this);
    }
}

export class DeploymentKey extends TextId {
    public constructor(value: string) {
        super(value, "Deployment key");
        if (value.trim().length === 0 || value !== value.trim()) {
            throw new TypeError("Deployment key must be a nonblank canonical string");
        }
        Object.freeze(this);
    }
}

export class DeploymentId extends TextId {
    public constructor(value: string) {
        super(value, "Deployment ID");
        if (!/^[a-f0-9]{64}$/.test(value)) {
            throw new TypeError("Deployment ID must be a SHA-256 digest");
        }
        Object.freeze(this);
    }

    public static derive(tenant: TenantId, key: DeploymentKey): DeploymentId {
        return new DeploymentId(
            Digest.sha256(
                encodeCanonicalJson({
                    domain: "agent-core.deployment.v1",
                    key: key.value,
                    tenant: tenant.value
                })
            ).value
        );
    }
}
