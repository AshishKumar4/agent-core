import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSpec } from "./spec.mjs";

/**
 * Batch planner for the controlled-language corpus.
 *
 * Reads the reviewed rule units exactly as `scripts/quality/cnl.mjs` derives them — same
 * atom set, same digest — and writes one authoring brief per SPEC domain group. The
 * planner exists because a rule unit's digest is the only thing binding a controlled
 * sentence to its prose: an author who retyped a digest by hand would produce a record
 * the gate rejects, and an author who guessed one would produce a record the gate accepts
 * for the wrong unit.
 *
 * It reports, not decides: the groups below are a filing of the reachable units, and the
 * planner refuses if that filing does not cover exactly the units it enumerates.
 */

const packageRoot = join(import.meta.dirname, "..", "..");

/** Atoms whose rule unit is hard-excluded, from artifacts/cnl/ratchet.json. */
const excluded = new Set(
    JSON.parse(readFileSync(join(packageRoot, "artifacts", "cnl", "ratchet.json"), "utf8"))
        .exclusions.flatMap((exclusion) => exclusion.atoms)
);

/** Atoms already claimed by a corpus unit, read from the corpus itself. */
function claimedAtoms() {
    const sources = [join(packageRoot, "formal", "SpecCnl", "Corpus.lean")];
    const groups = join(packageRoot, "formal", "SpecCnl", "Units");
    for (const entry of readdirSafe(groups)) sources.push(join(groups, entry));
    const claimed = new Set();
    for (const source of sources) {
        for (const [, list] of readFileSync(source, "utf8").matchAll(
            /atoms :=\s*\[([^\]]*)\]/gsu
        )) {
            for (const [, atom] of list.matchAll(/"([^"]+)"/gu)) claimed.add(atom);
        }
    }
    return claimed;
}

function readdirSafe(path) {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}

/** The groups. Each names its units by their first atom, plus the model modules whose
 * theorems that domain lives in. A unit appears in exactly one group. */
