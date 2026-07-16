// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, MemoryActorStore } from "../../src/actors";
import { ProvenanceFacetSlotBackend, createClosedCommandDispatcher } from "../../src/composition";
import {
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    encodeCanonicalJson
} from "../../src/core";
import {
    DeploymentId,
    ManagedOrigin,
    PackageId,
    PackageInstallationProvenancePort,
    PackagePin,
    type AuthenticatedPackageInstallation
} from "../../src/definition";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    FacetPackageId,
    FacetRef,
    PackageInstallationRef,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    type WorkspaceSlotStore
} from "../../src/facets";
import {
    FACET_SLOT_COMMANDS,
    CommandEnvelope,
    CommandEnvelopeCodec,
    CommandIngress,
    FacetSlotCommandPayload,
    FacetSlotContributeCommand,
    FacetSlotInstallCommand,
    MemoryProtocolPersistence,
    MemoryProtocolRecords,
    type CommandCaller,
    type CommandDispatchResult,
    type FacetSlotCommandBackend,
    type ProtocolCommand,
    type SlotContributionRequest
} from "../../src/protocol";
import { CounterAuthenticator, CounterContentStore, CounterIds } from "./counter-fixture";

const decisionAt = new Date("2026-07-12T12:00:00.000Z");

describe("Facet Slot protocol commands", () => {
    test("requires the exact Workspace Actor and authority backend", () => {
        const target = actor("workspace");
        const foreign = actor("foreign");
        const backend = new Backend();
        const install = new FacetSlotInstallCommand(backend, target);
        const declaration = slot();
        const payload = install.payload.decode(FacetSlotCommandPayload.install(declaration));
        const commandEnvelope = envelope(FACET_SLOT_COMMANDS.install, target);

        expect(install.caller.admits(caller(target))).toBe(true);
        expect(install.caller.admits(caller(foreign))).toBe(false);
        expect(
            install.caller.admits({
                kind: "principal",
                principal: new PrincipalRef(new TenantId("tenant"), new PrincipalId("principal"))
            })
        ).toBe(false);
        expect(install.authorize(backend, commandEnvelope, payload)).toBe(true);
        expect(install.permitsLifecycle(backend, commandEnvelope, payload)).toBe(true);
        expect(install.currentLease(backend, commandEnvelope, payload, decisionAt)).toBeUndefined();
        expect(install.currentRevision(backend, commandEnvelope, payload).value).toBe(0);
        backend.installAllowed = false;
        expect(
            install.authorize(backend, envelope(FACET_SLOT_COMMANDS.install, target), payload)
        ).toBe(false);
        expect(
            () =>
                new FacetSlotInstallCommand(backend, new ActorRef("tenant", new ActorId("tenant")))
        ).toThrow(/Workspace/);
    });

    test("installs and contributes under exact revision progression", () => {
        const target = actor("workspace");
        const backend = new Backend();
        const install = new FacetSlotInstallCommand(backend, target);
        const contribute = new FacetSlotContributeCommand(backend, target);
        const declaration = slot();
        const candidate = entry();

        const installReply = install.execute(
            backend,
            envelope(FACET_SLOT_COMMANDS.install, target, new Revision(0)),
            install.payload.decode(FacetSlotCommandPayload.install(declaration)),
            decisionAt
        );
        expect(installReply.reply.revision.value).toBe(1);
        expect(installReply.observation).toEqual(declaration);
        const decoded = contribute.payload.decode(
            FacetSlotCommandPayload.contribute(contribution(candidate))
        );
        const contributionEnvelope = envelope(
            FACET_SLOT_COMMANDS.contribute,
            target,
            new Revision(1)
        );
        expect(
            contribute.currentLease(backend, contributionEnvelope, decoded, decisionAt)
        ).toBeUndefined();
        expect(contribute.currentRevision(backend, contributionEnvelope, decoded).value).toBe(1);
        expect(contribute.authorize(backend, contributionEnvelope, decoded)).toBe(true);
        expect(contribute.permitsLifecycle(backend, contributionEnvelope, decoded)).toBe(true);
        const contributionReply = contribute.execute(
            backend,
            contributionEnvelope,
            decoded,
            decisionAt
        );
        expect(contributionReply.reply.revision.value).toBe(2);
        expect(contributionReply.observation).toEqual(candidate);
        expect(backend.entries).toHaveLength(1);

        backend.changed = false;
        const replayEnvelope = envelope(FACET_SLOT_COMMANDS.contribute, target, new Revision(2));
        expect(contribute.authorize(backend, replayEnvelope, decoded)).toBe(true);
        const noOpReply = contribute.execute(backend, replayEnvelope, decoded, decisionAt);
        expect(noOpReply.reply.revision.value).toBe(2);
        expect(noOpReply.observation).toBeUndefined();
        expect(backend.revision.value).toBe(2);
    });

    test("[C13-ADV-UNAUTHORIZED-SLOT] strictly decodes payloads and denies unauthorized contributions", () => {
        const target = actor("workspace");
        const backend = new Backend();
        const command = new FacetSlotContributeCommand(backend, target);
        backend.contributionAllowed = false;
        const decoded = command.payload.decode(
            FacetSlotCommandPayload.contribute(contribution(entry()))
        );

        expect(command.authorize(backend, envelope(command.command, target), decoded)).toBe(false);
        expect(() =>
            command.payload.decode(encodeCanonicalJson({ entry: entry().toData(), extra: true }))
        ).toThrow(/unknown fields/);
    });

    test("[C13-FACET-SLOT-AUTHORITY] derives contributor provenance and enforces Slot authority through the closed authenticated dispatcher", async () => {
        const admitted = closedSlotFixture("workspace:trusted", "workspace:trusted");
        const payload = FacetSlotCommandPayload.contribute({
            slot: new SlotName("dashboard.card"),
            ordinal: 0,
            value: { title: "Trusted" }
        });
        expect(new TextDecoder().decode(payload)).not.toContain("contributor");

        const committed = await admitted.dispatch(payload, "trusted-contribution");
        expect(committed.outcome).toBe("committed");
        const observation = SlotEntry.decode(committed.observation!);
        expect(observation.contributor.value).toBe("workspace:trusted");
        expect(admitted.entries().map((candidate) => candidate.contributor.value)).toEqual([
            "workspace:trusted"
        ]);

        const denied = closedSlotFixture("workspace:untrusted", "workspace:trusted");
        const rejected = await denied.dispatch(payload, "untrusted-contribution");
        expect(rejected.outcome).toBe("rejectedAuthority");
        expect(rejected.observation).toBeUndefined();
        expect(denied.entries()).toEqual([]);
    });

    test("atomically rejects payload, authority, and installation provenance substitution", () => {
        const target = actor("workspace");
        const declaration = slot();
        const state: SlotState = {
            revision: new Revision(1),
            slots: new Map([[declaration.name.value, declaration]]),
            entries: new Map()
        };
        const store = slotStore();
        const provenance = new MutableInstallationProvenance(installation(1));
        let contributionAllowed = true;
        const backend = new ProvenanceFacetSlotBackend(
            store,
            provenance,
            {
                permitsInstall: () => true,
                permitsContribution: () => contributionAllowed
            },
            {
                revision: (transaction) => store.loadRevision(transaction),
                slot: (transaction, name) => store.loadSlot(transaction, name)
            }
        );
        const command = new FacetSlotContributeCommand(backend, target);
        const request = contribution(entry());

        const provenanceEnvelope = envelope(command.command, target, new Revision(1));
        expect(command.authorize(state, provenanceEnvelope, request)).toBe(true);
        provenance.installation = installation(2);
        expect(() => command.execute(state, provenanceEnvelope, request, decisionAt)).toThrow(
            /provenance changed/
        );

        provenance.installation = installation(1);
        const authorityEnvelope = envelope(command.command, target, new Revision(1));
        expect(command.authorize(state, authorityEnvelope, request)).toBe(true);
        contributionAllowed = false;
        expect(() => command.execute(state, authorityEnvelope, request, decisionAt)).toThrow(
            /Current authority/
        );

        contributionAllowed = true;
        const payloadEnvelope = envelope(command.command, target, new Revision(1));
        expect(command.authorize(state, payloadEnvelope, request)).toBe(true);
        expect(() =>
            command.execute(
                state,
                payloadEnvelope,
                { ...request, value: { title: "Substituted" } },
                decisionAt
            )
        ).toThrow(/substituted/);

        const schemaEnvelope = envelope(command.command, target, new Revision(1));
        expect(command.authorize(state, schemaEnvelope, request)).toBe(true);
        state.slots.set(
            declaration.name.value,
            new SlotDeclaration(
                declaration.name,
                new JsonSchema({ type: "null" }),
                declaration.authority
            )
        );
        expect(() => command.execute(state, schemaEnvelope, request, decisionAt)).toThrow(
            /entry schema/
        );

        expect(state.entries.size).toBe(0);
        expect(state.revision.value).toBe(1);
    });

    test("strictly decodes typed replies without accepting revision coercion", () => {
        const command = new FacetSlotInstallCommand(new Backend(), actor("workspace"));
        const codec = command.replyCodec!;
        expect(codec.decode(codec.encode({ revision: new Revision(3) })).revision.value).toBe(3);
        for (const malformed of [
            null,
            {},
            { revision: 0, extra: true },
            { revision: "0" },
            { revision: -1 },
            { revision: 1.5 }
        ]) {
            expect(() => codec.decode(encodeCanonicalJson(malformed as never))).toThrow(TypeError);
        }
        expect(() =>
            command.payload.decode(encodeCanonicalJson({ record: "AA==", extra: true }))
        ).toThrow(/unknown fields/);
    });

    test("covers malformed protocol state, lifecycle denial, foreign callers, and install no-ops", () => {
        const target = actor("workspace");
        const foreign = actor("foreign");
        const backend = new Backend();
        const install = new FacetSlotInstallCommand(backend, target);
        const contribute = new FacetSlotContributeCommand(backend, target);
        const declaration = slot();
        const decodedDeclaration = install.payload.decode(
            FacetSlotCommandPayload.install(declaration)
        );
        const encodedContribution = FacetSlotCommandPayload.contribute(contribution(entry()));
        expect(new TextDecoder().decode(encodedContribution)).not.toContain("contributor");
        const decodedEntry = contribute.payload.decode(encodedContribution);

        expect(
            install.authorize(backend, envelope(install.command, foreign), decodedDeclaration)
        ).toBe(false);
        expect(
            contribute.authorize(backend, envelope(contribute.command, foreign), decodedEntry)
        ).toBe(false);
        expect(
            contribute.permitsLifecycle(backend, envelope(contribute.command, target), decodedEntry)
        ).toBe(false);
        backend.provenanceAvailable = false;
        expect(
            contribute.permitsLifecycle(backend, envelope(contribute.command, target), decodedEntry)
        ).toBe(false);
        backend.provenanceAvailable = true;
        backend.declaration = new SlotDeclaration(
            new SlotName("dashboard.card"),
            new JsonSchema({ type: "null" }),
            new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"])
        );
        const invalidSchemaEnvelope = envelope(contribute.command, target);
        expect(contribute.authorize(backend, invalidSchemaEnvelope, decodedEntry)).toBe(true);
        expect(contribute.permitsLifecycle(backend, invalidSchemaEnvelope, decodedEntry)).toBe(
            false
        );
        expectAgentCoreError(
            () =>
                install.execute(
                    backend,
                    envelope(install.command, target),
                    {} as never,
                    decisionAt
                ),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () =>
                contribute.execute(
                    backend,
                    envelope(contribute.command, target),
                    {} as never,
                    decisionAt
                ),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () =>
                install.execute(
                    backend,
                    envelopeWithoutRevision(install.command, target),
                    decodedDeclaration,
                    decisionAt
                ),
            "protocol.revision-conflict"
        );

        backend.changed = false;
        const reply = install.execute(
            backend,
            envelope(install.command, target),
            decodedDeclaration,
            decisionAt
        );
        expect(reply.reply.revision.value).toBe(0);
        expect(() => install.payload.decode(encodeCanonicalJson({ record: 1 }))).toThrow(/string/);
        expect(() => contribute.payload.decode(encodeCanonicalJson({ record: "%%%" }))).toThrow();
        expect(() => install.payload.decode(encodeCanonicalJson(null))).toThrow(/object/);
        expect(() =>
            FacetSlotCommandPayload.contribute({
                slot: new SlotName("slot"),
                ordinal: -1,
                value: null
            })
        ).toThrow(/ordinal/);
        expect(() =>
            FacetSlotCommandPayload.contribute({
                slot: new SlotName("slot"),
                ordinal: 1.5,
                value: null
            })
        ).toThrow(/ordinal/);
        for (const ordinal of ["zero", -1, 1.5]) {
            expect(() =>
                contribute.payload.decode(
                    encodeCanonicalJson({
                        ordinal,
                        slot: "slot",
                        value: null
                    } as never)
                )
            ).toThrow(/ordinal/);
        }
        for (const malformed of [
            null,
            {},
            { slot: "slot", ordinal: 0, value: null },
            { slot: new SlotName("slot"), ordinal: "zero", value: null },
            { slot: new SlotName("slot"), ordinal: -1, value: null },
            { slot: new SlotName("slot"), ordinal: 0, value: new Date() }
        ]) {
            expectAgentCoreError(
                () =>
                    contribute.execute(
                        backend,
                        envelope(contribute.command, target),
                        malformed as never,
                        decisionAt
                    ),
                "protocol.invalid-state"
            );
        }
        backend.provenanceAvailable = false;
        expect(
            contribute.authorize(backend, envelope(contribute.command, target), decodedEntry)
        ).toBe(false);
        expectAgentCoreError(
            () =>
                contribute.execute(
                    backend,
                    envelope(contribute.command, target),
                    decodedEntry,
                    decisionAt
                ),
            "authority.denied"
        );
    });
});

