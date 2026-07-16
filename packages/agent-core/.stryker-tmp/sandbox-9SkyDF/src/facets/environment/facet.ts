// @ts-nocheck
import type { LeaseToken } from "../../agents";
import { ContentRef, SecretRef } from "../../core";
import {
    EnvironmentController,
    EnvironmentId,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    PortExposureId,
    type EnvironmentSession,
    type EnvironmentSessionCapability
} from "../../environments";
import { Contributions, type OperationDescriptor } from "../contribution";
import { requireArray, requireDataObject, requireSafeInteger, requireString } from "../data";
import type { FacetManifest } from "../manifest";
import {
    DetailedProfileError,
    InternalProfileFacetRuntime,
    ProfileControlContract,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema,
    voidProfileWireCodec
} from "../profile-runtime";

export const ENVIRONMENT_OPERATIONS: readonly OperationDescriptor[] = Object.freeze([]);
export const ENVIRONMENT_EVENTS: readonly never[] = Object.freeze([]);
export const ENVIRONMENT_CONTRIBUTIONS = Contributions.empty();

export interface EnvironmentOpenInput extends PublicProfileInput {
    readonly environment: string;
    readonly restoreFrom?: string;
}

export interface EnvironmentSessionInput extends PublicProfileInput {
    readonly session: string;
}

export interface EnvironmentSnapshotInput extends PublicProfileInput {
    readonly session: string;
    readonly snapshot: string;
}

export interface EnvironmentRestoreInput extends PublicProfileInput {
    readonly environment: string;
    readonly snapshot: string;
}

export interface EnvironmentPreviewInput extends PublicProfileInput {
    readonly session: string;
    readonly port: number;
}

export interface EnvironmentCredentialInput extends PublicProfileInput {
    readonly session: string;
    readonly credential: SecretRef;
    readonly request: ContentRef;
}

export class EnvironmentSessionBinding {
    public readonly children: readonly string[];

    public constructor(
        public readonly session: string,
        public readonly generation: number,
        children: readonly string[]
    ) {
        if (session.trim().length === 0 || session !== session.trim()) {
            throw new TypeError("Environment session binding ID must be canonical");
        }
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError(
                "Environment session binding generation must be a non-negative safe integer"
            );
        }
        if (new Set(children).size !== children.length) {
            throw new TypeError("Environment session child binding names must be unique");
        }
        this.children = Object.freeze([...children]);
        Object.freeze(this);
    }
}

export abstract class EnvironmentBackend {
    public abstract open(input: EnvironmentOpenInput): Promise<EnvironmentSessionBinding>;
    public abstract use(input: EnvironmentSessionInput): Promise<EnvironmentSessionBinding>;
    public abstract close(input: EnvironmentSessionInput): Promise<void>;
    public abstract snapshot(input: EnvironmentSnapshotInput): Promise<ContentRef>;
    public abstract restore(input: EnvironmentRestoreInput): Promise<EnvironmentSessionBinding>;
    public abstract backupEphemeral(input: EnvironmentSessionInput): Promise<ContentRef>;
    public abstract restoreEphemeral(input: EnvironmentSnapshotInput): Promise<void>;
    public abstract exposePreview(input: EnvironmentPreviewInput): Promise<string>;
    public abstract forwardCredential(input: EnvironmentCredentialInput): Promise<ContentRef>;
}

export abstract class EnvironmentLeasePort {
    public abstract current(): LeaseToken;
}

export abstract class EnvironmentIdPort {
    public abstract environment(name: string): EnvironmentId;
    public abstract allocateSession(environment: EnvironmentId): EnvironmentSessionId;
    public abstract capability(session: string): EnvironmentSessionCapability;
    public abstract bind(session: EnvironmentSession): void;
    public abstract snapshot(name: string): EnvironmentSnapshotId;
    public abstract allocateSnapshot(session: EnvironmentSessionCapability): EnvironmentSnapshotId;
    public abstract allocateExposure(
        session: EnvironmentSessionCapability,
        port: number
    ): PortExposureId;
}

export abstract class EnvironmentChildBindingPort {
    public abstract bind(session: EnvironmentSession): readonly string[];
    public abstract backupEphemeral(
        capability: EnvironmentSessionCapability,
        lease: LeaseToken
    ): Promise<ContentRef>;
    public abstract restoreEphemeral(
        capability: EnvironmentSessionCapability,
        snapshot: EnvironmentSnapshotId,
        lease: LeaseToken
    ): Promise<void>;
}

export abstract class EnvironmentCredentialPort {
    public abstract forward(
        capability: EnvironmentSessionCapability,
        credential: SecretRef,
        request: ContentRef
    ): Promise<ContentRef>;
}