const groups = [
    {
        name: "Auth",
        section: "§3.3, §3.4, §1.4 — Membership, roles, Grants, Bindings",
        model: ["Authority.lean", "Model.lean", "Scopes.lean", "Composed.lean"],
        units: [
            "C13-AUTH-PLANE",
            "C13-AUTH-ROLE-MATERIALIZATION",
            "C13-AUTH-BINDING-RESOLUTION",
            "C13-AUTH-BINDING-NAME-CANONICAL",
            "C13-AUTH-DENY-PRECEDENCE",
            "C13-AUTH-GUEST-ELEVATION",
            "C13-AUTH-GUEST-HANDSHAKE-BOOTSTRAP",
            "C13-AUTH-SHARE-OFFER",
            "C13-AUTH-PRINCIPAL-REF",
            "C13-AUTH-MEDIATED-STALE",
            "C13-AUTH-RESOLUTION-LIFETIME"
        ]
    },
    {
        name: "Isolate",
        section: "§4.7, §4.6, §9.2 — agent-authored code, isolates, Slate skeletons",
        model: ["Slates.lean", "Capability.lean", "Policy.lean", "Facets.lean"],
        units: [
            "C13-AUTH-ISOLATE-DELEGATION",
            "C13-AUTH-ISOLATE-NAMESPACE-CLOSED",
            "C13-PLACEMENT-AUTHORED-BACKING",
            "C13-FACET-CODE-AVAILABILITY",
            "C13-SLATE-SKELETON-CREDENTIAL-FREE",
            "C13-SLATE-INSTANTIATE-SCOPE",
            "C13-SLATE-SKELETON-ARTIFACT"
        ]
    },
    {
        name: "Placement",
        section: "§9.2, §7.2, §3.5 — placement intersection, enforcement floors, custody",
        model: ["Policy.lean", "Secrets.lean", "Capability.lean", "Composed.lean"],
        units: [
            "C13-PLACEMENT-INTERSECTION",
            "C13-PLACEMENT-UNTRUSTED-BUNDLED",
            "C13-POLICY-DIRECT-COLOCATION",
            "C13-POLICY-MEDIATION-FLOOR",
            "C13-POLICY-EPOCH-RECHECK",
            "C13-CONFIG-SECRET-CUSTODY"
        ]
    },
    {
        name: "FacetInstall",
        section: "§4.1, §4.2, §1.4 — manifests, install, slots, attribution",
        model: ["Facets.lean", "Slots.lean", "Model.lean"],
        units: [
            "C13-FACET-REF-CANONICAL",
            "C13-FACET-SLOT-AUTHORITY",
            "C13-FACET-DISPOSAL",
            "C13-FACET-INSTALL-VERIFICATION",
            "C13-FACET-CONTRIBUTION-ATTRIBUTION",
            "C13-FACET-CAPABILITY-ABSENCE"
        ]
    },
    {
        name: "FacetLifecycle",
        section: "§4.1, §7.1 — withdrawal, drain, activation, dependencies, cancellation",
        model: ["Facets.lean", "Facets/", "Slots.lean", "Events.lean"],
        units: [
            "C13-FACET-IMPACT-BOUNDARY",
            "C13-FACET-WITHDRAWAL-EXACT",
            "C13-FACET-WITHDRAWAL-DRAIN",
            "C13-FACET-START-ATOMIC",
            "C13-FACET-DEPENDENCY-ORDER",
            "C13-FACET-CANCELLATION-REACH"
        ]
    },
    {
        name: "Commands",
        section: "§4.3 — user-facing Commands",
        model: ["Commands.lean", "Slots.lean", "Subscriptions.lean"],
        units: [
            "C13-COMMAND-ARGUMENT-BINDING",
            "C13-COMMAND-SUBSCRIPTION-DEFAULTS",
            "C13-COMMAND-COLLISION",
            "C13-COMMAND-COMPLETION-IMPACT",
            "C13-COMMAND-INVOCATION-CORRELATION",
            "C13-COMMAND-RESULT"
        ]
    },
    {
        name: "InterceptOrder",
        section: "§4.4 — interceptor confinement, modes, replay",
        model: ["Interceptors.lean"],
        units: [
            "C13-INTERCEPTOR-DOMAIN-CONFINEMENT",
            "C13-INTERCEPTOR-POST-PREPARATION",
            "C13-INTERCEPTOR-MODE-DECLARED",
            "C13-INTERCEPTOR-MODE-FIDELITY",
            "C13-INTERCEPTOR-REPLAY",
            "C13-INTERCEPTOR-TURN-HOSTED"
        ]
    },
    {
        name: "InterceptTurn",
        section: "§4.4 — Turn-bound cut points",
        model: ["Interceptors.lean", "Lease.lean"],
        units: [
            "C13-INTERCEPTOR-TURN-CONTEXT",
            "C13-INTERCEPTOR-TURN-REWRITE",
            "C13-TURN-PROMPT-ASSEMBLE",
            "C13-TURN-INPUT-SUBMITTED",
            "C13-TURN-STEP-STOP"
        ]
    },
    {
        name: "TrustRoute",
        section: "§6.1, §6.2, §7.4 — trust derivation, reservations, projections",
        model: ["Events.lean", "Subscriptions.lean", "Policy.lean", "Audit.lean"],
        units: [
            "C13-TRUST-HOST-DERIVED",
            "C13-TRUST-ASSERTION-REJECTION",
            "C13-SUBSCRIPTION-AUTHORITY",
            "C13-ROUTE-SOURCE-OWNED",
            "C13-ROUTE-STABLE-INVOCATION",
            "C13-SUBSCRIPTION-ATTRIBUTION-FIXED"
        ]
    },
    {
        name: "Observation",
        section: "§6.2 — cross-Run observation and coherence findings",
        model: ["Subscriptions.lean", "Authority.lean", "Events.lean"],
        units: [
            "C13-SUBSCRIPTION-OBSERVATION-GRANT",
            "C13-SUBSCRIPTION-OBSERVATION-TENANT",
            "C13-SUBSCRIPTION-OBSERVATION-INTERVENTION",
            "C13-SUBSCRIPTION-COHERENCE-EVIDENCE"
        ]
    },
    {
        name: "Prepared",
        section: "§7.3 — PreparedInvocation, replay, Approval",
        model: ["Model.lean", "Approvals.lean", "Events.lean", "Interceptors.lean"],
        units: [
            "C13-PREPARED-SHARED-HEADER",
            "C13-PREPARED-ITEM-KEYS",
            "C13-PREPARED-REPLAY-IDENTITY",
            "C13-PREPARED-ROUTED-PROJECTION",
            "C13-PREPARED-NO-TURN-OWNER",
        ]
    },
    {
        name: "Claims",
        section: "§7.4 — item claims, ordinals, write-ahead evidence",
        model: ["Events.lean", "Composed.lean"],
        units: [
            "C13-CLAIM-INITIAL-ATOMIC",
            "C13-CLAIM-RECOVERY-NO-ATTEMPT",
            "C13-ATTEMPT-ORDINAL-AFTER-FAILURE",
            "C13-EFFECT-WRITE-AHEAD"
        ]
    },
    {
        name: "Receipts",
        section: "§7.4 — Receipt lineage, failure kinds, batch outcomes, audit exclusions",
        model: ["Events.lean", "Audit.lean"],
        units: [
            "C13-RECEIPT-IMMUTABLE",
            "C13-RECEIPT-FAILURE-KIND",
            "C13-RECEIPT-FAILURE-ORTHOGONAL",
            "C13-BATCH-OUTCOME-COMPLETE",
            "C13-AUDIT-ROUTE-BRIDGE",
            "C13-AUDIT-TELEMETRY-EXCLUDED"
        ]
    },
    {
        name: "RunGraph",
        section: "§5.2 — graph closure, undo/redo, transcripts, cuts, rewrites",
        model: ["RunGraph.lean"],
        units: [
            "C13-RUN-GRAPH-CLOSED",
            "C13-RUN-DISTINCTION-REPRESENTABLE",
            "C13-RUN-UNDO-REDO",
            "C13-RUN-EFFECTIVE-TRANSCRIPT",
            "C13-RUN-REWRITE-BRACKET",
            "C13-RUN-CUT-BALANCE"
        ]
    },
    {
        name: "RunPins",
        section: "§5.2 — pins, checkpoints, merges, folds, migration",
        model: ["RunGraph.lean"],
        units: [
            "C13-RUN-PINS-SOURCES",
            "C13-RUN-PIN-IDENTITY-TYPES",
            "C13-RUN-CHECKPOINT-KINDS",
            "C13-RUN-TREE-CONFLICT-EXPLICIT",
            "C13-RUN-MIGRATED-TURN-REJECTION",
            "C13-RUN-FOLD-RECONCILIATION",
            "C13-RUN-FOLD-ORDER"
        ]
    },
    {
        name: "RunSettle",
        section: "§5.2 — admission registry, acceptance, ceilings, terminalization",
        model: ["RunGraph.lean", "Composed.lean"],
        units: [
            "C13-RUN-ADMISSION-REGISTRY",
            "C13-RUN-ACCEPTANCE-SUBJECT",
            "C13-RUN-RESOURCE-CEILING",
            "C13-RUN-CEILING-EXHAUSTION",
            "C13-RUN-CEILING-REMAINDER",
            "C13-RUN-CEILING-COST",
            "C13-RUN-FORCED-CANCELLATION",
            "C13-RUN-FRONTIER-COMPLETE",
            "C13-RUN-SETTLED-DERIVED"
        ]
    },
    {
        name: "TurnSeam",
        section: "§5.6, §5.3, §5.1 — admission handles, cancellation, FacetSet, model calls",
        model: ["Lease.lean", "RunGraph.lean", "Environments.lean", "Composed.lean"],
        units: [
            "C13-TURN-ADMISSION-HANDLE",
            "C13-TURN-HANDLE-DETACHMENT",
            "C13-TURN-ADMISSION-FACTS-DISTINCT",
            "C13-TURN-CANCEL-INBOX",
            "C13-TURN-FACET-SET-STABLE",
            "C13-TURN-MODEL-CALL"
        ]
    },
    {
        name: "ModelInput",
        section: "§5.6 — model input records, reconstruction, coverage, surfaces",
        model: ["RunGraph.lean", "Lease.lean"],
        units: [
            "C13-TURN-MODEL-INPUT-RECONSTRUCTABLE",
            "C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH",
            "C13-TURN-MODEL-INPUT-RETENTION-LOSS",
            "C13-TURN-MODEL-INPUT-ABRIDGED",
            "C13-TURN-TRANSCRIPT-RECONSTRUCTION",
            "C13-TURN-SURFACE-ACCOUNTED"
        ]
    },
    {
        name: "NoRetry",
        section: "§5.6 — the closed Turn lifecycle",
        model: ["Lease.lean", "RunGraph.lean", "Dispatcher.lean"],
        units: [
            "C13-TURN-NO-RETRY",
            "C13-TURN-NO-RETRY-RUNTIME",
            "C13-TURN-NO-RETRY-PROTOCOL",
            "C13-TURN-NO-RETRY-EXPORT",
            "C13-TURN-NO-RETRY-RECORD"
        ]
    },
    {
        name: "ViewPlan",
        section: "§6.3, §6.4 — Views, ViewDeltas, Plans",
        model: ["View.lean", "Slots.lean", "RunGraph.lean"],
        units: [
            "C13-VIEW-NO-LIVE-STATE",
            "C13-VIEW-APPROVAL-PROVENANCE",
            "C13-VIEW-WITHDRAWAL-TERMINAL",
            "C13-PLAN-PROJECTION",
            "C13-PLAN-APPEND-ONLY",
            "C13-PLAN-ACYCLIC",
            "C13-PLAN-FOLD-CLOSED",
            "C13-PLAN-DECLARER-BOUNDED",
            "C13-PLAN-CRITICAL-PATH"
        ]
    },
    {
        name: "Protocol",
        section: "§8.1, §8.3, §8.4, §8.5 — Actors, codecs, ownership, the command protocol",
        model: ["Persistence.lean", "Dispatcher.lean", "Commands.lean", "CanonicalJson.lean"],
        units: [
            "C13-CODEC-VERSIONING",
            "C13-CODEC-INCOMPATIBILITY-TOTAL",
            "C13-PROTOCOL-FAMILY-ENVELOPE-POLICY",
            "C13-PROTOCOL-REJECTION-ROOT",
            "C13-OWNERSHIP-SINGLE-OWNER",
            "C13-OWNERSHIP-ACTOR-CONTRACT",
            "C13-OWNERSHIP-AUTHORITY-RECORDS"
        ]
    },
    {
        name: "Definition",
        section: "§9.1, §9.2, §9.3 — Packages, Blueprints, materialization",
        model: ["Materializer.lean", "Materialization.lean", "Facets.lean", "Policy.lean"],
        units: [
            "C13-BLUEPRINT-VALIDATE-BEFORE-LOAD",
            "C13-BLUEPRINT-CONVERGENCE",
            "C13-PACKAGE-DEPENDENCY-DECLARED"
        ]
    },
    {
        name: "Permit",
        section: "§10.2, §10.3 — dynamic isolates and the AuthorityPermit protocol",
        model: ["DistributedPermit.lean", "Slates.lean", "Proofs/CanonicalMediatedTrace.lean"],
        units: [
            "C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING",
            "C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND",
            "C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY",
            "C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY",
            "C13-CLOUDFLARE-DYNAMIC-STORE-LIFECYCLE",
            "C13-CLOUDFLARE-DYNAMIC-NO-EGRESS"
        ]
    },
    {
        name: "Durable",
        section: "§10.4 — alarms, reconciliation, queues, storage, deployment",
        model: ["Persistence.lean", "Events.lean", "View.lean", "RunGraph.lean"],
        units: [
            "C13-CLOUDFLARE-ALARM-CLAIMS",
            "C13-CLOUDFLARE-RECONCILIATION-DRIVER",
            "C13-CLOUDFLARE-ALARM-DURABILITY",
            "C13-CLOUDFLARE-RECONCILIATION-RETRY",
            "C13-CLOUDFLARE-RECONCILIATION-FENCE",
            "C13-CLOUDFLARE-VIEW-ATTACHMENT",
            "C13-CLOUDFLARE-QUEUE-DISPOSITION",
            "C13-CLOUDFLARE-STORAGE-LIMIT",
            "C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY",
            "C13-CLOUDFLARE-ADDITIVE-MIGRATION",
            "C13-CLOUDFLARE-ROLLBACK-WINDOW"
        ]
    }
];

