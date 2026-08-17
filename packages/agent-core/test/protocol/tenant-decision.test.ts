import { expect, test } from "vitest";
import { Revision } from "../../src/core";
import type { AuditRecord } from "../../src/invocations";
import type { CommandIngressResult } from "../../src/protocol/ingress";
import type { CommandOutcome } from "../../src/protocol/write";
import {
    TenantDecisionPath,
    authorityActor,
    decisionHostLabels,
    decisionPathTenant,
    decodeAppliedEffectReply,
    decodeBridgedDecision,
    requireObservation,
    requireOutcome,
    requireWrite,
    targetActor,
    type DecisionPathActor,
    type EvidenceView
} from "./tenant-decision-fixture";

/**
 * Every outcome §8.5 declares, and the set the completeness assertion below is measured
 * against.
 *
 * `outcomeSetsAgree` is a COMPILE-TIME TRIPWIRE, not a runtime witness: it resolves to `never`
 * and fails typecheck if this list and `CommandOutcome` stop agreeing in either direction, but
 * the suite transpiles without typechecking, so no mutation of `CommandOutcome` can make the
 * `expect` below go red. It is here so the list cannot silently stop being the declared set —
 * it is not evidence for any atom, and no row cites `CommandOutcome` on the strength of it.
 */
const declaredOutcomes = [
    "committed",
    "duplicate",
    "rejectedAuthentication",
    "rejectedAuthority",
    "rejectedLease",
    "rejectedLifecycle",
    "rejectedMalformed",
    "rejectedRevision"
] as const;

type DeclaredOutcome = (typeof declaredOutcomes)[number];

type OutcomeSetsAgree =
    Exclude<CommandOutcome, DeclaredOutcome> extends never
        ? Exclude<DeclaredOutcome, CommandOutcome> extends never
            ? true
            : never
        : never;

const outcomeSetsAgree: OutcomeSetsAgree = true;

/** The boundaries at which a decision's effect and its evidence could come apart. */
const evidenceBoundaries = ["mutation", "writeAudit", "writeRecord"] as const;

test.each(decisionHostLabels)(
    "[C13-PROTOCOL-ATOMIC-EVIDENCE] (%s) an effect that lands without its linked evidence is refused",
    { tags: "p0" },
    async (label) => {
        const committed = TenantDecisionPath.create(label);
        const granted = await committed.traverse({ permit: "atomic-permit", grant: true });
        const write = requireWrite(granted.delivery);
        const evidence = committed.target.evidence();
        const writeAudit = auditById(evidence, write.audit.value);

        // The decision is the Tenant Actor's record and the effect is the Run Actor's; neither
        // Actor holds a second copy of the other's.
        expect(committed.authority.ownedRecords()).toEqual([
            {
                kind: "permitDecision",
                id: granted.bridged.decision,
                permit: "atomic-permit",
                granted: true
            }
        ]);
        expect(committed.target.ownedRecords()).toEqual([
            {
                kind: "appliedEffect",
                id: decodeAppliedEffectReply(write.reply).effect,
                permit: "atomic-permit",
                origin: granted.bridged.decision
            }
        ]);

        // The effect and its evidence name each other through preallocated ids.
        expect({
            outcome: requireOutcome(granted.delivery),
            auditPresent: writeAudit !== undefined,
            auditKind: writeAudit?.kind.kind,
            auditNamesWrite:
                writeAudit?.kind.kind === "write" && writeAudit.kind.id.equals(write.id),
            auditOutcome: writeAudit?.kind.kind === "write" ? writeAudit.kind.outcome : undefined,
            committedWrites: committedWrites(evidence).length,
            effects: committed.target.ownedRecords().length
        }).toEqual({
            outcome: "committed",
            auditPresent: true,
            auditKind: "write",
            auditNamesWrite: true,
            auditOutcome: "committed",
            committedWrites: 1,
            effects: 1
        });

        // Every boundary at which the mutation could outlive its evidence, collected before any
        // assertion so one run describes the whole shape rather than its first edge.
        const refusals = [];
        for (const boundary of evidenceBoundaries) {
            const host = TenantDecisionPath.create(label);
            const decision = await host.decide({ permit: "atomic-permit", grant: true });
            const bridged = decodeBridgedDecision(requireObservation(decision.result));
            const envelope = host.bridge(bridged);
            host.target.setFault(boundary);
            const delivery = await host.deliver(envelope);
            host.target.setFault(undefined);
            host.target.verifyRecordGraph();
            const failedEvidence = host.target.evidence();
            refusals.push({
                boundary,
                kind: delivery.kind,
                commit: delivery.kind === "preDispatchFailure" ? delivery.commit : undefined,
                effects: host.target.ownedRecords().length,
                revision: host.target.revision().value,
                writes: failedEvidence.writes.length,
                audits: failedEvidence.audits.length,
                committedWrites: committedWrites(failedEvidence).length
            });
        }

        expect(refusals).toEqual(
            evidenceBoundaries.map((boundary) => ({
                boundary,
                kind: "preDispatchFailure",
                commit: "rolledBack",
                effects: 0,
                revision: 0,
                writes: 0,
                audits: 0,
                committedWrites: 0
            }))
        );

        // The other direction: evidence for a decision that deliberately mutated nothing. The
        // count of committed writes tracks the count of effects, never the count of requests.
        const denied = TenantDecisionPath.create(label);
        const refused = await denied.traverse({ permit: "denied-permit", grant: false });
        const deniedEvidence = denied.target.evidence();
        expect({
            outcome: requireOutcome(refused.delivery),
            effects: denied.target.ownedRecords().length,
            writes: deniedEvidence.writes.length,
            committedWrites: committedWrites(deniedEvidence).length,
            authorityDecisions: denied.authority.ownedRecords().length
        }).toEqual({
            outcome: "rejectedAuthority",
            effects: 0,
            writes: 1,
            committedWrites: 0,
            authorityDecisions: 1
        });
    }
);