class Backend implements FacetSlotCommandBackend<Backend, Backend> {
    public revision = Revision.initial();
    public declaration: SlotDeclaration | undefined;
    public entries: SlotEntry[] = [];
    public installAllowed = true;
    public contributionAllowed = true;
    public changed = true;
    public provenanceAvailable = true;
    public provenanceFacet = new FacetRef("workspace:facet");

    public currentRevision(): Revision {
        return this.revision;
    }

    public permitsInstall(): boolean {
        return this.installAllowed;
    }

    public permitsContribution(): boolean {
        return this.contributionAllowed;
    }

    public prepareContribution(
        _read: Backend,
        _envelope: CommandEnvelope
    ): { readonly reference: PackageInstallationRef; readonly stamp: object } | undefined {
        return this.provenanceAvailable
            ? {
                  reference: new PackageInstallationRef(
                      this.provenanceFacet,
                      new FacetPackageId("package.facet")
                  ),
                  stamp: Object.freeze({})
              }
            : undefined;
    }

    public applyContribution(
        _transaction: Backend,
        _envelope: CommandEnvelope,
        _stamp: object,
        candidate: SlotEntry
    ): boolean {
        if (!candidate.contributor.equals(this.provenanceFacet)) {
            throw new TypeError("provenance changed");
        }
        this.entries.push(candidate);
        return this.changed;
    }

