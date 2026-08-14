import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermit,
    AuthorityPermitExpectation,
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
const parseIssuance = jsonDataParser(
    () => new AgentCoreError("codec.invalid", "Authority permit issuance request is malformed")
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
        super("protocol.authority-permit-issuance-request", { major: 1, minor: 0 });
    }

    protected encodePayload(request: AuthorityPermitIssuanceRequest): JsonValue {
        return {
            expectation: request.expectation.toData(),
            expiresAt: request.expiresAt.getTime(),
            nonce: request.nonce
        };
    }

    protected decodePayload(payload: JsonValue): AuthorityPermitIssuanceRequest {
        const object = parseRequest.exact(
            parseRequest.object(payload, "Authority protocol payload"),
            ["expectation", "expiresAt", "nonce"],
            "Authority protocol payload"
        );
        const nonce = parseIssuance.string(object["nonce"], "Authority permit issuance request");
        const expiresAt = parseIssuance.safeInteger(
            object["expiresAt"],
            "Authority permit issuance request"
        );
        return new AuthorityPermitIssuanceRequest(
            AuthorityPermitExpectation.fromData(object["expectation"]),
            nonce,
            new Date(expiresAt)
        );
    }
}

class AuthorityPermitIssuanceReplyCodec extends RecordCodec<AuthorityPermitIssuanceReply> {
    public constructor() {
        super("protocol.authority-permit-issuance-reply", { major: 1, minor: 0 });
    }

    protected encodePayload(reply: AuthorityPermitIssuanceReply): JsonValue {
        return { permit: reply.permit.toData() };
    }

    protected decodePayload(payload: JsonValue): AuthorityPermitIssuanceReply {
        return new AuthorityPermitIssuanceReply(
            AuthorityPermit.fromData(singleField(payload, "permit"))
        );
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
    readonly #expiresAt: number;

    public constructor(
        public readonly expectation: AuthorityPermitExpectation,
        public readonly nonce: string,
        expiresAt: Date
    ) {
        if (nonce.length === 0 || nonce !== nonce.trim()) {
            throw new TypeError("Authority permit issuance nonce must be canonical and nonblank");
        }
        const expiresAtTime = expiresAt.getTime();
        if (!Number.isSafeInteger(expiresAtTime) || expiresAtTime < 0) {
            throw new TypeError("Authority permit issuance expiry is invalid");
        }
        this.#expiresAt = expiresAtTime;
        Object.freeze(this);
    }

    public get expiresAt(): Date {
        return new Date(this.#expiresAt);
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

    public constructor(public readonly permit: AuthorityPermit) {
        Object.freeze(this);
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