test.each(decisionHostLabels)(
    "[C13-PROTOCOL-DUPLICATE] (%s) a redelivered cross-Actor command replays the recorded outcome with exactly one effect and a distinguishable audit entry",
    { tags: "p0" },
    async (label) => {
        const path = TenantDecisionPath.create(label);
        const first = await path.traverse({ permit: "duplicate-permit", grant: true });
        const original = requireWrite(first.delivery);
        const effectsAfterFirst = path.target.ownedRecords();
        const revisionAfterFirst = path.target.revision().value;

        // Flip every gate that runs after the duplicate lookup. A redelivery that re-ran any of
        // them would answer rejectedAuthority, rejectedLifecycle or rejectedRevision instead —
        // the envelope's expectedRevision is already stale now that the first effect committed.
        path.target.setOpen(false);
        path.target.setLifecycle(false);

        // Read the delivery tolerantly. A dispatcher that stops replaying the recorded outcome
        // fails this in several different ways, and each must surface as the fact that differs
        // rather than as a throw from a helper that assumed the happy shape.
        const replayed = await path.deliver(first.envelope);
        const replay = replayed.kind === "commandOutcome" ? replayed.write : undefined;
        const evidence = path.target.evidence();
        const replayAudit =
            replay === undefined ? undefined : auditById(evidence, replay.audit.value);
        const originalAudit = auditById(evidence, original.audit.value);

        expect({
            outcome: outcomeOf(replayed),
            replyBytes: replay?.reply,
            replyNamesFirstEffect: appliedEffectOf(replay?.reply),
            effects: path.target.ownedRecords(),
            revision: path.target.revision().value,
            writeIdIsDistinct: replay?.id.value !== original.id.value,
            namesOriginalWrite: replay?.duplicateOf?.value,
            auditIdIsDistinct: replay?.audit.value !== original.audit.value,
            replayAuditOutcome:
                replayAudit?.kind.kind === "write" ? replayAudit.kind.outcome : undefined,
            originalAuditOutcome:
                originalAudit?.kind.kind === "write" ? originalAudit.kind.outcome : undefined,
            writes: evidence.writes.map((record) => record.outcome),
            committedWrites: committedWrites(evidence).length
        }).toEqual({
            outcome: "duplicate",
            replyBytes: original.reply,
            replyNamesFirstEffect: effectsAfterFirst[0]?.id,
            effects: effectsAfterFirst,
            revision: revisionAfterFirst,
            writeIdIsDistinct: true,
            namesOriginalWrite: original.id.value,
            auditIdIsDistinct: true,
            replayAuditOutcome: "duplicate",
            originalAuditOutcome: "committed",
            writes: ["committed", "duplicate"],
            committedWrites: 1
        });

        // At-least-once delivery with every gate left permissive, so a redelivery that ran the
        // mutation again would apply a second effect rather than be stopped by a closed gate.
        // The effect count and the Actor's revision are read from its own state, not from the
        // reply, because the reply is precisely what a silently absorbed duplicate reproduces.
        const repeated = TenantDecisionPath.create(label);
        const once = await repeated.traverse({ permit: "at-least-once", grant: true });
        const deliveries = [outcomeOf(once.delivery)];
        for (const _redelivery of [1, 2]) {
            deliveries.push(outcomeOf(await repeated.deliver(once.envelope)));
        }
        const repeatedEvidence = repeated.target.evidence();

        expect({
            deliveries,
            effects: repeated.target.ownedRecords().length,
            revision: repeated.target.revision().value,
            writes: repeatedEvidence.writes.map((record) => record.outcome),
            distinctWriteIds: new Set(repeatedEvidence.writes.map((record) => record.id.value))
                .size,
            distinctAuditIds: new Set(repeatedEvidence.writes.map((record) => record.audit.value))
                .size,
            duplicatesNameTheOriginal: repeatedEvidence.writes
                .filter((record) => record.outcome === "duplicate")
                .map((record) => record.duplicateOf?.value),
            committedWrites: committedWrites(repeatedEvidence)
        }).toEqual({
            deliveries: ["committed", "duplicate", "duplicate"],
            effects: 1,
            revision: 1,
            writes: ["committed", "duplicate", "duplicate"],
            distinctWriteIds: 3,
            distinctAuditIds: 3,
            duplicatesNameTheOriginal: [
                committedWrites(repeatedEvidence)[0],
                committedWrites(repeatedEvidence)[0]
            ],
            committedWrites: committedWrites(repeatedEvidence)
        });

        repeated.target.verifyRecordGraph();
        expect(unattributableAudits(repeatedEvidence)).toEqual([]);

        path.target.verifyRecordGraph();
        expect(unattributableAudits(evidence)).toEqual([]);
    }
);

