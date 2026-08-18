import { Digest, RecordCodec, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import { GrantId } from "../authority";
import { BindingName, OperationRef, type Impact } from "../facets";
import { PrincipalRef, type ScopeRef } from "../identity";
import { RunId } from "../execution-references";
import { EventId, RouteReservationId, SubscriptionId } from "../interaction-references";
import {
    decodeOptionalPrincipalRef,
    decodeScope,
    encodeOptionalPrincipalRef,
    encodeScope,
    requireArray,
    requireFields,
    requireObject,
    requireOptionalFields,
    requireString
} from "./codec";
import { CoherenceFindingId } from "./id";
import type { TenantRelation } from "./value";

/**
 * A standing declaration that one Principal observes one sibling Run's Events. It carries
 * no authority of its own: `grant` names the allow-Grant the §3.4 resolver must still
 * produce, which is what makes the set of declarations an enumeration of who watches whom
 * rather than a second authority plane.
 */
export interface CrossRunObservation {
    readonly subscription: SubscriptionId;
    readonly observer: PrincipalRef;
    readonly subject: RunId;
    readonly subjectScope: ScopeRef;
    readonly grant: GrantId;
    readonly crossTenantAuthority?: BindingName;
}

/**
 * One live allow-Grant the §3.4 resolver produced for the observing Principal: the Scope it
 * holds, the observed Runs its capability admits, and its impacts. Denies are already
 * applied by the resolver, so a fact reaching this policy is authority that survived §3.3
 * precedence.
 */
export interface ObservationAuthority {
    readonly grant: GrantId;
    readonly scope: ScopeRef;
    readonly runs: readonly RunId[];
    readonly impacts: readonly Impact[];
}

export type ObservationDecision =
    | { readonly kind: "admitted"; readonly grant: GrantId }
    | { readonly kind: "refused"; readonly refusal: ObservationRefusal };

/** Why one cross-Run observation or intervention was refused. */
export abstract class ObservationRefusal {
    public static get ambient(): ObservationRefusal {
        return ambientRefusal;
    }

    public static get tenant(): ObservationRefusal {
        return tenantRefusal;
    }

    public static impact(missing: Impact): ObservationRefusal {
        return new MissingObservationImpact(missing);
    }

    public static intervention(missing: Impact): ObservationRefusal {
        return new InterventionWithoutGrant(missing);
    }

    public abstract readonly reason: string;

    public abstract explain(): string;

    public denied(): AgentCoreError {
        return new AgentCoreError("authority.denied", this.explain());
    }
}

class AmbientObservation extends ObservationRefusal {
    public readonly reason = "ambient" as const;

    public explain(): string {
        return "Cross-Run observation names no live allow-Grant reaching the observed Run";
    }
}

class CrossTenantObservation extends ObservationRefusal {
    public readonly reason = "tenant" as const;

    public explain(): string {
        return "Cross-Run observation lacks the separate cross-tenant authority its route requires";
    }
}

class MissingObservationImpact extends ObservationRefusal {
    public readonly reason = "impact" as const;

    public constructor(public readonly missing: Impact) {
        super();
        Object.freeze(this);
    }

    public explain(): string {
        return `Cross-Run observation Grant does not carry ${this.missing} impact`;
    }
}

class InterventionWithoutGrant extends ObservationRefusal {
    public readonly reason = "intervention" as const;

    public constructor(public readonly missing: Impact) {
        super();
        Object.freeze(this);
    }

    public explain(): string {
        return `Acting on an observed Run requires a separate allow-Grant carrying ${this.missing} impact`;
    }
}

const ambientRefusal = Object.freeze(new AmbientObservation());
const tenantRefusal = Object.freeze(new CrossTenantObservation());

/**
 * Whether the Event-owning source Actor may append a RouteReservation for one cross-Run
 * observation. It runs before the reservation exists, so a refusal leaves nothing behind,
 * and the cross-tenant question is answered first because a tenant mismatch is a fact about
 * the route rather than about the observer's Grants.
 */
export function admitCrossRunObservation(
    observation: CrossRunObservation,
    presented: readonly ObservationAuthority[],
    tenants: TenantRelation
): ObservationDecision {
    if (!crossTenantAuthorized(observation, tenants)) {
        return { kind: "refused", refusal: ObservationRefusal.tenant };
    }
    const cited = presented.find((authority) => authority.grant.equals(observation.grant));
    if (cited === undefined || !reaches(cited, observation)) {
        return { kind: "refused", refusal: ObservationRefusal.ambient };
    }
    if (!cited.impacts.includes("observe")) {
        return { kind: "refused", refusal: ObservationRefusal.impact("observe") };
    }
    return { kind: "admitted", grant: cited.grant };
}

/**
 * What an observer may attempt against the Run it observes. `observe` is the read the
 * observation already covers, so it is not an intervention and the type says so rather than
 * a guard rejecting it at runtime.
 */
export type InterventionImpact = Exclude<Impact, "observe">;

/**
 * Whether an observer may act on the Run it observes. The observation's own Grant is
 * excluded from the search whatever impacts it carries, so observation authority can never
 * be laundered into intervention authority by widening one capability.
 */
export function authorizeObservedIntervention(
    observation: CrossRunObservation,
    presented: readonly ObservationAuthority[],
    impact: InterventionImpact
): ObservationDecision {
    const acting = presented.find(
        (authority) =>
            !authority.grant.equals(observation.grant) &&
            reaches(authority, observation) &&
            authority.impacts.includes(impact)
    );
    return acting === undefined
        ? { kind: "refused", refusal: ObservationRefusal.intervention(impact) }
        : { kind: "admitted", grant: acting.grant };
}

/** One effect intent an admitted cross-Run observation delivered. */
export interface ObservedIntent {
    readonly run: RunId;
    readonly event: EventId;
    readonly reservation: RouteReservationId;
    readonly operation: OperationRef;
    readonly argumentsDigest: Digest;
}

/** Two observed intents naming different Runs and the same Operation. */
export interface ObservedResemblance {
    readonly left: ObservedIntent;
    readonly right: ObservedIntent;
}

/**
 * Which reading of a resemblance set a finding asserts. Each case owns the evidence shape
 * it is the only admissible reading of, so the conclusion and the evidence deciding it
 * cannot drift apart.
 */
export abstract class CoherenceVerdict {
    public static get duplicate(): CoherenceVerdict {
        return duplicateVerdict;
    }

    public static get distinct(): CoherenceVerdict {
        return distinctVerdict;
    }

    public static fromData(value: JsonValue | undefined): CoherenceVerdict {
        const label = requireString(value, "Coherence finding verdict");
        if (label === duplicateVerdict.label) return duplicateVerdict;
        if (label === distinctVerdict.label) return distinctVerdict;
        throw new TypeError("Coherence verdict is invalid");
    }

    public abstract readonly label: string;

    public abstract requireEvidence(
        witnesses: readonly ObservedResemblance[],
        discriminator: ObservedResemblance | undefined
    ): void;

    public equals(other: CoherenceVerdict): boolean {
        return this === other;
    }
}

class DuplicateWork extends CoherenceVerdict {
    public readonly label = "duplicate" as const;

    public requireEvidence(
        witnesses: readonly ObservedResemblance[],
        discriminator: ObservedResemblance | undefined
    ): void {
        if (witnesses.length === 0 || discriminator !== undefined) {
            throw new TypeError("A duplicate finding carries witnesses and no discriminator");
        }
        if (!witnesses.every(argumentsEqual)) {
            throw new TypeError("A duplicate witness must carry equal arguments digests");
        }
    }
}

class DistinctWork extends CoherenceVerdict {
    public readonly label = "distinct" as const;

    public requireEvidence(
        witnesses: readonly ObservedResemblance[],
        discriminator: ObservedResemblance | undefined
    ): void {
        if (witnesses.length > 0 || discriminator === undefined) {
            throw new TypeError("A distinct finding carries one discriminator and no witnesses");
        }
        if (argumentsEqual(discriminator)) {
            throw new TypeError("A distinct discriminator must carry differing arguments digests");
        }
    }
}

const duplicateVerdict = Object.freeze(new DuplicateWork());
const distinctVerdict = Object.freeze(new DistinctWork());

export interface CoherenceFindingInit {
    readonly id: CoherenceFindingId;
    readonly observer: PrincipalRef;
    readonly scope: ScopeRef;
    readonly grant: GrantId;
    readonly subjects: readonly [RunId, RunId];
    readonly verdict: CoherenceVerdict;
    readonly witnesses: readonly ObservedResemblance[];
    readonly discriminator?: ObservedResemblance;
}

/** Everything a finding is about except the verdict its evidence decides. */
export type CoherenceFindingIdentity = Omit<
    CoherenceFindingInit,
    "discriminator" | "verdict" | "witnesses"
>;

class CoherenceFindingCodecV1 extends RecordCodec<CoherenceFinding> {
    public constructor() {
        super("workspace.coherence-finding", { major: 1, minor: 0 });
    }

    protected encodePayload(finding: CoherenceFinding): JsonValue {
        const payload = {
            id: finding.id.value,
            observer: encodeOptionalPrincipalRef(finding.observer),
            scope: encodeScope(finding.scope),
            grant: finding.grant.value,
            subjects: finding.subjects.map((run) => run.value),
            verdict: finding.verdict.label,
            witnesses: finding.witnesses.map(encodeResemblance)
        };
        return finding.discriminator === undefined
            ? payload
            : { ...payload, discriminator: encodeResemblance(finding.discriminator) };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): CoherenceFinding {
        const object = requireObject(payload, "Coherence finding payload");
        requireOptionalFields(
            object,
            ["grant", "id", "observer", "scope", "subjects", "verdict", "witnesses"],
            ["discriminator"],
            "Coherence finding payload"
        );
        const init: CoherenceFindingInit = {
            id: new CoherenceFindingId(requireString(object["id"], "Coherence finding ID")),
            observer: decodePrincipal(object["observer"], "Coherence finding observer"),
            scope: decodeScope(object["scope"]),
            grant: new GrantId(requireString(object["grant"], "Coherence finding Grant")),
            subjects: decodeSubjects(object["subjects"]),
            verdict: CoherenceVerdict.fromData(object["verdict"]),
            witnesses: requireArray(object["witnesses"], "Coherence finding witnesses").map(
                (value) => decodeResemblance(value, "Coherence finding witness")
            )
        };
        const discriminator = object["discriminator"];
        return new CoherenceFinding(
            discriminator === undefined
                ? init
                : {
                      ...init,
                      discriminator: decodeResemblance(
                          discriminator,
                          "Coherence finding discriminator"
                      )
                  }
        );
    }
}

/**
 * One observer's determination that two Runs are, or are not, doing the same work. The
 * record carries identifiers and digests only: it is checkable by a reader who can read the
 * observed Events through the same Grant, and it is no second copy of what those Runs hold.
 */
export class CoherenceFinding {
    public static readonly codec: RecordCodec<CoherenceFinding> = new CoherenceFindingCodecV1();

    public static encode(finding: CoherenceFinding): Uint8Array {
        return CoherenceFinding.codec.encode(finding);
    }

    public static decode(bytes: Uint8Array): CoherenceFinding {
        return CoherenceFinding.codec.decode(bytes);
    }

    public readonly init: CoherenceFindingInit;

    public constructor(init: CoherenceFindingInit) {
        const [first, second] = init.subjects;
        if (first.equals(second)) {
            throw new TypeError("A coherence finding compares two different Runs");
        }
        for (const resemblance of [
            ...init.witnesses,
            ...(init.discriminator === undefined ? [] : [init.discriminator])
        ]) {
            requireResemblance(resemblance, init.subjects);
        }
        init.verdict.requireEvidence(init.witnesses, init.discriminator);
        this.init = Object.freeze({
            ...init,
            subjects: Object.freeze([first, second] as const),
            witnesses: Object.freeze([...init.witnesses])
        });
        Object.freeze(this);
    }

    public get id(): CoherenceFindingId {
        return this.init.id;
    }
    public get observer(): PrincipalRef {
        return this.init.observer;
    }
    public get scope(): ScopeRef {
        return this.init.scope;
    }
    public get grant(): GrantId {
        return this.init.grant;
    }
    public get subjects(): readonly [RunId, RunId] {
        return this.init.subjects;
    }
    public get verdict(): CoherenceVerdict {
        return this.init.verdict;
    }
    public get witnesses(): readonly ObservedResemblance[] {
        return this.init.witnesses;
    }
    public get discriminator(): ObservedResemblance | undefined {
        return this.init.discriminator;
    }
}

/**
 * The finding two Runs' observed intents support, or undefined when nothing resembles
 * anything and there is no determination to make. Pair order follows `observed`, so the
 * same observations always decide the same way.
 */
export function decideCoherenceFinding(
    identity: CoherenceFindingIdentity,
    observed: readonly ObservedIntent[]
): CoherenceFinding | undefined {
    const [first, second] = identity.subjects;
    const resemblances = observed
        .filter((intent) => intent.run.equals(first))
        .flatMap((left) =>
            observed
                .filter(
                    (right) => right.run.equals(second) && left.operation.equals(right.operation)
                )
                .map((right) => ({ left, right }))
        );
    const [discriminator] = resemblances;
    if (discriminator === undefined) return undefined;
    const witnesses = resemblances.filter(argumentsEqual);
    return witnesses.length > 0
        ? new CoherenceFinding({ ...identity, verdict: CoherenceVerdict.duplicate, witnesses })
        : new CoherenceFinding({
              ...identity,
              verdict: CoherenceVerdict.distinct,
              witnesses: [],
              discriminator
          });
}

function argumentsEqual(resemblance: ObservedResemblance): boolean {
    return resemblance.left.argumentsDigest.equals(resemblance.right.argumentsDigest);
}

function requireResemblance(
    resemblance: ObservedResemblance,
    subjects: readonly [RunId, RunId]
): void {
    const { left, right } = resemblance;
    if (!left.operation.equals(right.operation)) {
        throw new TypeError("A resemblance names one Operation on both sides");
    }
    if (!left.run.equals(subjects[0]) || !right.run.equals(subjects[1])) {
        throw new TypeError("A resemblance names the finding's two subject Runs in order");
    }
}

function reaches(authority: ObservationAuthority, observation: CrossRunObservation): boolean {
    return (
        observation.subjectScope.path.some((scope) => scope.equals(authority.scope)) &&
        authority.runs.some((run) => run.equals(observation.subject))
    );
}

function crossTenantAuthorized(
    observation: CrossRunObservation,
    tenants: TenantRelation
): boolean {
    const observerTenant = observation.observer.tenantId;
    const subjectTenant = observation.subjectScope.tenantId;
    if (tenants.kind === "cross") {
        return (
            observation.crossTenantAuthority !== undefined &&
            observation.crossTenantAuthority.equals(tenants.authority) &&
            observerTenant.equals(tenants.target) &&
            subjectTenant.equals(tenants.source)
        );
    }
    return (
        observation.crossTenantAuthority === undefined &&
        observerTenant.equals(tenants.tenant) &&
        subjectTenant.equals(tenants.tenant)
    );
}

function encodeResemblance(resemblance: ObservedResemblance): JsonValue {
    return { left: encodeIntent(resemblance.left), right: encodeIntent(resemblance.right) };
}

function decodeResemblance(value: JsonValue, subject: string): ObservedResemblance {
    const object = requireObject(value, subject);
    requireFields(object, ["left", "right"], subject);
    return {
        left: decodeIntent(object["left"], `${subject} left`),
        right: decodeIntent(object["right"], `${subject} right`)
    };
}

function encodeIntent(intent: ObservedIntent): JsonValue {
    return {
        run: intent.run.value,
        event: intent.event.value,
        reservation: intent.reservation.value,
        operation: intent.operation.value,
        argumentsDigest: intent.argumentsDigest.value
    };
}

function decodeIntent(value: JsonValue, subject: string): ObservedIntent {
    const object = requireObject(value, subject);
    requireFields(
        object,
        ["argumentsDigest", "event", "operation", "reservation", "run"],
        subject
    );
    return {
        run: new RunId(requireString(object["run"], `${subject} Run`)),
        event: new EventId(requireString(object["event"], `${subject} Event`)),
        reservation: new RouteReservationId(
            requireString(object["reservation"], `${subject} reservation`)
        ),
        operation: new OperationRef(requireString(object["operation"], `${subject} Operation`)),
        argumentsDigest: new Digest(
            requireString(object["argumentsDigest"], `${subject} arguments digest`)
        )
    };
}

function decodeSubjects(value: JsonValue | undefined): readonly [RunId, RunId] {
    const runs = requireArray(value, "Coherence finding subjects");
    if (runs.length !== 2) {
        throw new TypeError("A coherence finding names exactly two subject Runs");
    }
    return [
        new RunId(requireString(runs[0], "Coherence finding first subject")),
        new RunId(requireString(runs[1], "Coherence finding second subject"))
    ];
}

function decodePrincipal(value: JsonValue | undefined, subject: string): PrincipalRef {
    const principal = decodeOptionalPrincipalRef(value, subject);
    if (principal === undefined) throw new TypeError(`${subject} is required`);
    return principal;
}
