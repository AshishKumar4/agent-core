import { Digest, TextId, encodeCanonicalJson, type JsonValue } from "../core";
import type { TenantId } from "../identity";

export { PackageId } from "../definition-references";

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
        if (value.length === 0 || value !== value.trim()) {
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

/**
 * SPEC §4.1: the identity of one typed failed install. The digest covers exactly the
 * record's declared fields, so a decoded failure proves its own identity and two hosts
 * that record the same failure of the same contribution against the same Scope write one
 * row rather than two.
 */
export class FacetInstallFailureId extends TextId {
    public constructor(value: string) {
        super(value, "Facet install failure ID");
        if (!FACET_INSTALL_FAILURE_ID.test(value)) {
            throw new TypeError("Facet install failure ID must be a prefixed SHA-256 digest");
        }
        Object.freeze(this);
    }

    public static derive(declaredFields: JsonValue): FacetInstallFailureId {
        return new FacetInstallFailureId(
            `${FACET_INSTALL_FAILURE_PREFIX}${Digest.sha256(encodeCanonicalJson(declaredFields)).value}`
        );
    }
}

const FACET_INSTALL_FAILURE_PREFIX = "facet-install-failure:";
const FACET_INSTALL_FAILURE_ID = new RegExp(`^${FACET_INSTALL_FAILURE_PREFIX}[a-f0-9]{64}$`, "u");
