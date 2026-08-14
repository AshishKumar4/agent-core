import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermit,
    TargetAuthorityPermitRequest,
    BindingValidationEvidence,
    BindingValidationRequest
} from "../authority";
import { jsonDataParser, RecordCodec, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import type { CommandPayloadCodec } from "./payload";

const parseReply = jsonDataParser(
    () => new AgentCoreError("codec.invalid", "Authority protocol reply is malformed")
);
const parseRequest = jsonDataParser(
    () => new AgentCoreError("codec.invalid", "Authority protocol payload is malformed")
);
class AuthorityCheckReplyCodec extends RecordCodec<AuthorityCheckReply> {
    public constructor() {
        super("protocol.authority-check-reply", { major: 1, minor: 0 });
    }
    protected encodePayload(reply: AuthorityCheckReply): JsonValue {
        return { evidence: reply.evidence.toData() };
    }
    protected decodePayload(payload: JsonValue): AuthorityCheckReply {
        return new AuthorityCheckReply(
            AuthorityCheckEvidence.fromData(singleField(payload, "evidence"))
        );
    }
}

class BindingValidationReplyCodec extends RecordCodec<BindingValidationReply> {
    public constructor() {
        super("protocol.binding-validation-reply", { major: 1, minor: 0 });
    }
    protected encodePayload(reply: BindingValidationReply): JsonValue {
        return { evidence: reply.evidence.toData() };
    }
    protected decodePayload(payload: JsonValue): BindingValidationReply {
        return new BindingValidationReply(
            BindingValidationEvidence.fromData(singleField(payload, "evidence"))
        );
    }
}

class AuthorityPermitIssuanceRequestCodec extends RecordCodec<AuthorityPermitIssuanceRequest> {
    public constructor() {
        super("protocol.authority-permit-issuance-request", { major: 2, minor: 0 });
    }

    protected encodePayload(request: AuthorityPermitIssuanceRequest): JsonValue {
        return {
            request: request.targetRequest.toData()
        };
    }

    protected decodePayload(payload: JsonValue): AuthorityPermitIssuanceRequest {
        const object = parseRequest.exact(
            parseRequest.object(payload, "Authority protocol payload"),
            ["request"],
            "Authority protocol payload"
        );
        return new AuthorityPermitIssuanceRequest(
            TargetAuthorityPermitRequest.fromData(object["request"])
        );
    }
}

class AuthorityPermitIssuanceReplyCodec extends RecordCodec<AuthorityPermitIssuanceReply> {
    public constructor() {
        super("protocol.authority-permit-issuance-reply", { major: 2, minor: 0 });
    }

    protected encodePayload(reply: AuthorityPermitIssuanceReply): JsonValue {
        return {
            evidence: reply.evidence.toData(),
            kind: reply.kind,
            permit: reply.kind === "issued" ? reply.requirePermit().toData() : null
        };
    }

    protected decodePayload(payload: JsonValue): AuthorityPermitIssuanceReply {
        const object = parseReply.exact(
            parseReply.object(payload, "Authority permit issuance reply"),
            ["evidence", "kind", "permit"],
            "Authority permit issuance reply"
        );
        const evidence = AuthorityCheckEvidence.fromData(object["evidence"]);
        if (object["kind"] === "denied" && object["permit"] === null) {
            return AuthorityPermitIssuanceReply.denied(evidence);
        }
        if (object["kind"] === "issued" && object["permit"] !== null) {
            return AuthorityPermitIssuanceReply.issued(
                evidence,
                AuthorityPermit.fromData(object["permit"])
            );
        }
        throw new AgentCoreError("codec.invalid", "Authority permit issuance reply is malformed");
    }
}

export class AuthorityCheckReply {
    public static readonly codec: RecordCodec<AuthorityCheckReply> = new AuthorityCheckReplyCodec();
    public constructor(public readonly evidence: AuthorityCheckEvidence) {
        Object.freeze(this);
    }
    public static encode(reply: AuthorityCheckReply): Uint8Array {
        return AuthorityCheckReply.codec.encode(reply);
    }
    public static decode(bytes: Uint8Array): AuthorityCheckReply {
        return AuthorityCheckReply.codec.decode(bytes);
    }
}

export class BindingValidationReply {
    public static readonly codec: RecordCodec<BindingValidationReply> =
        new BindingValidationReplyCodec();
    public constructor(public readonly evidence: BindingValidationEvidence) {
        Object.freeze(this);
    }
    public static encode(reply: BindingValidationReply): Uint8Array {
        return BindingValidationReply.codec.encode(reply);
    }
    public static decode(bytes: Uint8Array): BindingValidationReply {
        return BindingValidationReply.codec.decode(bytes);
    }
}

export class AuthorityPermitIssuanceRequest {
    public static readonly codec: RecordCodec<AuthorityPermitIssuanceRequest> =
        new AuthorityPermitIssuanceRequestCodec();
    public constructor(public readonly targetRequest: TargetAuthorityPermitRequest) {
        Object.freeze(this);
    }

    public static encode(request: AuthorityPermitIssuanceRequest): Uint8Array {
        return AuthorityPermitIssuanceRequest.codec.encode(request);
    }

    public static decode(bytes: Uint8Array): AuthorityPermitIssuanceRequest {
        return AuthorityPermitIssuanceRequest.codec.decode(bytes);
    }
}

export class AuthorityPermitIssuanceReply {
    public static readonly codec: RecordCodec<AuthorityPermitIssuanceReply> =
        new AuthorityPermitIssuanceReplyCodec();

    private constructor(
        public readonly kind: "issued" | "denied",
        public readonly evidence: AuthorityCheckEvidence,
        public readonly permit: AuthorityPermit | undefined
    ) {
        if (
            (kind === "issued") !== (permit !== undefined) ||
            (kind === "issued") !== evidence.allowed
        ) {
            throw new TypeError("Authority permit issuance reply does not match its decision");
        }
        Object.freeze(this);
    }

    public static issued(
        evidence: AuthorityCheckEvidence,
        permit: AuthorityPermit
    ): AuthorityPermitIssuanceReply {
        return new AuthorityPermitIssuanceReply("issued", evidence, permit);
    }

    public static denied(evidence: AuthorityCheckEvidence): AuthorityPermitIssuanceReply {
        return new AuthorityPermitIssuanceReply("denied", evidence, undefined);
    }

    public requirePermit(): AuthorityPermit {
        if (this.permit === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Denied authority permit reply carries no permit"
            );
        }
        return this.permit;
    }

    public static encode(reply: AuthorityPermitIssuanceReply): Uint8Array {
        return AuthorityPermitIssuanceReply.codec.encode(reply);
    }

    public static decode(bytes: Uint8Array): AuthorityPermitIssuanceReply {
        return AuthorityPermitIssuanceReply.codec.decode(bytes);
    }
}