    public slot(_read: Backend, name: SlotName): SlotDeclaration | undefined {
        return this.declaration?.name.equals(name) === true ? this.declaration : undefined;
    }

    public install(_transaction: Backend, declaration: SlotDeclaration): boolean {
        this.declaration = declaration;
        return this.changed;
    }

    public advanceRevision(_transaction: Backend, expected: Revision): Revision {
        if (!this.revision.equals(expected)) throw new TypeError("revision mismatch");
        this.revision = this.revision.next();
        return this.revision;
    }
}

interface SlotState {
    revision: Revision;
    slots: Map<string, SlotDeclaration>;
    entries: Map<string, SlotEntry>;
}

class MutableInstallationProvenance<State = SlotState> extends PackageInstallationProvenancePort<
    State,
    CommandEnvelope
> {
    public constructor(public installation: AuthenticatedPackageInstallation | undefined) {
        super();
    }

    protected authenticatedInstallation(): AuthenticatedPackageInstallation | undefined {
        return this.installation;
    }
}

function slotStore<State extends SlotState = SlotState>(): WorkspaceSlotStore<State> {
    return {
        loadRevision: (state: State) => state.revision,
        saveRevision: (state: State, revision: Revision) => {
            state.revision = revision;
        },
        loadSlot: (state: State, name: SlotName) => state.slots.get(name.value),
        insertSlot: (state: State, declaration: SlotDeclaration) => {
            state.slots.set(declaration.name.value, declaration);
        },
        loadEntry: (state: State, id: SlotEntry["id"]) => state.entries.get(id.value),
        listEntries: (state: State, name: SlotName) =>
            [...state.entries.values()].filter((candidate) => candidate.slot.equals(name)),
        insertEntry: (state: State, candidate: SlotEntry) => {
            state.entries.set(candidate.id.value, candidate);
        }
    } as unknown as WorkspaceSlotStore<State>;
}