const spec = await canonicalSpec();
const conformance = spec.sections.find((section) => section.id === "13");
const source = readFileSync(join(packageRoot, "SPEC.md"), "utf8").split("\n");

/** The line in SPEC.md where this atom is labelled outside §13, for the advisory anchor. */
function anchorLine(atom) {
    const conformanceHeading = source.findIndex((line) => line.startsWith("## 13. Conformance"));
    const found = source.findIndex(
        (line, index) => index < conformanceHeading && line.includes(`**${atom}**`)
    );
    return found === -1 ? null : found + 1;
}

const units = new Map();
const order = [];
for (const atom of spec.atoms) {
    if (!atom.reviewed) continue;
    const anchor = spec.anchors.find(
        (candidate) =>
            candidate.id === atom.id &&
            (candidate.start < conformance.start || candidate.start >= conformance.end)
    );
    if (anchor === undefined) continue;
    const [ruleUnit] = atom.text.split(" §13 summary: ");
    const body = ruleUnit.replace(/\s*This maps to \*\*C13-[A-Z0-9-]+\*\*\.?$/u, "").trim();
    const digest = createHash("sha256").update(body).digest("hex");
    if (!units.has(digest)) {
        const section = spec.sections.findLast(
            (candidate) => candidate.start <= anchor.start && anchor.start < candidate.end
        );
        units.set(digest, { body, digest, atoms: [], section: section?.id ?? "?" });
        order.push(digest);
    }
    units.get(digest).atoms.push(atom.id);
}