export abstract class EnvironmentPreviewPort {
    public abstract expose(
        capability: EnvironmentSessionCapability,
        exposureId: PortExposureId,
        port: number,
        lease: LeaseToken
    ): Promise<string>;
}

export class EnvironmentControllerPreviewPort extends EnvironmentPreviewPort {
    public constructor(private readonly controller: EnvironmentController) {
        super();
    }

    public async expose(
        capability: EnvironmentSessionCapability,
        exposureId: PortExposureId,
        port: number,
        lease: LeaseToken
    ): Promise<string> {
        const exposure = await this.controller.expose(capability, exposureId, port, lease);
        if (exposure.url === undefined)
            throw environmentOutput("Environment preview exposure is not ready");
        return exposure.url;
    }
}

export class EnvironmentControllerBackend extends EnvironmentBackend {
    public constructor(
        private readonly controller: EnvironmentController,
        private readonly leases: EnvironmentLeasePort,
        private readonly ids: EnvironmentIdPort,
        private readonly children: EnvironmentChildBindingPort,
        private readonly preview: EnvironmentPreviewPort,
        private readonly credentials: EnvironmentCredentialPort
    ) {
        super();
    }

    public async open(input: EnvironmentOpenInput): Promise<EnvironmentSessionBinding> {
        const environment = this.ids.environment(input.environment);
        const sessionId = this.ids.allocateSession(environment);
        const lease = this.leases.current();
        const reserved = this.controller.reserveSession(
            environment,
            sessionId,
            lease,
            input.restoreFrom === undefined ? undefined : this.ids.snapshot(input.restoreFrom)
        );
        const opened = await this.controller.openSession(reserved.capability, lease);
        opened.assertUsable();
        this.ids.bind(opened);
        return this.binding(opened);
    }

    public async use(input: EnvironmentSessionInput): Promise<EnvironmentSessionBinding> {
        const session = this.controller.session(this.ids.capability(input.session));
        return this.binding(session);
    }

    public async close(input: EnvironmentSessionInput): Promise<void> {
        await this.controller.closeSession(
            this.ids.capability(input.session),
            this.leases.current()
        );
    }

    public async snapshot(input: EnvironmentSnapshotInput): Promise<ContentRef> {
        const snapshot = await this.controller.snapshot(
            this.ids.capability(input.session),
            this.ids.snapshot(input.snapshot),
            this.leases.current()
        );
        if (snapshot.content === undefined)
            throw environmentOutput("Environment snapshot is not ready");
        return snapshot.content;
    }

    public async restore(input: EnvironmentRestoreInput): Promise<EnvironmentSessionBinding> {
        return this.open({ environment: input.environment, restoreFrom: input.snapshot });
    }

    public backupEphemeral(input: EnvironmentSessionInput): Promise<ContentRef> {
        const capability = this.ids.capability(input.session);
        return this.children.backupEphemeral(capability, this.leases.current());
    }

    public restoreEphemeral(input: EnvironmentSnapshotInput): Promise<void> {
        return this.children.restoreEphemeral(
            this.ids.capability(input.session),
            this.ids.snapshot(input.snapshot),
            this.leases.current()
        );
    }

    public async exposePreview(input: EnvironmentPreviewInput): Promise<string> {
        const capability = this.ids.capability(input.session);
        return this.preview.expose(
            capability,
            this.ids.allocateExposure(capability, input.port),
            input.port,
            this.leases.current()
        );
    }

    public forwardCredential(input: EnvironmentCredentialInput): Promise<ContentRef> {
        return this.credentials.forward(
            this.ids.capability(input.session),
            input.credential,
            input.request
        );
    }

    private binding(session: EnvironmentSession): EnvironmentSessionBinding {
        return new EnvironmentSessionBinding(
            session.id.value,
            session.generation,
            this.children.bind(session)
        );
    }
}

