import { RecordCodec, type JsonValue, TextId } from "../core";
import { requireIdentityFields, requireIdentityObject, requireIdentityString } from "./codec";
import { PrincipalId, TenantId } from "./id";

class PrincipalRefCodec extends RecordCodec<PrincipalRef> {
    public constructor() {
        super([PrincipalRef, TextId, TenantId, PrincipalId], "identity.principal-ref", {
            major: 1,
            minor: 0
        });
    }

    protected encodePayload(reference: PrincipalRef): JsonValue {
        return {
            principal: reference.principalId.value,
            tenant: reference.tenantId.value
        };
    }

    protected decodePayload(payload: JsonValue): PrincipalRef {
        const object = requireIdentityObject(payload, "Principal reference");
        requireIdentityFields(object, ["principal", "tenant"], "Principal reference");
        return new PrincipalRef(
            new TenantId(requireIdentityString(object["tenant"], "Principal Tenant")),
            new PrincipalId(requireIdentityString(object["principal"], "Principal ID"))
        );
    }
}

export class PrincipalRef {
    public static get codec(): RecordCodec<PrincipalRef> {
        return principalRefCodecInstance;
    }

    public constructor(
        public readonly tenantId: TenantId,
        public readonly principalId: PrincipalId
    ) {
        Object.freeze(this);
    }

    public static encode(reference: PrincipalRef): Uint8Array {
        return PrincipalRef.codec.encode(reference);
    }

    public static decode(bytes: Uint8Array): PrincipalRef {
        return PrincipalRef.codec.decode(bytes);
    }

    public equals(other: PrincipalRef): boolean {
        return this.tenantId.equals(other.tenantId) && this.principalId.equals(other.principalId);
    }
}

const principalRefCodecInstance = new PrincipalRefCodec();
