import { TurnId, type LeaseToken } from "../../../src/agents";
import { ContentRef, Digest, Revision, SecretRef } from "../../../src/core";
import {
    EnvironmentController,
    EnvironmentId,
    EnvironmentProvider,
    EnvironmentRevisionRecord,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    MemoryEnvironmentProviderRegistry,
    MemoryEnvironmentStore,
    PortExposureId,
    ProviderActionOutcome,
    ProviderDescriptor,
    ProviderId,
    ProviderResourceOutcome,
    type ExposePortRequest,
    type LiveEnvironmentSession,
    type OpenSessionRequest,
    type SnapshotEnvironmentRequest
} from "../../../src/environments";
import { PrincipalId } from "../../../src/identity";
import {
    ENVIRONMENT_EVENTS,
    ENVIRONMENT_CONTROL_CONTRACTS,
    ENVIRONMENT_OPERATIONS,
    EnvironmentBackend,
    EnvironmentChildBindingPort,
    EnvironmentControllerBackend,
    EnvironmentControllerPreviewPort,
    EnvironmentCredentialPort,
    EnvironmentFacet,
    EnvironmentIdPort,
    EnvironmentLeasePort,
    EnvironmentSessionBinding,
    type EnvironmentCredentialInput,
    type EnvironmentOpenInput,
    type EnvironmentPreviewInput,
    type EnvironmentRestoreInput,
    type EnvironmentSessionInput,
    type EnvironmentSnapshotInput
} from "../../../src/facets";
import { describe, expect, test } from "vitest";
import { denyingRuntime, recordingRuntime } from "./harness";