const idProperty = { type: "string", minLength: 1 } as const;
const contentRefProperty = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const;
const sessionSchema = schema({
    type: "object",
    properties: {
        session: idProperty,
        generation: { type: "integer", minimum: 0 },
        children: { type: "array", items: { type: "string" }, uniqueItems: true }
    },
    required: ["session", "generation", "children"],
    additionalProperties: false
});
const sessionInput = strictObjectSchema({ session: idProperty }, ["session"]);
const sessionInputCodec = profileWireCodec<EnvironmentSessionInput>(
    (input) => ({ session: input.session }),
    (data) => ({
        session: requireString(
            requireDataObject(data, "Environment session input")["session"],
            "Session ID"
        )
    })
);
const sessionBindingCodec = profileWireCodec<EnvironmentSessionBinding>(
    (binding) => ({
        session: binding.session,
        generation: binding.generation,
        children: [...binding.children]
    }),
    (data) => {
        const object = requireDataObject(data, "Environment session binding");
        return new EnvironmentSessionBinding(
            requireString(object["session"], "Environment session ID"),
            requireSafeInteger(object["generation"], "Environment generation"),
            requireArray(object["children"], "Environment child bindings").map((value) =>
                requireString(value, "Environment child binding")
            )
        );
    }
);
const snapshotInputCodec = profileWireCodec<EnvironmentSnapshotInput>(
    (input) => ({ session: input.session, snapshot: input.snapshot }),
    (data) => {
        const object = requireDataObject(data, "Environment snapshot input");
        return {
            session: requireString(object["session"], "Environment session ID"),
            snapshot: requireString(object["snapshot"], "Environment snapshot ID")
        };
    }
);
const contentRefCodec = profileWireCodec<ContentRef>(
    (content) => content.value,
    (data) => new ContentRef(requireString(data, "Content reference"))
);

export const ENVIRONMENT_CONTROL_CONTRACTS = Object.freeze({
    open: new ProfileControlContract<
        "environment.open",
        EnvironmentOpenInput,
        EnvironmentSessionBinding
    >(
        "environment.open",
        strictObjectSchema({ environment: idProperty, restoreFrom: idProperty }, ["environment"]),
        sessionSchema,
        profileWireCodec(
            (input) => ({
                environment: input.environment,
                ...(input.restoreFrom === undefined ? {} : { restoreFrom: input.restoreFrom })
            }),
            (data) => {
                const object = requireDataObject(data, "Environment open input");
                return {
                    environment: requireString(object["environment"], "Environment ID"),
                    ...(object["restoreFrom"] === undefined
                        ? {}
                        : {
                              restoreFrom: requireString(
                                  object["restoreFrom"],
                                  "Environment snapshot ID"
                              )
                          })
                };
            }
        ),
        sessionBindingCodec
    ),
    use: new ProfileControlContract<
        "environment.use",
        EnvironmentSessionInput,
        EnvironmentSessionBinding
    >("environment.use", sessionInput, sessionSchema, sessionInputCodec, sessionBindingCodec),
    close: new ProfileControlContract<"environment.close", EnvironmentSessionInput, void>(
        "environment.close",
        sessionInput,
        schema({ type: "null" }),
        sessionInputCodec,
        voidProfileWireCodec
    ),
    snapshot: new ProfileControlContract<
        "environment.snapshot",
        EnvironmentSnapshotInput,
        ContentRef
    >(
        "environment.snapshot",
        strictObjectSchema({ session: idProperty, snapshot: idProperty }, ["session", "snapshot"]),
        schema(contentRefProperty),
        snapshotInputCodec,
        contentRefCodec
    ),
    restore: new ProfileControlContract<
        "environment.restore",
        EnvironmentRestoreInput,
        EnvironmentSessionBinding
    >(
        "environment.restore",
        strictObjectSchema({ environment: idProperty, snapshot: idProperty }, [
            "environment",
            "snapshot"
        ]),
        sessionSchema,
        profileWireCodec(
            (input) => ({ environment: input.environment, snapshot: input.snapshot }),
            (data) => {
                const object = requireDataObject(data, "Environment restore input");
                return {
                    environment: requireString(object["environment"], "Environment ID"),
                    snapshot: requireString(object["snapshot"], "Environment snapshot ID")
                };
            }
        ),
        sessionBindingCodec
    ),
    backupEphemeral: new ProfileControlContract<
        "environment.backupEphemeral",
        EnvironmentSessionInput,
        ContentRef
    >(
        "environment.backupEphemeral",
        sessionInput,
        schema(contentRefProperty),
        sessionInputCodec,
        contentRefCodec
    ),
    restoreEphemeral: new ProfileControlContract<
        "environment.restoreEphemeral",
        EnvironmentSnapshotInput,
        void
    >(
        "environment.restoreEphemeral",
        strictObjectSchema({ session: idProperty, snapshot: idProperty }, ["session", "snapshot"]),
        schema({ type: "null" }),
        snapshotInputCodec,
        voidProfileWireCodec
    ),
    exposePreview: new ProfileControlContract<
        "environment.exposePreview",
        EnvironmentPreviewInput,
        string
    >(
        "environment.exposePreview",
        strictObjectSchema(
            { session: idProperty, port: { type: "integer", minimum: 1, maximum: 65_535 } },
            ["session", "port"]
        ),
        schema({ type: "string", format: "uri" }),
        profileWireCodec(
            (input) => ({ session: input.session, port: input.port }),
            (data) => {
                const object = requireDataObject(data, "Environment preview input");
                return {
                    session: requireString(object["session"], "Environment session ID"),
                    port: requireSafeInteger(object["port"], "Environment preview port")
                };
            }
        ),
        profileWireCodec(
            (value) => value,
            (data) => requireString(data, "Environment preview URL")
        )
    ),
    forwardCredential: new ProfileControlContract<
        "environment.forwardCredential",
        EnvironmentCredentialInput,
        ContentRef
    >(
        "environment.forwardCredential",
        strictObjectSchema(
            {
                session: idProperty,
                credential: {
                    type: "object",
                    properties: { source: idProperty, provider: idProperty, id: idProperty },
                    required: ["source", "provider", "id"],
                    additionalProperties: false
                },
                request: contentRefProperty
            },
            ["session", "credential", "request"]
        ),
        schema(contentRefProperty),
        profileWireCodec(
            (input) => ({
                session: input.session,
                credential: {
                    source: input.credential.source,
                    provider: input.credential.provider,
                    id: input.credential.id
                },
                request: input.request.value
            }),
            (data) => {
                const object = requireDataObject(data, "Environment credential input");
                const credential = requireDataObject(
                    object["credential"]!,
                    "Environment credential"
                );
                return {
                    session: requireString(object["session"], "Environment session ID"),
                    credential: new SecretRef(
                        requireString(credential["source"], "Credential source"),
                        requireString(credential["provider"], "Credential provider"),
                        requireString(credential["id"], "Credential ID")
                    ),
                    request: new ContentRef(requireString(object["request"], "Credential request"))
                };
            }
        ),
        contentRefCodec
    )
});