export class AuthorityCheckPayloadCodec implements CommandPayloadCodec<AuthorityCheckRequest> {
    public decode(bytes: Uint8Array): AuthorityCheckRequest {
        return AuthorityCheckRequest.decode(bytes);
    }
    public encode(request: AuthorityCheckRequest): Uint8Array {
        return AuthorityCheckRequest.encode(request);
    }
}

export class BindingValidationPayloadCodec implements CommandPayloadCodec<BindingValidationRequest> {
    public decode(bytes: Uint8Array): BindingValidationRequest {
        return BindingValidationRequest.decode(bytes);
    }
    public encode(request: BindingValidationRequest): Uint8Array {
        return BindingValidationRequest.encode(request);
    }
}

export class AuthorityPermitIssuancePayloadCodec implements CommandPayloadCodec<AuthorityPermitIssuanceRequest> {
    public decode(bytes: Uint8Array): AuthorityPermitIssuanceRequest {
        return AuthorityPermitIssuanceRequest.decode(bytes);
    }

    public encode(request: AuthorityPermitIssuanceRequest): Uint8Array {
        return AuthorityPermitIssuanceRequest.encode(request);
    }
}

function singleField(payload: JsonValue, field: string): JsonValue {
    const object = parseReply.exact(
        parseReply.object(payload, "Authority protocol reply"),
        [field],
        "Authority protocol reply"
    );
    const value = object[field];
    if (value === undefined) {
        throw new AgentCoreError("codec.invalid", "Authority protocol reply is malformed");
    }
    return value;
}