interface OutcomeCase {
    readonly name: string;
    readonly expected: CommandOutcome;
    readonly decidedBy: "authority" | "target";
    run(path: TenantDecisionPath): Promise<CommandIngressResult>;
}

const outcomeCases: readonly OutcomeCase[] = [
    {
        name: "a granted decision applies the effect",
        expected: "committed",
        decidedBy: "target",
        run: async (path) => (await path.traverse({ permit: "case", grant: true })).delivery
    },
    {
        name: "a redelivered command is a duplicate",
        expected: "duplicate",
        decidedBy: "target",
        run: async (path) => {
            const first = await path.traverse({ permit: "case", grant: true });
            return path.deliver(first.envelope);
        }
    },
    {
        name: "a missing required expectedRevision is malformed",
        expected: "rejectedMalformed",
        decidedBy: "target",
        run: async (path) =>
            (
                await path.traverse({
                    permit: "case",
                    grant: true,
                    overrides: { omitRevision: true }
                })
            ).delivery
    },
    {
        name: "an undecodable envelope is malformed",
        expected: "rejectedMalformed",
        decidedBy: "target",
        run: (path) => path.deliver(Uint8Array.of(0xff, 0x00, 0xff))
    },
    {
        name: "an unexpected payload field is malformed",
        expected: "rejectedMalformed",
        decidedBy: "target",
        run: async (path) =>
            (
                await path.traverse({
                    permit: "case",
                    grant: true,
                    overrides: { unexpectedPayloadField: true }
                })
            ).delivery
    },
    {
        name: "a missing required lease token is a lease rejection",
        expected: "rejectedLease",
        decidedBy: "target",
        run: async (path) =>
            (await path.traverse({ permit: "case", grant: true, overrides: { omitLease: true } }))
                .delivery
    },
    {
        name: "a stale lease epoch is a lease rejection",
        expected: "rejectedLease",
        decidedBy: "target",
        run: async (path) =>
            (
                await path.traverse({
                    permit: "case",
                    grant: true,
                    overrides: {
                        lease: {
                            turn: path.currentLease.turn,
                            holder: path.currentLease.holder,
                            epoch: path.currentLease.epoch + 1
                        }
                    }
                })
            ).delivery
    },
    {
        name: "a forbidden lease token on the Tenant family is a lease rejection",
        expected: "rejectedLease",
        decidedBy: "authority",
        run: async (path) =>
            (await path.decide({ permit: "case", grant: true, lease: path.currentLease })).result
    },
    {
        name: "a denied decision is refused before any effect",
        expected: "rejectedAuthority",
        decidedBy: "target",
        run: async (path) => (await path.traverse({ permit: "case", grant: false })).delivery
    },
    {
        name: "a closed target lifecycle is refused",
        expected: "rejectedLifecycle",
        decidedBy: "target",
        run: async (path) => {
            path.target.setLifecycle(false);
            return (await path.traverse({ permit: "case", grant: true })).delivery;
        }
    },
    {
        name: "a stale expectedRevision is a revision rejection",
        expected: "rejectedRevision",
        decidedBy: "target",
        run: async (path) =>
            (
                await path.traverse({
                    permit: "case",
                    grant: true,
                    overrides: { expectedRevision: new Revision(41) }
                })
            ).delivery
    },
    {
        name: "a principal caller on an Actor-only family is unauthenticated",
        expected: "rejectedAuthentication",
        decidedBy: "target",
        run: async (path) => {
            const decision = await path.decide({ permit: "case", grant: true });
            const bridged = decodeBridgedDecision(requireObservation(decision.result));
            return path.deliver(path.bridge(bridged, { caller: path.caller }), path.caller);
        }
    }
];