interface ClosedSlotView {
    revision: number;
    slots: Map<string, Uint8Array>;
    entries: Map<string, Uint8Array>;
}

interface ClosedSlotState extends ClosedSlotView {
    records: MemoryProtocolRecords;
    nextId: number;
}

function closedSlotFixture(
    installedFacet: string,
    allowedFacet: string
): {
    dispatch(payload: Uint8Array, key: string): Promise<CommandDispatchResult>;
    entries(): readonly SlotEntry[];
} {
    const tenant = new TenantId("tenant");
    const target = actor("closed-slot-workspace");
    const declaration = new SlotDeclaration(
        new SlotName("dashboard.card"),
        new JsonSchema({
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: { title: { type: "string" } }
        }),
        new SlotAuthorityPolicy([allowedFacet], ["binding:dashboard.read"])
    );
    const store = new MemoryActorStore<ClosedSlotState>(
        {
            revision: 0,
            slots: new Map([[declaration.name.value, SlotDeclaration.encode(declaration)]]),
            entries: new Map(),
            records: new MemoryProtocolRecords(),
            nextId: 0
        },
        cloneClosedSlotState
    );
    const slots = closedSlotStore();
    const provenance = new MutableInstallationProvenance<ClosedSlotState | ClosedSlotView>(
        installation(1, installedFacet)
    );
    const backend = new ProvenanceFacetSlotBackend<ClosedSlotState, ClosedSlotView>(
        slots,
        provenance,
        {
            permitsInstall: () => true,
            permitsContribution: (state, entry) => {
                const bytes = state.slots.get(entry.slot.value);
                return (
                    bytes !== undefined &&
                    SlotDeclaration.decode(bytes).authority.contribute.includes(
                        entry.contributor.value
                    )
                );
            }
        },
        {
            revision: (state) => new Revision(state.revision),
            slot: (state, name) => {
                const bytes = state.slots.get(name.value);
                return bytes === undefined ? undefined : SlotDeclaration.decode(bytes);
            }
        }
    );
    const dispatcher = createClosedCommandDispatcher({
        store,
        persistence: new MemoryProtocolPersistence((state: ClosedSlotState) => state.records),
        ids: new CounterIds((state: ClosedSlotState, prefix) => {
            state.nextId += 1;
            return `${prefix}-${state.nextId}`;
        }),
        actor: target,
        tenant,
        readOnly: (state: ClosedSlotState) => ({
            revision: state.revision,
            slots: new Map([...state.slots].map(([key, bytes]) => [key, bytes.slice()])),
            entries: new Map([...state.entries].map(([key, bytes]) => [key, bytes.slice()]))
        }),
        commands: {
            facets: [
                new FacetSlotContributeCommand(backend, target) as unknown as ProtocolCommand<
                    ClosedSlotState,
                    ClosedSlotView
                >
            ]
        },
        limits: { envelopeBytes: 16_384, payloadBytes: 16_384 },
        now: () => decisionAt
    });
    const content = new CounterContentStore(() => undefined);
    const ingress = new CommandIngress({
        dispatcher,
        content,
        authenticator: new CounterAuthenticator(tenant),
        leaseForMilliseconds: 1_000,
        now: () => decisionAt
    });
    return {
        async dispatch(payload, key) {
            const digest = Digest.sha256(payload);
            const ref = ContentRef.fromDigest(digest);
            content.install(ref.value, payload);
            const raw = CommandEnvelopeCodec.encode(
                new CommandEnvelope({
                    command: FACET_SLOT_COMMANDS.contribute,
                    caller: caller(target),
                    idempotencyKey: key,
                    expectedRevision: Revision.initial(),
                    payload: ref,
                    payloadDigest: digest
                })
            );
            const result = await ingress.accept(raw, caller(target));
            if (result.kind === "preDispatchFailure") throw result.cause;
            return result;
        },
        entries: () =>
            [...store.snapshot().state.entries.values()].map((bytes) => SlotEntry.decode(bytes))
    };
}