describe("Environment protected control profile", () => {
    test("[P11-ENVIRONMENT-SPECIFICATION] declares no Operations or Events and routes lifecycle, durability, preview, and credentials through control", async () => {
        const backend = new TestEnvironmentBackend();
        const { runtime, admission } = recordingRuntime("environment");
        const environment = new EnvironmentFacet(runtime, backend);
        const session = await environment.open({ environment: "env" });
        await environment.use({ session: session.session });
        await environment.snapshot({ session: session.session, snapshot: "snapshot" });
        await environment.restore({ environment: "env", snapshot: "snapshot" });
        await environment.backupEphemeral({ session: session.session });
        await environment.restoreEphemeral({ session: session.session, snapshot: "snapshot" });
        await environment.exposePreview({ session: session.session, port: 8080 });
        await environment.forwardCredential({
            session: session.session,
            credential: new SecretRef("tenant", "vault", "key"),
            request: content("a")
        });
        await environment.close({ session: session.session });

        expect(ENVIRONMENT_OPERATIONS).toEqual([]);
        expect(ENVIRONMENT_EVENTS).toEqual([]);
        expect(session.children).toContain("env.fs");
        expect(admission.calls.map((call) => [call.kind, call.name])).toEqual([
            ["control", "environment.open"],
            ["control", "environment.use"],
            ["control", "environment.snapshot"],
            ["control", "environment.restore"],
            ["control", "environment.backupEphemeral"],
            ["control", "environment.restoreEphemeral"],
            ["control", "environment.exposePreview"],
            ["control", "environment.forwardCredential"],
            ["control", "environment.close"]
        ]);
        expect(admission.calls[7]?.input).toEqual({
            session: "session",
            credential: { source: "tenant", provider: "vault", id: "key" },
            request: content("a").value
        });
    });

    test("[P11-ENVIRONMENT-FAIL-CLOSED] denial prevents session opening", async () => {
        const backend = new TestEnvironmentBackend();
        const environment = new EnvironmentFacet(denyingRuntime("environment").runtime, backend);
        await expect(environment.open({ environment: "env" })).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(backend.calls).toEqual([]);
    });

    test("[P11-ENVIRONMENT-CHILD-FACETS] validates canonical session bindings and freezes child capabilities", () => {
        expect(() => new EnvironmentSessionBinding(" ", 0, [])).toThrow(TypeError);
        expect(() => new EnvironmentSessionBinding("session", -1, [])).toThrow(TypeError);
        expect(() => new EnvironmentSessionBinding("session", 0, ["env.fs", "env.fs"])).toThrow(
            /unique/u
        );
        const children = ["env.fs"];
        const binding = new EnvironmentSessionBinding("session", 0, children);
        children[0] = "replaced";
        expect(binding.children).toEqual(["env.fs"]);
        expect(Object.isFrozen(binding.children)).toBe(true);
    });

    test("[P11-ENVIRONMENT-CHILD-CONTRACTS] adapts typed EnvironmentController lease, IDs, children, preview, and credentials", async () => {
        const provider = new ReadyProvider();
        const controller = new EnvironmentController(
            new MemoryEnvironmentStore(),
            new MemoryEnvironmentProviderRegistry([provider]),
            { permits: (candidate) => candidate === environmentLease }
        );
        controller.provision(
            new EnvironmentRevisionRecord(
                environmentId,
                Revision.initial(),
                0,
                provider.descriptor
            ),
            environmentLease
        );
        const ids = new TestEnvironmentIds();
        const backend = new EnvironmentControllerBackend(
            controller,
            new FixedLease(),
            ids,
            new TestChildren(),
            new EnvironmentControllerPreviewPort(controller),
            new TestCredentials()
        );

        const opened = await backend.open({ environment: "environment-profile" });
        expect(opened.children).toEqual(["env.fs", "env.shell"]);
        await expect(backend.use({ session: opened.session })).resolves.toEqual(opened);
        await expect(
            backend.snapshot({ session: opened.session, snapshot: "snapshot" })
        ).resolves.toEqual(provider.snapshotContent);
        await expect(backend.backupEphemeral({ session: opened.session })).resolves.toEqual(
            content("f")
        );
        await expect(
            backend.restoreEphemeral({ session: opened.session, snapshot: "snapshot" })
        ).resolves.toBeUndefined();
        await expect(backend.exposePreview({ session: opened.session, port: 8080 })).resolves.toBe(
            provider.previewUrl
        );
        await expect(
            backend.forwardCredential({
                session: opened.session,
                credential: new SecretRef("tenant", "vault", "credential"),
                request: content("e")
            })
        ).resolves.toEqual(content("e"));
        await expect(
            backend.restore({ environment: "environment-profile", snapshot: "snapshot" })
        ).resolves.toMatchObject({ generation: 0, children: ["env.fs", "env.shell"] });

        provider.snapshotResult = ProviderResourceOutcome.indeterminate;
        await expect(
            backend.snapshot({ session: opened.session, snapshot: "pending-snapshot" })
        ).rejects.toMatchObject({
            code: "operation.invalid-output",
            detailCode: "environment.output"
        });
        await backend.close({ session: opened.session });
    });

    test("round-trips optional restore and child wire data and rejects a preview without a URL", async () => {
        const open = ENVIRONMENT_CONTROL_CONTRACTS.open;
        expect(
            open.decodeInput(
                open.encodeInput({
                    environment: "environment-profile",
                    restoreFrom: "snapshot"
                })
            )
        ).toEqual({ environment: "environment-profile", restoreFrom: "snapshot" });
        expect(open.decodeInput({ environment: "environment-profile" })).toEqual({
            environment: "environment-profile"
        });
        expect(
            open.decodeOutput(
                open.encodeOutput(
                    new EnvironmentSessionBinding("session-wire", 2, ["env.fs", "env.shell"])
                )
            )
        ).toEqual(new EnvironmentSessionBinding("session-wire", 2, ["env.fs", "env.shell"]));

        const preview = new EnvironmentControllerPreviewPort({
            expose: async () => ({ url: undefined })
        } as unknown as EnvironmentController);
        await expect(
            preview.expose(
                {} as import("../../../src/environments").EnvironmentSessionCapability,
                new PortExposureId("preview-pending"),
                8080,
                environmentLease
            )
        ).rejects.toMatchObject({
            code: "operation.invalid-output",
            detailCode: "environment.output"
        });
    });
});

class TestEnvironmentBackend extends EnvironmentBackend {
    public readonly calls: string[] = [];
    public readonly fs = "env.fs";

    public async open(_input: EnvironmentOpenInput): Promise<EnvironmentSessionBinding> {
        this.calls.push("open");
        return this.binding();
    }

    public async use(_input: EnvironmentSessionInput): Promise<EnvironmentSessionBinding> {
        this.calls.push("use");
        return this.binding();
    }