interface OutcomeObservation {
    readonly case: string;
    readonly outcome: CommandOutcome;
    readonly writeOutcome: CommandOutcome;
    readonly decidingActor: string;
    readonly envelopeDigest: string;
    readonly callerKind: string | undefined;
    readonly idempotencyKey: string | undefined;
    readonly auditIsRoot: boolean;
    readonly ownedRecords: number;
}

test(
    "[C13-PROTOCOL-OUTCOMES] [actor-local-store] [protocol-persistence] two hosts decide every declared command outcome identically",
    { tags: "p0" },
    async () => {
        expect(outcomeSetsAgree).toBe(true);

        const observations = new Map<string, readonly OutcomeObservation[]>();
        for (const label of decisionHostLabels) {
            const collected: OutcomeObservation[] = [];
            for (const outcomeCase of outcomeCases) {
                const path = TenantDecisionPath.create(label);
                const result = await outcomeCase.run(path);
                const actor = outcomeCase.decidedBy === "authority" ? path.authority : path.target;
                collected.push(observe(outcomeCase.name, actor, result));
                actor.verifyRecordGraph();
                expect(unattributableAudits(actor.evidence())).toEqual([]);
            }
            observations.set(label, collected);
        }

        const memory = observations.get("memory") ?? [];
        const sqlite = observations.get("sqlite") ?? [];

        // Same command, same state: the two hosts agree case by case, including on the envelope
        // digest, so they are shown to have decided the same bytes rather than merely to have
        // produced the same labels.
        expect(sqlite).toEqual(memory);

        expect(memory.map((observation) => [observation.case, observation.outcome])).toEqual(
            outcomeCases.map((outcomeCase) => [outcomeCase.name, outcomeCase.expected])
        );

        // Every decision records its own outcome, and the traversal covers the complete declared
        // outcome set rather than a convenient subset of it.
        expect(memory.map((observation) => observation.writeOutcome)).toEqual(
            memory.map((observation) => observation.outcome)
        );
        expect([...new Set(memory.map((observation) => observation.outcome))].sort()).toEqual([
            ...declaredOutcomes
        ]);
    }
);