function closedSlotStore(): WorkspaceSlotStore<ClosedSlotState> {
    return {
        loadRevision: (state: ClosedSlotState) => new Revision(state.revision),
        saveRevision: (state: ClosedSlotState, revision: Revision) => {
            state.revision = revision.value;
        },
        loadSlot: (state: ClosedSlotState, name: SlotName) => {
            const bytes = state.slots.get(name.value);
            return bytes === undefined ? undefined : SlotDeclaration.decode(bytes);
        },
        insertSlot: (state: ClosedSlotState, candidate: SlotDeclaration) => {
            state.slots.set(candidate.name.value, SlotDeclaration.encode(candidate));
        },
        loadEntry: (state: ClosedSlotState, id: SlotEntry["id"]) => {
            const bytes = state.entries.get(id.value);
            return bytes === undefined ? undefined : SlotEntry.decode(bytes);
        },
        listEntries: (state: ClosedSlotState, name: SlotName) =>
            [...state.entries.values()]
                .map((bytes) => SlotEntry.decode(bytes))
                .filter((candidate) => candidate.slot.equals(name)),
        insertEntry: (state: ClosedSlotState, candidate: SlotEntry) => {
            state.entries.set(candidate.id.value, SlotEntry.encode(candidate));
        }
    } as unknown as WorkspaceSlotStore<ClosedSlotState>;
}