export class EnvironmentFacet<Receipt> {
    public static readonly operations = ENVIRONMENT_OPERATIONS;
    public static readonly events = ENVIRONMENT_EVENTS;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: EnvironmentBackend
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({ manifest, runtime: this.runtime, operations: [] });
    }

    public open(input: EnvironmentOpenInput): Promise<EnvironmentSessionBinding> {
        return this.runtime.control(ENVIRONMENT_CONTROL_CONTRACTS.open, input, (admitted) =>
            this.backend.open(admitted)
        );
    }

    public use(input: EnvironmentSessionInput): Promise<EnvironmentSessionBinding> {
        return this.runtime.control(ENVIRONMENT_CONTROL_CONTRACTS.use, input, (admitted) =>
            this.backend.use(admitted)
        );
    }

    public close(input: EnvironmentSessionInput): Promise<void> {
        return this.runtime.control(ENVIRONMENT_CONTROL_CONTRACTS.close, input, (admitted) =>
            this.backend.close(admitted)
        );
    }

    public snapshot(input: EnvironmentSnapshotInput): Promise<ContentRef> {
        return this.runtime.control(ENVIRONMENT_CONTROL_CONTRACTS.snapshot, input, (admitted) =>
            this.backend.snapshot(admitted)
        );
    }

    public restore(input: EnvironmentRestoreInput): Promise<EnvironmentSessionBinding> {
        return this.runtime.control(ENVIRONMENT_CONTROL_CONTRACTS.restore, input, (admitted) =>
            this.backend.restore(admitted)
        );
    }

    public backupEphemeral(input: EnvironmentSessionInput): Promise<ContentRef> {
        return this.runtime.control(
            ENVIRONMENT_CONTROL_CONTRACTS.backupEphemeral,
            input,
            (admitted) => this.backend.backupEphemeral(admitted)
        );
    }

    public restoreEphemeral(input: EnvironmentSnapshotInput): Promise<void> {
        return this.runtime.control(
            ENVIRONMENT_CONTROL_CONTRACTS.restoreEphemeral,
            input,
            (admitted) => this.backend.restoreEphemeral(admitted)
        );
    }

    public exposePreview(input: EnvironmentPreviewInput): Promise<string> {
        return this.runtime.control(
            ENVIRONMENT_CONTROL_CONTRACTS.exposePreview,
            input,
            (admitted) => this.backend.exposePreview(admitted)
        );
    }

    public forwardCredential(input: EnvironmentCredentialInput): Promise<ContentRef> {
        return this.runtime.control(
            ENVIRONMENT_CONTROL_CONTRACTS.forwardCredential,
            input,
            (admitted) => this.backend.forwardCredential(admitted)
        );
    }
}

function environmentOutput(message: string): DetailedProfileError<"environment.output"> {
    return new DetailedProfileError("operation.invalid-output", "environment.output", message);
}