test.each(decisionHostLabels)(
    "[C13-PROTOCOL-REJECTION-ROOT] (%s) a cross-Actor rejection with no usable caller cause still produces an attributable host root",
    { tags: "p0" },
    async (label) => {
        // A rejection carrying no caller cause at all.
        const denied = TenantDecisionPath.create(label);
        const refused = await denied.traverse({ permit: "root-permit", grant: false });
        const write = requireWrite(refused.delivery);
        const evidence = denied.target.evidence();
        const root = auditById(evidence, write.audit.value);
        const decisionWrite = requireWrite(refused.decision.result);
        const decisionAudit = auditById(denied.authority.evidence(), decisionWrite.audit.value);

        expect({
            outcome: write.outcome,
            writes: evidence.writes.length,
            audits: evidence.audits.length,
            rootKind: root?.kind.kind,
            rootNamesWrite: root?.kind.kind === "write" && root.kind.id.equals(write.id),
            rootOutcome: root?.kind.kind === "write" ? root.kind.outcome : undefined,
            rootCause: root?.cause,
            rootActorKind: root?.actor.kind,
            rootIsTheDecidingHost: root?.actor.equals(targetActor),
            rootIsNotTheCaller: root?.actor.equals(authorityActor) === false,
            rootTenant: root?.tenant.value,
            correlationIsHostMinted:
                root !== undefined &&
                decisionAudit !== undefined &&
                !root.correlation.equals(decisionAudit.correlation)
        }).toEqual({
            outcome: "rejectedAuthority",
            writes: 1,
            audits: 1,
            rootKind: "write",
            rootNamesWrite: true,
            rootOutcome: "rejectedAuthority",
            rootCause: undefined,
            rootActorKind: "run",
            rootIsTheDecidingHost: true,
            rootIsNotTheCaller: true,
            rootTenant: decisionPathTenant.value,
            correlationIsHostMinted: true
        });

        // A rejection whose caller cause names the other Actor's Invocation. It exists in this
        // Actor's plane but belongs to the caller, so it is not a usable cause here and must not
        // be adopted as this rejection's attribution.
        const borrowed = TenantDecisionPath.create(label);
        const foreign = borrowed.target.seedInvocationCause(
            "foreign-cause",
            borrowed.authority.actor
        );
        const step = await borrowed.decide({ permit: "root-permit", grant: true });
        const bridged = decodeBridgedDecision(requireObservation(step.result));
        const borrowedResult = await borrowed.deliver(
            borrowed.bridge(bridged, { callerCause: foreign.id })
        );
        const borrowedWrite = requireWrite(borrowedResult);
        const borrowedEvidence = borrowed.target.evidence();
        const borrowedRoot = auditById(borrowedEvidence, borrowedWrite.audit.value);

        expect({
            outcome: borrowedWrite.outcome,
            effects: borrowed.target.ownedRecords().length,
            rootKind: borrowedRoot?.kind.kind,
            rootCause: borrowedRoot?.cause,
            rootIsTheDecidingHost: borrowedRoot?.actor.equals(targetActor),
            foreignCauseUntouched: auditById(borrowedEvidence, foreign.id.value)?.actor.equals(
                authorityActor
            )
        }).toEqual({
            outcome: "rejectedMalformed",
            effects: 0,
            rootKind: "write",
            rootCause: undefined,
            rootIsTheDecidingHost: true,
            foreignCauseUntouched: true
        });

        // The accepted counterpart, which distinguishes the two admitted root kinds: an accepted
        // request with no caller cause is given a host-created Invocation root first, so its
        // write evidence is caused rather than a root itself.
        const accepted = TenantDecisionPath.create(label);
        const applied = await accepted.traverse({ permit: "root-permit", grant: true });
        const appliedWrite = requireWrite(applied.delivery);
        const appliedEvidence = accepted.target.evidence();
        const appliedAudit = auditById(appliedEvidence, appliedWrite.audit.value);
        const appliedCause =
            appliedAudit?.cause === undefined
                ? undefined
                : auditById(appliedEvidence, appliedAudit.cause.value);

        expect({
            outcome: appliedWrite.outcome,
            auditIsRoot: appliedAudit?.cause === undefined,
            causeKind: appliedCause?.kind.kind,
            causeIsRoot: appliedCause?.cause,
            causeIsTheDecidingHost: appliedCause?.actor.equals(targetActor),
            sharesCorrelation:
                appliedAudit !== undefined &&
                appliedCause !== undefined &&
                appliedAudit.correlation.equals(appliedCause.correlation)
        }).toEqual({
            outcome: "committed",
            auditIsRoot: false,
            causeKind: "invocation",
            causeIsRoot: undefined,
            causeIsTheDecidingHost: true,
            sharesCorrelation: true
        });

        // No entry in either Actor's append-only plane is unattributable, so every plane here can
        // be replayed from its roots into the decision it records.
        for (const actor of [
            denied.authority,
            denied.target,
            borrowed.authority,
            borrowed.target,
            accepted.authority,
            accepted.target
        ]) {
            actor.verifyRecordGraph();
            expect(unattributableAudits(actor.evidence())).toEqual([]);
        }
    }
);