function cloneClosedSlotState(state: ClosedSlotState): ClosedSlotState {
    return {
        revision: state.revision,
        slots: new Map([...state.slots].map(([key, bytes]) => [key, bytes.slice()])),
        entries: new Map([...state.entries].map(([key, bytes]) => [key, bytes.slice()])),
        records: state.records.clone(),
        nextId: state.nextId
    };
}

function actor(id: string): ActorRef {
    return new ActorRef("workspace", new ActorId(id));
}

function caller(value: ActorRef): CommandCaller {
    return { kind: "actor", actor: value };
}

function envelope(
    command: string,
    target: ActorRef,
    revision = Revision.initial()
): CommandEnvelope {
    const digest = Digest.sha256(new Uint8Array());
    return new CommandEnvelope({
        command,
        caller: caller(target),
        idempotencyKey: `${command}:key`,
        expectedRevision: revision,
        payload: ContentRef.fromDigest(digest),
        payloadDigest: digest
    });
}

function envelopeWithoutRevision(command: string, target: ActorRef): CommandEnvelope {
    const digest = Digest.sha256(new Uint8Array());
    return new CommandEnvelope({
        command,
        caller: caller(target),
        idempotencyKey: `${command}:without-revision`,
        payload: ContentRef.fromDigest(digest),
        payloadDigest: digest
    });
}

function slot(): SlotDeclaration {
    return new SlotDeclaration(
        new SlotName("dashboard.card"),
        new JsonSchema({ type: "object" }),
        new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"])
    );
}

function entry(): SlotEntry {
    return SlotEntry.create(new SlotName("dashboard.card"), "workspace:facet", 0, {
        title: "Card"
    });
}

function installation(
    generation: number,
    facet = "workspace:facet"
): AuthenticatedPackageInstallation {
    const digest = new Digest("a".repeat(64));
    return Object.freeze({
        package: new PackagePin(
            new PackageId("profile-package"),
            new SemVer("1.0.0"),
            digest,
            digest
        ),
        packageFacet: new FacetPackageId("package.facet"),
        facet: new FacetRef(facet),
        materialization: new ManagedOrigin({
            tenantId: new TenantId("tenant"),
            deploymentId: new DeploymentId("b".repeat(64)),
            attestationDigest: digest,
            blueprintDigest: digest,
            packageLockDigest: digest,
            configDigest: digest,
            generation
        })
    });
}

function contribution(candidate: SlotEntry): SlotContributionRequest {
    return {
        slot: candidate.slot,
        ordinal: candidate.ordinal,
        value: candidate.value
    };
}

function expectAgentCoreError(action: () => unknown, code: string): void {
    try {
        action();
        throw new TypeError("Expected AgentCoreError");
    } catch (error) {
        expect(error).toMatchObject({ code });
    }
}