const claimed = claimedAtoms();
const reachable = order
    .map((digest) => units.get(digest))
    .filter((unit) => !unit.atoms.some((atom) => excluded.has(atom)));
/** A rule unit some corpus unit already claims an atom of is already bridged: the corpus
 * renders a rule unit with exactly one sentence, so carrying its remaining atoms means
 * extending that sentence rather than writing a second unit over the same prose. Those are
 * reported apart and are not authoring work for a group. */
const partial = reachable.filter(
    (unit) =>
        unit.atoms.some((atom) => claimed.has(atom)) &&
        !unit.atoms.every((atom) => claimed.has(atom))
);
const remaining = reachable.filter((unit) => !unit.atoms.some((atom) => claimed.has(atom)));

const failures = [];
const assigned = new Map();
for (const group of groups) {
    for (const atom of group.units) {
        const unit = remaining.find((candidate) => candidate.atoms.includes(atom));
        if (unit === undefined) {
            failures.push(`${group.name} names ${atom}, which is not an unclaimed rule unit`);
            continue;
        }
        if (assigned.has(unit.digest)) {
            failures.push(`${unit.atoms[0]} is filed under two groups`);
            continue;
        }
        assigned.set(unit.digest, group);
    }
}
for (const unit of remaining) {
    if (!assigned.has(unit.digest)) failures.push(`unfiled rule unit: ${unit.atoms.join(", ")}`);
}
if (failures.length > 0) {
    for (const failure of failures) console.error(`cnl-batches: ${failure}`);
    process.exit(1);
}