function observe(
    name: string,
    actor: DecisionPathActor,
    result: CommandIngressResult
): OutcomeObservation {
    const write = requireWrite(result);
    const audit = auditById(actor.evidence(), write.audit.value);
    return {
        case: name,
        outcome: requireOutcome(result),
        writeOutcome: write.outcome,
        decidingActor: write.actor.id.value,
        envelopeDigest: write.envelopeDigest.value,
        callerKind: write.caller?.kind,
        idempotencyKey: write.idempotencyKey,
        auditIsRoot: audit?.cause === undefined,
        ownedRecords: actor.ownedRecords().length
    };
}

/**
 * The outcome a delivery reached, or the failure shape when it reached none. Naming the shape
 * keeps a broken replay reportable as the fact that differs rather than as a thrown helper.
 */
function outcomeOf(result: CommandIngressResult): string {
    return result.kind === "commandOutcome" ? result.outcome : result.kind;
}

/** The effect a reply names, or a description of why it names none. */
function appliedEffectOf(reply: Uint8Array | undefined): string | undefined {
    if (reply === undefined) return undefined;
    try {
        return decodeAppliedEffectReply(reply).effect;
    } catch {
        return `reply is not an applied effect: ${new TextDecoder().decode(reply)}`;
    }
}

function committedWrites(evidence: EvidenceView): readonly string[] {
    return evidence.writes
        .filter((record) => record.outcome === "committed")
        .map((record) => record.id.value);
}

function auditById(evidence: EvidenceView, id: string): AuditRecord | undefined {
    return evidence.audits.find((record) => record.id.value === id);
}

/**
 * Every audit whose cause chain does not terminate in a root §8.5 admits, with attribution held
 * constant along the way. An append-only plane with an unattributable entry cannot be replayed
 * into the decision it records, so the expected result is always an empty list.
 */
function unattributableAudits(evidence: EvidenceView): readonly string[] {
    const byId = new Map(evidence.audits.map((record) => [record.id.value, record]));
    const problems: string[] = [];
    for (const audit of evidence.audits) {
        const walk = walkToRoot(audit, byId);
        if (walk.broken !== undefined) {
            problems.push(`${audit.id.value}: ${walk.broken}`);
            continue;
        }
        const root = walk.root.kind;
        if (root.kind === "invocation") continue;
        if (root.kind === "write" && root.outcome.startsWith("rejected")) continue;
        problems.push(`${audit.id.value}: root kind ${root.kind} is not an admitted root`);
    }
    return problems;
}

type RootWalk =
    | { readonly root: AuditRecord; readonly broken?: undefined }
    | { readonly root: AuditRecord; readonly broken: string };

function walkToRoot(audit: AuditRecord, byId: ReadonlyMap<string, AuditRecord>): RootWalk {
    const seen = new Set([audit.id.value]);
    let current = audit;
    while (current.cause !== undefined) {
        const next = byId.get(current.cause.value);
        if (next === undefined) return { root: current, broken: "cause is absent from the plane" };
        if (seen.has(next.id.value)) return { root: current, broken: "cause chain is cyclic" };
        if (
            !next.actor.equals(current.actor) ||
            !next.tenant.equals(current.tenant) ||
            !next.correlation.equals(current.correlation)
        ) {
            return { root: current, broken: "cause changes actor, tenant, or correlation" };
        }
        seen.add(next.id.value);
        current = next;
    }
    return { root: current };
}
