import { describe, expect, test } from "vitest";
import {
    ActorId,
    ActorRef,
    MemoryActorStore,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import { ProvenanceFacetSlotBackend, createClosedCommandDispatcher } from "../../src/composition";
import {
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import {
    DeploymentId,
    ManagedOrigin,
    PackageId,
    PackageInstallationProvenancePort,
    PackagePin,
    type AuthenticatedPackageInstallation
} from "../../src/definition";
import { PrincipalId, PrincipalRef, TenantId, WorkspaceId } from "../../src/identity";
import {
    ContributionAttribution,
    FacetPackageId,
    FacetRef,
    InstalledSlot,
    PackageInstallationRef,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    SlotWithdrawalSet,
    WorkspaceSlotStore,
    type SlotContributionOrigin
} from "../../src/facets";
import {
    FACET_SLOT_COMMANDS,
    CommandEnvelope,
    CommandEnvelopeCodec,
    CommandIngress,
    FacetSlotCommandPayload,
    FacetSlotContributeCommand,
    FacetSlotInstallCommand,
    FacetSlotWithdrawCommand,
    MemoryProtocolPersistence,
    MemoryProtocolRecords,
    type CommandCaller,
    type CommandDispatchResult,
    type FacetSlotCommandBackend,
    type SlotContributionRequest
} from "../../src/protocol";
import { CounterAuthenticator, CounterContentStore, CounterIds } from "./counter-fixture";

const decisionAt = new Date("2026-07-12T12:00:00.000Z");
const packagePin = new PackagePin(
    new PackageId("profile-package"),
    new SemVer("1.0.0"),
    new Digest("a".repeat(64)),
    new Digest("a".repeat(64))
);
const backendAttribution = new ContributionAttribution(
    new FacetRef("workspace:facet"),
    packagePin
);

function attributionFor(facet: string): ContributionAttribution {
    return new ContributionAttribution(new FacetRef(facet), packagePin);
}

describe("Facet Slot protocol commands", () => {
    test("requires the exact Workspace Actor and authority backend", { tags: "p0" }, () => {
        const target = actor("workspace");
        const foreign = actor("foreign");
        const backend = new Backend();
        const install = new FacetSlotInstallCommand(backend, target);
        const declaration = slot();
        const payload = install.payload.decode(FacetSlotCommandPayload.install(declaration.declaration));
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

    test("prepared contributions to an undeclared slot fail lifecycle closed", { tags: "p1" }, () => {
        const target = actor("workspace");
        const backend = new Backend();
        const contribute = new FacetSlotContributeCommand(backend, target);
        const decoded = contribute.payload.decode(
            FacetSlotCommandPayload.contribute(contribution(entry()))
        );
        const contributionEnvelope = envelope(FACET_SLOT_COMMANDS.contribute, target);

        expect(contribute.authorize(backend, contributionEnvelope, decoded)).toBe(true);
        expect(contribute.permitsLifecycle(backend, contributionEnvelope, decoded)).toBe(false);
    });

    test("contribution codec rejects non-canonical ordinals", { tags: "p2" }, () => {
        const contribute = new FacetSlotContributeCommand(new Backend(), actor("workspace"));
        for (const ordinal of ["-1", "1.5", '"1"']) {
            expect(() =>
                contribute.payload.decode(
                    new TextEncoder().encode(
                        `{"ordinal":${ordinal},"slot":"dashboard.card","value":{"title":"Card"}}`
                    )
                )
            ).toThrow(TypeError);
        }
    });

    test("installs and contributes under exact revision progression", { tags: "p1" }, () => {
        const target = actor("workspace");
        const backend = new Backend();
        const install = new FacetSlotInstallCommand(backend, target);
        const contribute = new FacetSlotContributeCommand(backend, target);
        const declaration = slot();
        const candidate = entry();

        const installEnvelope = envelope(FACET_SLOT_COMMANDS.install, target, new Revision(0));
        const decodedInstall = install.payload.decode(
            FacetSlotCommandPayload.install(declaration.declaration)
        );
        expect(install.authorize(backend, installEnvelope, decodedInstall)).toBe(true);
        const installReply = install.execute(backend, installEnvelope, decodedInstall, decisionAt);
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

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] retires a Facet's contributions through one administer control transaction",
        { tags: "p0" },
        () => {
            const target = actor("workspace");
            const backend = new Backend();
            const withdraw = new FacetSlotWithdrawCommand(backend, target);
            backend.declaration = slot();
            backend.entries = [entry()];
            const payload = withdraw.payload.decode(
                FacetSlotCommandPayload.withdraw(new FacetRef("workspace:facet"))
            );
            const withdrawalEnvelope = envelope(withdraw.command, target, Revision.initial());

            expect(withdraw.caller.admits(caller(actor("foreign")))).toBe(false);
            expect(withdraw.authorize(backend, withdrawalEnvelope, payload)).toBe(true);
            expect(withdraw.permitsLifecycle(backend, withdrawalEnvelope, payload)).toBe(true);
            expect(
                withdraw.currentLease(backend, withdrawalEnvelope, payload, decisionAt)
            ).toBeUndefined();
            expect(withdraw.currentRevision(backend, withdrawalEnvelope, payload).value).toBe(0);
            expect(
                backend
                    .withdrawalSet(backend, new FacetRef("workspace:facet"))
                    .entries.map((id) => id.value)
            ).toEqual([entry().id.value]);

            const reply = withdraw.execute(backend, withdrawalEnvelope, payload, decisionAt);
            expect(reply.reply.revision.value).toBe(1);
            expect(backend.entries).toEqual([]);

            backend.withdrawalAllowed = false;
            expect(withdraw.authorize(backend, envelope(withdraw.command, target), payload)).toBe(
                false
            );
            expect(
                () =>
                    new FacetSlotWithdrawCommand(
                        backend,
                        new ActorRef("tenant", new ActorId("tenant"))
                    )
            ).toThrow(/Workspace/);
            expect(() =>
                withdraw.payload.decode(
                    encodeCanonicalJson({ contributor: "workspace:facet", extra: true })
                )
            ).toThrow(/unknown fields/);
            expect(() => withdraw.payload.decode(encodeCanonicalJson({ contributor: 1 }))).toThrow(
                /Slot withdrawal contributor/
            );
            expectAgentCoreError(
                () =>
                    withdraw.execute(
                        backend,
                        envelope(withdraw.command, target),
                        forgedContributor({}),
                        decisionAt
                    ),
                "protocol.invalid-state"
            );
        }
    );

    test("[C13-ADV-UNAUTHORIZED-SLOT] strictly decodes payloads and denies unauthorized contributions", { tags: "p0" }, () => {
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

    test("[C13-FACET-SLOT-AUTHORITY] derives contributor provenance and enforces Slot authority through the closed authenticated dispatcher", { tags: "p0" }, async () => {
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
        expect(observation.attribution.contributor.value).toBe("workspace:trusted");
        expect(
            admitted.entries().map((candidate) => candidate.attribution.contributor.value)
        ).toEqual(["workspace:trusted"]);

        const denied = closedSlotFixture("workspace:untrusted", "workspace:trusted");
        const rejected = await denied.dispatch(payload, "untrusted-contribution");
        expect(rejected.outcome).toBe("rejectedAuthority");
        expect(rejected.observation).toBeUndefined();
        expect(denied.entries()).toEqual([]);
    });

    test("atomically rejects payload, authority, and installation provenance substitution", { tags: "p0" }, () => {
        const target = actor("workspace");
        const declaration = slot();
        const state: SlotState = {
            revision: new Revision(1),
            slots: new Map([[declaration.declaration.name.value, declaration]]),
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
                permitsContribution: () => contributionAllowed,
                permitsWithdrawal: () => true
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
            declaration.declaration.name.value,
            new InstalledSlot(
                new SlotDeclaration(
                    declaration.declaration.name,
                    new JsonSchema({ type: "null" }),
                    declaration.declaration.authority
                ),
                declaration.attribution
            )
        );
        expect(() => command.execute(state, schemaEnvelope, request, decisionAt)).toThrow(
            /entry schema/
        );

        expect(state.entries.size).toBe(0);
        expect(state.revision.value).toBe(1);
    });

    test("strictly decodes typed replies without accepting revision coercion", { tags: "p1" }, () => {
        const command = new FacetSlotInstallCommand(new Backend(), actor("workspace"));
        const codec = command.replyCodec!;
        expect(codec.decode(codec.encode({ revision: new Revision(3) })).revision.value).toBe(3);
        const malformedReplies: readonly JsonValue[] = [
            null,
            {},
            { revision: 0, extra: true },
            { revision: "0" },
            { revision: -1 },
            { revision: 1.5 }
        ];
        for (const malformed of malformedReplies) {
            expect(() => codec.decode(encodeCanonicalJson(malformed))).toThrow(TypeError);
        }
        expect(() =>
            command.payload.decode(encodeCanonicalJson({ record: "AA==", extra: true }))
        ).toThrow(/unknown fields/);
    });

    test("covers malformed protocol state, lifecycle denial, foreign callers, and install no-ops", { tags: "p1" }, () => {
        const target = actor("workspace");
        const foreign = actor("foreign");
        const backend = new Backend();
        const install = new FacetSlotInstallCommand(backend, target);
        const contribute = new FacetSlotContributeCommand(backend, target);
        const declaration = slot();
        const decodedDeclaration = install.payload.decode(
            FacetSlotCommandPayload.install(declaration.declaration)
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
        backend.declaration = new InstalledSlot(
            new SlotDeclaration(
                new SlotName("dashboard.card"),
                new JsonSchema({ type: "null" }),
                new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"])
            ),
            backendAttribution
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
                    forgedDeclaration({}),
                    decisionAt
                ),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () =>
                contribute.execute(
                    backend,
                    envelope(contribute.command, target),
                    forgedContribution({}),
                    decisionAt
                ),
            "protocol.invalid-state"
        );
        const unrevisioned = envelopeWithoutRevision(install.command, target);
        expect(install.authorize(backend, unrevisioned, decodedDeclaration)).toBe(true);
        expectAgentCoreError(
            () => install.execute(backend, unrevisioned, decodedDeclaration, decisionAt),
            "protocol.revision-conflict"
        );

        backend.changed = false;
        const noOpInstall = envelope(install.command, target);
        expect(install.authorize(backend, noOpInstall, decodedDeclaration)).toBe(true);
        const reply = install.execute(backend, noOpInstall, decodedDeclaration, decisionAt);
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
                    encodeCanonicalJson({ ordinal, slot: "slot", value: null })
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
                        forgedContribution(malformed),
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

test("facet slot reply codec accepts boundary revisions exactly", { tags: "p1" }, () => {
    const command = new FacetSlotInstallCommand(new Backend(), actor("workspace"));
    const codec = command.replyCodec;

    expect(codec.decode(codec.encode({ revision: new Revision(0) })).revision.value).toBe(0);
    expect(() => codec.decode(encodeCanonicalJson(null))).toThrow(
        "Facet Slot command reply must be an object"
    );
    expect(() => codec.decode(encodeCanonicalJson({}))).toThrow(
        "Facet Slot command reply contains missing or unknown fields"
    );
    expect(() => codec.decode(encodeCanonicalJson({ revision: -1 }))).toThrow(
        "Facet Slot command reply revision is invalid"
    );

    const declaration = slot();
    const observationCodec = command.observationCodec;
    if (observationCodec === undefined) throw new TypeError("Expected an observation codec");
    expect(observationCodec.encode(declaration)).toEqual(InstalledSlot.encode(declaration));
    expect(
        observationCodec
            .decode(observationCodec.encode(declaration))
            .declaration.name.equals(declaration.declaration.name)
    ).toBe(true);
});

test("slot payload codecs name malformed values exactly", { tags: "p1" }, () => {
    const target = actor("workspace");
    const install = new FacetSlotInstallCommand(new Backend(), target);
    const contribute = new FacetSlotContributeCommand(new Backend(), target);

    expect(() => install.payload.decode(encodeCanonicalJson(null))).toThrow(
        "Slot install payload must be an object"
    );
    expect(() => install.payload.decode(encodeCanonicalJson({}))).toThrow(
        "Slot install payload contains missing or unknown fields"
    );
    expect(() => install.payload.decode(encodeCanonicalJson({ record: 1 }))).toThrow(
        "Slot declaration record must be a string"
    );

    expect(() => contribute.payload.decode(encodeCanonicalJson(null))).toThrow(
        "Slot contribution payload must be an object"
    );
    expect(() => contribute.payload.decode(encodeCanonicalJson({}))).toThrow(
        "Slot contribution payload contains missing or unknown fields"
    );
    expect(() =>
        contribute.payload.decode(encodeCanonicalJson({ ordinal: 0, slot: 5, value: null }))
    ).toThrow("Slot contribution slot must be a string");
    expect(() =>
        contribute.payload.decode(
            encodeCanonicalJson({ ordinal: -1, slot: "dashboard.card", value: null })
        )
    ).toThrow("Slot contribution ordinal must be a non-negative safe integer");
    const boundary = contribute.payload.decode(
        encodeCanonicalJson({ ordinal: 0, slot: "dashboard.card", value: { title: "Card" } })
    );
    expect(boundary.ordinal).toBe(0);
    expect(boundary.slot.value).toBe("dashboard.card");

    expectAgentCoreError(
        () =>
            FacetSlotCommandPayload.contribute({
                slot: new SlotName("dashboard.card"),
                ordinal: -1,
                value: null
            }),
        "protocol.invalid-state"
    );
});

test("contribution lifecycle admits only the authorized exact entry", { tags: "p0" }, () => {
    const target = actor("workspace");
    const backend = new Backend();
    backend.declaration = slot();
    const contribute = new FacetSlotContributeCommand(backend, target);
    const decoded = contribute.payload.decode(
        FacetSlotCommandPayload.contribute(contribution(entry()))
    );
    const commandEnvelope = envelope(contribute.command, target);

    expect(contribute.authorize(backend, commandEnvelope, decoded)).toBe(true);
    expect(contribute.permitsLifecycle(backend, commandEnvelope, decoded)).toBe(true);

    const sameLength = { slot: decoded.slot, ordinal: decoded.ordinal, value: { title: "Dard" } };
    expect(contribute.permitsLifecycle(backend, commandEnvelope, sameLength)).toBe(false);
    const longer = {
        slot: decoded.slot,
        ordinal: decoded.ordinal,
        value: { title: "A longer substituted title" }
    };
    expect(contribute.permitsLifecycle(backend, commandEnvelope, longer)).toBe(false);
});

interface BackendContributionStamp {
    readonly facet: FacetRef;
}

class Backend implements FacetSlotCommandBackend<Backend, Backend> {
    public revision = Revision.initial();
    public declaration: InstalledSlot | undefined;
    public entries: SlotEntry[] = [];
    public installAllowed = true;
    public contributionAllowed = true;
    public withdrawalAllowed = true;
    public changed = true;
    public provenanceAvailable = true;
    public provenanceAttribution = backendAttribution;

    public currentRevision(): Revision {
        return this.revision;
    }

    public permitsInstall(): boolean {
        return this.installAllowed;
    }

    public permitsContribution(): boolean {
        return this.contributionAllowed;
    }

    public permitsWithdrawal(): boolean {
        return this.withdrawalAllowed;
    }

    public withdrawalSet(_read: Backend, contributor: FacetRef): SlotWithdrawalSet {
        return new SlotWithdrawalSet(
            contributor,
            this.declaration !== undefined &&
            this.declaration.attribution.contributor.equals(contributor)
                ? [this.declaration.declaration.name]
                : [],
            this.entries
                .filter((candidate) => candidate.attribution.contributor.equals(contributor))
                .map((candidate) => candidate.id)
        );
    }

    public applyWithdrawal(_transaction: Backend, contributor: FacetRef): boolean {
        const before = this.entries.length;
        this.entries = this.entries.filter(
            (candidate) => !candidate.attribution.contributor.equals(contributor)
        );
        return this.changed && this.entries.length !== before;
    }

    public prepareContribution(
        _read: Backend,
        _envelope: CommandEnvelope
    ):
        | { readonly reference: PackageInstallationRef; readonly stamp: BackendContributionStamp }
        | undefined {
        return this.provenanceAvailable
            ? {
                  reference: new PackageInstallationRef(
                      this.provenanceAttribution,
                      new FacetPackageId("package.facet")
                  ),
                  stamp: Object.freeze({ facet: this.provenanceAttribution.contributor })
              }
            : undefined;
    }

    public applyContribution(
        _transaction: Backend,
        _envelope: CommandEnvelope,
        _stamp: BackendContributionStamp,
        candidate: SlotEntry
    ): boolean {
        if (!candidate.attribution.equals(this.provenanceAttribution)) {
            throw new TypeError("provenance changed");
        }
        this.entries.push(candidate);
        return this.changed;
    }

    public slot(_read: Backend, name: SlotName): InstalledSlot | undefined {
        return this.declaration?.declaration.name.equals(name) === true
            ? this.declaration
            : undefined;
    }

    public applyInstall(
        _transaction: Backend,
        _envelope: CommandEnvelope,
        _stamp: BackendContributionStamp,
        candidate: InstalledSlot
    ): boolean {
        if (!candidate.attribution.equals(this.provenanceAttribution)) {
            throw new TypeError("provenance changed");
        }
        this.declaration = candidate;
        return this.changed;
    }

    public advanceRevision(_transaction: Backend, expected: Revision): Revision {
        if (!this.revision.equals(expected)) throw new TypeError("revision mismatch");
        this.revision = this.revision.next();
        return this.revision;
    }
}

const slotStoreOwner = new WorkspaceId("facet-commands-workspace");

interface SlotState {
    revision: Revision;
    slots: Map<string, InstalledSlot>;
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

/**
 * A real slot store over in-memory state. These tests drive its data methods with a transaction
 * they already hold, so its transactional entry points are never reached; implementing the class
 * rather than asserting an object literal into it keeps that difference visible.
 */
class TestSlotStore<State extends SlotState> extends WorkspaceSlotStore<State> {
    public override transaction<Result>(
        _operation: TransactionOperation<State, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        throw new TypeError("Slot store transactions are driven by the command under test");
    }

    public override loadRevision(state: State): Revision {
        return state.revision;
    }

    public override saveRevision(state: State, revision: Revision): void {
        state.revision = revision;
    }

    public override loadSlot(state: State, name: SlotName): InstalledSlot | undefined {
        return state.slots.get(name.value);
    }

    public override insertSlot(state: State, installed: InstalledSlot): void {
        state.slots.set(installed.declaration.name.value, installed);
    }

    public override retireSlot(state: State, name: SlotName): void {
        state.slots.delete(name.value);
    }

    public override listSlots(state: State): readonly InstalledSlot[] {
        return [...state.slots.values()];
    }

    public override loadEntry(state: State, id: SlotEntry["id"]): SlotEntry | undefined {
        return state.entries.get(id.value);
    }

    public override loadEntryAt(
        state: State,
        origin: SlotContributionOrigin
    ): SlotEntry | undefined {
        return [...state.entries.values()].find((candidate) => candidate.origin.equals(origin));
    }

    public override listEntries(state: State, name: SlotName): readonly SlotEntry[] {
        return [...state.entries.values()].filter((candidate) => candidate.slot.equals(name));
    }

    public override insertEntry(state: State, candidate: SlotEntry): void {
        state.entries.set(candidate.id.value, candidate);
    }

    public override listAllEntries(state: State): readonly SlotEntry[] {
        return [...state.entries.values()];
    }

    public override retireEntry(state: State, id: SlotEntry["id"]): void {
        state.entries.delete(id.value);
    }
}

function slotStore<State extends SlotState = SlotState>(): WorkspaceSlotStore<State> {
    return new TestSlotStore<State>(slotStoreOwner);
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

interface ClosedSlotHarness {
    dispatch(payload: Uint8Array, key: string): Promise<CommandDispatchResult>;
    entries(): readonly SlotEntry[];
}

function closedSlotFixture(installedFacet: string, allowedFacet: string): ClosedSlotHarness {
    const tenant = new TenantId("tenant");
    const target = actor("closed-slot-workspace");
    const declaration = new InstalledSlot(
        new SlotDeclaration(
            new SlotName("dashboard.card"),
            new JsonSchema({
                type: "object",
                additionalProperties: false,
                required: ["title"],
                properties: { title: { type: "string" } }
            }),
            new SlotAuthorityPolicy([allowedFacet], ["binding:dashboard.read"])
        ),
        attributionFor(installedFacet)
    );
    const store = new MemoryActorStore<ClosedSlotState>(
        {
            revision: 0,
            slots: new Map([
                [declaration.declaration.name.value, InstalledSlot.encode(declaration)]
            ]),
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
                    InstalledSlot.decode(bytes).declaration.authority.contribute.includes(
                        entry.attribution.contributor.value
                    )
                );
            },
            permitsWithdrawal: () => true
        },
        {
            revision: (state) => new Revision(state.revision),
            slot: (state, name) => {
                const bytes = state.slots.get(name.value);
                return bytes === undefined ? undefined : InstalledSlot.decode(bytes);
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
            facets: [new FacetSlotContributeCommand(backend, target)]
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

/** The closed-slot variant keeps its records encoded, the way a substrate store does. */
class ClosedTestSlotStore extends WorkspaceSlotStore<ClosedSlotState> {
    public override transaction<Result>(
        _operation: TransactionOperation<ClosedSlotState, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        throw new TypeError("Slot store transactions are driven by the dispatcher under test");
    }

    public override loadRevision(state: ClosedSlotState): Revision {
        return new Revision(state.revision);
    }

    public override saveRevision(state: ClosedSlotState, revision: Revision): void {
        state.revision = revision.value;
    }

    public override loadSlot(state: ClosedSlotState, name: SlotName): InstalledSlot | undefined {
        const bytes = state.slots.get(name.value);
        return bytes === undefined ? undefined : InstalledSlot.decode(bytes);
    }

    public override insertSlot(state: ClosedSlotState, candidate: InstalledSlot): void {
        state.slots.set(candidate.declaration.name.value, InstalledSlot.encode(candidate));
    }

    public override retireSlot(state: ClosedSlotState, name: SlotName): void {
        state.slots.delete(name.value);
    }

    public override listSlots(state: ClosedSlotState): readonly InstalledSlot[] {
        return [...state.slots.values()].map((bytes) => InstalledSlot.decode(bytes));
    }

    public override loadEntry(
        state: ClosedSlotState,
        id: SlotEntry["id"]
    ): SlotEntry | undefined {
        const bytes = state.entries.get(id.value);
        return bytes === undefined ? undefined : SlotEntry.decode(bytes);
    }

    public override loadEntryAt(
        state: ClosedSlotState,
        origin: SlotContributionOrigin
    ): SlotEntry | undefined {
        return [...state.entries.values()]
            .map((bytes) => SlotEntry.decode(bytes))
            .find((candidate) => candidate.origin.equals(origin));
    }

    public override listEntries(state: ClosedSlotState, name: SlotName): readonly SlotEntry[] {
        return [...state.entries.values()]
            .map((bytes) => SlotEntry.decode(bytes))
            .filter((candidate) => candidate.slot.equals(name));
    }

    public override insertEntry(state: ClosedSlotState, candidate: SlotEntry): void {
        state.entries.set(candidate.id.value, SlotEntry.encode(candidate));
    }

    public override listAllEntries(state: ClosedSlotState): readonly SlotEntry[] {
        return [...state.entries.values()].map((bytes) => SlotEntry.decode(bytes));
    }

    public override retireEntry(state: ClosedSlotState, id: SlotEntry["id"]): void {
        state.entries.delete(id.value);
    }
}

function closedSlotStore(): WorkspaceSlotStore<ClosedSlotState> {
    return new ClosedTestSlotStore(slotStoreOwner);
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

function slot(): InstalledSlot {
    return new InstalledSlot(declaration(), backendAttribution);
}

function declaration(): SlotDeclaration {
    return new SlotDeclaration(
        new SlotName("dashboard.card"),
        new JsonSchema({ type: "object" }),
        new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"])
    );
}

function entry(): SlotEntry {
    return new SlotEntry(new SlotName("dashboard.card"), backendAttribution, 0, {
        title: "Card"
    });
}

function installation(
    generation: number,
    facet = "workspace:facet"
): AuthenticatedPackageInstallation {
    const digest = new Digest("a".repeat(64));
    return Object.freeze({
        package: packagePin,
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

/**
 * A contribution request the command's payload codec never produced. The command re-checks that
 * its request came from its own decoder before acting on it, and that check is what these callers
 * assert on.
 */
function forgedDeclaration<TActual>(value: TActual): SlotDeclaration {
    // SAFETY: not a decoded SlotDeclaration. The install command must refuse it as an invalid
    // state rather than install a slot whose schema and authority it never validated.
    return value as TActual & SlotDeclaration;
}

function forgedContributor<TActual>(value: TActual): FacetRef {
    // SAFETY: not a decoded FacetRef. The withdrawal command must refuse it as an invalid
    // state rather than compute a withdrawal set from an unvalidated contributor.
    return value as TActual & FacetRef;
}

function forgedContribution<TActual>(value: TActual): SlotContributionRequest {
    // SAFETY: not a decoded SlotContributionRequest — either absent, or carrying a slot name,
    // ordinal, or value the codec would have rejected. The command must refuse it as an invalid
    // state rather than contribute an entry it never validated.
    return value as TActual & SlotContributionRequest;
}

function expectAgentCoreError(action: () => void, code: string): void {
    try {
        action();
        throw new TypeError("Expected AgentCoreError");
    } catch (error) {
        expect(error).toMatchObject({ code });
    }
}