    public async close(_input: EnvironmentSessionInput): Promise<void> {
        this.calls.push("close");
    }
    public async snapshot(_input: EnvironmentSnapshotInput): Promise<ContentRef> {
        this.calls.push("snapshot");
        return content("b");
    }
    public async restore(_input: EnvironmentRestoreInput): Promise<EnvironmentSessionBinding> {
        this.calls.push("restore");
        return this.binding();
    }
    public async backupEphemeral(_input: EnvironmentSessionInput): Promise<ContentRef> {
        this.calls.push("backup");
        return content("c");
    }
    public async restoreEphemeral(_input: EnvironmentSnapshotInput): Promise<void> {
        this.calls.push("restoreFs");
    }
    public async exposePreview(_input: EnvironmentPreviewInput): Promise<string> {
        this.calls.push("preview");
        return "https://preview.test/";
    }
    public async forwardCredential(_input: EnvironmentCredentialInput): Promise<ContentRef> {
        this.calls.push("credential");
        return content("d");
    }

    private binding(): EnvironmentSessionBinding {
        return new EnvironmentSessionBinding("session", 1, [this.fs]);
    }
}

function content(character: string): ContentRef {
    return ContentRef.fromDigest(new Digest(character.repeat(64)));
}

const environmentId = new EnvironmentId("environment-profile");
const environmentLease: LeaseToken = Object.freeze({
    turn: new TurnId("environment-profile-turn"),
    holder: new PrincipalId("environment-profile-holder"),
    epoch: 1
});

class FixedLease extends EnvironmentLeasePort {
    public current(): LeaseToken {
        return environmentLease;
    }
}

class TestEnvironmentIds extends EnvironmentIdPort {
    readonly #capabilities = new Map<
        string,
        import("../../../src/environments").EnvironmentSessionCapability
    >();
    #session = 0;
    #exposure = 0;
    public environment(name: string): EnvironmentId {
        return new EnvironmentId(name);
    }
    public allocateSession(): EnvironmentSessionId {
        return new EnvironmentSessionId(`profile-session-${this.#session++}`);
    }
    public capability(session: string) {
        const capability = this.#capabilities.get(session);
        if (capability === undefined) throw new TypeError("Unknown test session");
        return capability;
    }
    public bind(session: import("../../../src/environments").EnvironmentSession): void {
        this.#capabilities.set(session.id.value, session.capability);
    }
    public snapshot(name: string): EnvironmentSnapshotId {
        return new EnvironmentSnapshotId(name);
    }
    public allocateSnapshot(): EnvironmentSnapshotId {
        return new EnvironmentSnapshotId("allocated-snapshot");
    }
    public allocateExposure(): PortExposureId {
        return new PortExposureId(`profile-exposure-${this.#exposure++}`);
    }
}

class TestChildren extends EnvironmentChildBindingPort {
    public bind(): readonly string[] {
        return ["env.fs", "env.shell"];
    }
    public async backupEphemeral(): Promise<ContentRef> {
        return content("f");
    }
    public async restoreEphemeral(): Promise<void> {}
}

class TestCredentials extends EnvironmentCredentialPort {
    public async forward(
        _capability: import("../../../src/environments").EnvironmentSessionCapability,
        _credential: SecretRef,
        request: ContentRef
    ): Promise<ContentRef> {
        return request;
    }
}

class ReadyProvider extends EnvironmentProvider {
    public readonly descriptor = new ProviderDescriptor(
        new ProviderId("profile-provider"),
        "1",
        content("a")
    );
    public readonly snapshotContent = content("b");
    public readonly previewUrl = "https://profile-preview.test/";
    public snapshotResult = ProviderResourceOutcome.ready(this.snapshotContent);
    readonly #handle: LiveEnvironmentSession = { children: [], release() {} };

    public async openSession(_request: OpenSessionRequest) {
        return ProviderResourceOutcome.ready(this.#handle);
    }
    public async inspectSession(_request: OpenSessionRequest) {
        return ProviderResourceOutcome.ready(this.#handle);
    }
    public async closeSession(_request: OpenSessionRequest) {
        return ProviderActionOutcome.succeeded;
    }
    public async createSnapshot(_request: SnapshotEnvironmentRequest) {
        return this.snapshotResult;
    }
    public async inspectSnapshot(_request: SnapshotEnvironmentRequest) {
        return ProviderResourceOutcome.ready(this.snapshotContent);
    }
    public async exposePort(_request: ExposePortRequest) {
        return ProviderResourceOutcome.ready(this.previewUrl);
    }
    public async inspectExposure(_request: ExposePortRequest) {
        return ProviderResourceOutcome.ready(this.previewUrl);
    }
    public async revokeExposure(_request: ExposePortRequest) {
        return ProviderActionOutcome.succeeded;
    }
}