/** A stable corpus key for a unit: its first atom, underscored. Multi-atom units keep the
 * first atom's name, which is how the existing corpus keys read. */
function keyFor(unit) {
    return unit.atoms[0].replaceAll("-", "_");
}

const outputRoot = process.argv[2] ?? "/home/mrwhite0racle/agent-core-worktrees/cnl-batch-specs";
mkdirSync(outputRoot, { recursive: true });

const manifest = [];
for (const group of groups) {
    const groupUnits = remaining.filter((unit) => assigned.get(unit.digest) === group);
    const brief = [
        `# Authoring brief: ${group.name}`,
        "",
        `SPEC domain: ${group.section}`,
        `Model modules to mine: ${group.model.map((name) => `formal/AgentCore/${name}`).join(", ")}`,
        `Rule units in this group: ${groupUnits.length}`,
        "",
        "Each unit below is one reachable SPEC rule unit. `digest` is authoritative: copy it",
        "byte for byte into the corpus record. `anchor` is advisory. `atoms` is every §13 atom",
        "the unit owns; claim the ones your sentence carries and record the rest under",
        "`dropped`.",
        ""
    ];
    for (const unit of groupUnits) {
        const line = anchorLine(unit.atoms[0]);
        brief.push(
            `## ${keyFor(unit)}`,
            "",
            `- atoms: ${unit.atoms.map((atom) => `\`${atom}\``).join(", ")}`,
            `- specSection: \`${unit.section}\``,
            `- anchor: \`SPEC.md:${line ?? "unknown"}\``,
            `- digest: \`${unit.digest}\``,
            "",
            "Rule unit text, verbatim:",
            "",
            "> " + unit.body.replaceAll("\n", "\n> "),
            ""
        );
    }
    const path = join(outputRoot, `${group.name}.md`);
    writeFileSync(path, brief.join("\n"), "utf8");
    manifest.push({ group: group.name, path, units: groupUnits.length });
}

writeFileSync(
    join(outputRoot, "manifest.json"),
    `${JSON.stringify({ groups: manifest, remaining: remaining.length }, null, 2)}\n`,
    "utf8"
);
for (const unit of partial)
    console.log(`  partially claimed (extend the existing unit): ${unit.atoms.join(", ")}`);
console.log(
    `cnl-batches: ${remaining.length} unclaimed rule units filed into ${groups.length} groups`
);
for (const entry of manifest) console.log(`  ${entry.group}: ${entry.units}`);
