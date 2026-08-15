import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
    artifactRoot,
    assertArray,
    assertExactKeys,
    assertObject,
    assertUniqueIds,
    isNonEmptyString,
    jsonKind,
    packageRoot,
    readCanonicalJson,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";

const SOURCE_DISPOSITIONS = new Set([
    "candidate",
    "permanent-boundary",
    "mechanize",
    "conformance"
]);
const CHECKER_PATHS = new Set([
    "scripts/check-normative.mjs",
    "scripts/quality/backlog.mjs",
    "scripts/quality/change-control.mjs",
    "scripts/quality/claims.mjs",
    "scripts/quality/doctrine.mjs"
]);
const CHECKOUT_ACTION = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE_ACTION = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const SETUP_BUN_ACTION = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const CACHE_ACTION = "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830";
const UPLOAD_ACTION = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const LEAN_INSTALL_SCRIPT = String.raw`curl -fL --proto '=https' --tlsv1.2 \
  https://github.com/leanprover/elan/releases/download/v4.2.3/elan-x86_64-unknown-linux-gnu.tar.gz \
  -o "$RUNNER_TEMP/elan.tar.gz"
echo 'df0b2b3a439961ffcbb3985214365ffe40f49bc871df04dff268c7d8e21ca8b2  '"$RUNNER_TEMP/elan.tar.gz" | sha256sum -c -
tar -xzf "$RUNNER_TEMP/elan.tar.gz" -C "$RUNNER_TEMP"
"$RUNNER_TEMP/elan-init" -y --default-toolchain none
echo "$HOME/.elan/bin" >> "$GITHUB_PATH"`;
export async function readDoctrinePolicy() {
    return readCanonicalJson(resolve(artifactRoot, "quality/doctrine.json"));
}

export function validateDoctrinePolicy(policy, doctrine, traceability) {
    if (policy.edition !== "1.0.0") throw new TypeError("Doctrine policy edition is invalid");
    if (!/^[a-f0-9]{40}$/u.test(policy.adoptionBase)) {
        throw new TypeError("Doctrine adoption base is not a full commit id");
    }
    if (JSON.stringify(policy.tierOrder) !== JSON.stringify(["P", "I", "L", "D", "S"])) {
        throw new TypeError("Doctrine tier order must be P < I < L < D < S");
    }
    if (JSON.stringify(policy.approvalTiers) !== JSON.stringify(["L", "D", "S"])) {
        throw new TypeError("Doctrine approval tiers must be L, D, and S");
    }
    validateTrustRoot(policy.trustRoot);
    validateClaimSurfaces(policy.claimSurfaces);
    assertUniqueIds(policy.rules, (rule) => rule.id, "quality/doctrine.json rules");
    const actualRuleIds = policy.rules.map((rule) => rule.id);
    const documented = documentedRuleIds(doctrine);
    if (
        new Set(documented).size !== documented.length ||
        JSON.stringify(actualRuleIds) !== JSON.stringify(documented)
    ) {
        throw new TypeError("Doctrine policy and document rule denominators differ");
    }
    const milestoneRoots = new Set(
        policy.rules
            .filter((rule) => rule.state === "milestone-gated" && rule.milestone === rule.id)
            .map((rule) => rule.id)
    );
    for (const rule of policy.rules) {
        if (!CHECKER_PATHS.has(rule.checker)) {
            throw new TypeError(`Doctrine rule ${rule.id} names unknown checker ${rule.checker}`);
        }
        if (
            !Array.isArray(rule.testSelectors) ||
            rule.testSelectors.length === 0 ||
            !rule.testSelectors.every(isNonEmptyString) ||
            new Set(rule.testSelectors).size !== rule.testSelectors.length
        ) {
            throw new TypeError(`Doctrine rule ${rule.id} lacks exact test selectors`);
        }
        if (rule.state !== "active" && rule.state !== "milestone-gated") {
            throw new TypeError(`Doctrine rule ${rule.id} has unknown state ${rule.state}`);
        }
        if (rule.state === "active" && rule.milestone !== undefined) {
            throw new TypeError(`Active doctrine rule ${rule.id} names a milestone`);
        }
        if (rule.state === "milestone-gated" && !milestoneRoots.has(rule.milestone)) {
            throw new TypeError(`Doctrine rule ${rule.id} lacks a known gated milestone`);
        }
    }
    validateBacklogMilestone(policy, traceability);
    validateInfrastructureObligations(policy.infrastructureObligations, milestoneRoots);
    if (policy.formalScope?.source !== "artifacts/traceability.yaml#formalBoundary") {
        throw new TypeError("Doctrine formal scope must be owned by traceability formalBoundary");
    }
    validateFormalBoundary(traceability.formalBoundary);
    if (/every\s+`?ASM-\*`?.{0,80}(?:lean\s+axiom|axiom\s+in\s+lean)/isu.test(doctrine)) {
        throw new TypeError("Doctrine must not convert operational assumptions into Lean axioms");
    }
}

export function documentedRuleIds(doctrine) {
    const ids = [];
    const patterns = [
        /^\*\*([DG]-\d+)\s+\(/u,
        /^###\s+(G-\d+)\./u,
        /^##\s+\d+\.\s+(W-\d+):/u,
        /^###\s+(A-\d+)\./u,
        /^\|\s+\*\*(M-\d+)\*\*/u
    ];
    for (const line of doctrine.split("\n")) {
        for (const pattern of patterns) {
            const match = pattern.exec(line);
            if (match !== null) {
                ids.push(match[1]);
                break;
            }
        }
    }
    return ids;
}

export function validateFormalBoundary(boundary) {
    if (!Array.isArray(boundary?.requiredAreaIds) || !Array.isArray(boundary.areas)) {
        throw new TypeError("Traceability formalBoundary is malformed");
    }
    const required = boundary.requiredAreaIds;
    const actual = boundary.areas.map((area) => area.id);
    if (new Set(required).size !== required.length || new Set(actual).size !== actual.length) {
        throw new TypeError("Traceability formalBoundary contains duplicate area ids");
    }
    if (JSON.stringify([...required].sort()) !== JSON.stringify([...actual].sort())) {
        throw new TypeError("Traceability formalBoundary required areas and definitions differ");
    }
}

export function validateWorkflowSource(source) {
    const workflow = assertObject(
        parseYaml(source, { schema: "core", uniqueKeys: true }),
        "Doctrine workflow"
    );
    assertExactKeys(workflow, ["name", "on", "permissions", "jobs"], "Doctrine workflow");
    if (workflow.name !== "verify") throw new TypeError("Doctrine workflow has an unknown name");
    const events = assertObject(workflow.on, "Doctrine workflow events");
    if (Object.hasOwn(events, "pull_request_target")) {
        throw new TypeError("Doctrine change control must not use pull_request_target");
    }
    for (const required of ["push", "pull_request", "pull_request_review"]) {
        if (!Object.hasOwn(events, required)) {
            throw new TypeError(`Doctrine workflow lacks the ${required} event`);
        }
    }
    assertExactKeys(
        events,
        ["push", "pull_request", "pull_request_review"],
        "Doctrine workflow events"
    );
    const push = assertObject(events.push, "Doctrine workflow push event");
    assertExactKeys(push, ["branches"], "Doctrine workflow push event");
    const branches = assertArray(push.branches, "Doctrine workflow push branches");
    if (branches.length !== 1 || branches[0] !== "main") {
        throw new TypeError("Doctrine workflow must run only on pushes to main");
    }
    const pullRequest = assertObject(events.pull_request, "Doctrine workflow pull_request event");
    assertExactKeys(pullRequest, ["types"], "Doctrine workflow pull_request event");
    const pullRequestTypes = assertArray(
        pullRequest.types,
        "Doctrine workflow pull_request event types"
    );
    if (
        JSON.stringify(pullRequestTypes) !==
        JSON.stringify(["opened", "reopened", "synchronize", "edited"])
    ) {
        throw new TypeError(
            "Doctrine workflow pull_request events must include every metadata-changing route"
        );
    }
    const review = assertObject(
        events.pull_request_review,
        "Doctrine workflow pull_request_review event"
    );
    assertExactKeys(review, ["types"], "Doctrine workflow pull_request_review event");
    const reviewTypes = assertArray(review.types, "Doctrine workflow pull_request_review types");
    if (JSON.stringify(reviewTypes) !== JSON.stringify(["submitted", "dismissed"])) {
        throw new TypeError("Doctrine workflow review events must be submitted and dismissed");
    }
    validateReadOnlyPermissions(workflow.permissions, "Doctrine workflow permissions");

    const jobs = assertObject(workflow.jobs, "Doctrine workflow jobs");
    assertExactKeys(jobs, ["change-control", "verify"], "Doctrine workflow jobs");

    const changeControl = assertObject(jobs["change-control"], "Doctrine change-control job");
    if (Object.hasOwn(changeControl, "if") || Object.hasOwn(changeControl, "continue-on-error")) {
        throw new TypeError("Doctrine change-control job must run unconditionally and fail closed");
    }
    assertExactKeys(
        changeControl,
        ["runs-on", "timeout-minutes", "steps"],
        "Doctrine change-control job"
    );
    if (changeControl["runs-on"] !== "ubuntu-24.04" || changeControl["timeout-minutes"] !== 5) {
        throw new TypeError("Doctrine change-control job has an unreviewed runner or timeout");
    }
    const verify = assertObject(jobs.verify, "Doctrine verify job");
    const changeSteps = assertArray(changeControl.steps, "Doctrine change-control steps").map(
        (step, index) => assertObject(step, `Doctrine change-control step ${index}`)
    );
    if (changeSteps.length !== 3) {
        throw new TypeError(
            "Doctrine change-control job must contain exactly three reviewed steps"
        );
    }
    if (
        changeSteps.some(
            (step) => Object.hasOwn(step, "if") || Object.hasOwn(step, "continue-on-error")
        )
    ) {
        throw new TypeError("Doctrine change-control steps must fail closed");
    }
    const checkout = changeSteps[0];
    const setupNode = changeSteps[1];
    const command = changeSteps[2];
    assertExactKeys(checkout, ["uses", "with"], "Doctrine change-control checkout step");
    assertExactKeys(setupNode, ["uses", "with"], "Doctrine change-control setup-node step");
    assertExactKeys(command, ["name", "env", "run"], "Doctrine change-control verifier step");
    const checkoutWith = assertObject(checkout.with, "Doctrine change-control checkout inputs");
    assertExactKeys(
        checkoutWith,
        ["fetch-depth", "ref"],
        "Doctrine change-control checkout inputs"
    );
    if (checkout.uses !== CHECKOUT_ACTION) {
        throw new TypeError("Doctrine change-control checkout uses an unreviewed action");
    }
    if (
        checkoutWith["fetch-depth"] !== 0 ||
        checkoutWith.ref !== "${{ github.event.pull_request.head.sha || github.sha }}"
    ) {
        throw new TypeError("Doctrine change-control checkout lacks exact history or head inputs");
    }
    const setupNodeWith = assertObject(setupNode.with, "Doctrine change-control setup-node inputs");
    assertExactKeys(
        setupNodeWith,
        ["node-version-file"],
        "Doctrine change-control setup-node inputs"
    );
    if (setupNode.uses !== SETUP_NODE_ACTION) {
        throw new TypeError("Doctrine change-control setup-node uses an unreviewed action");
    }
    if (setupNodeWith["node-version-file"] !== ".node-version") {
        throw new TypeError("Doctrine change-control setup-node step is not pinned to policy");
    }
    if (
        !isNonEmptyString(command.run) ||
        command.run !==
            'node packages/agent-core/scripts/quality/change-control.mjs --base "$CHANGE_BASE" --head "$CHANGE_HEAD" --event "$GITHUB_EVENT_PATH" --repository "$GITHUB_REPOSITORY"'
    ) {
        throw new TypeError("Doctrine change-control job lacks the exact verifier command");
    }
    const environment = assertObject(command.env, "Doctrine change-control environment");
    const requiredEnvironment = {
        CHANGE_BASE: "${{ github.event.pull_request.base.sha || github.event.before }}",
        CHANGE_HEAD: "${{ github.event.pull_request.head.sha || github.event.after }}",
        GITHUB_TOKEN: "${{ github.token }}"
    };
    for (const [name, value] of Object.entries(requiredEnvironment)) {
        if (environment[name] !== value) {
            throw new TypeError(`Doctrine change-control environment lacks ${name}`);
        }
    }
    assertExactKeys(
        environment,
        Object.keys(requiredEnvironment),
        "Doctrine change-control environment"
    );
    validateVerifyJob(verify);
}

function validateVerifyJob(job) {
    assertExactKeys(job, ["if", "runs-on", "timeout-minutes", "steps"], "Doctrine verify job");
    if (
        job.if !== "github.event_name != 'pull_request_review'" ||
        job["runs-on"] !== "ubuntu-24.04" ||
        job["timeout-minutes"] !== 90
    ) {
        throw new TypeError("Doctrine verify job has an unreviewed gate, runner, or timeout");
    }
    const steps = assertArray(job.steps, "Doctrine verify steps").map((step, index) =>
        assertObject(step, `Doctrine verify step ${index}`)
    );
    if (steps.length !== 9) {
        throw new TypeError("Doctrine verify job must contain exactly nine reviewed steps");
    }
    const [
        checkout,
        setupNode,
        setupBun,
        enableCorepack,
        installLean,
        cache,
        install,
        verify,
        upload
    ] = steps;

    assertActionStep(checkout, "Doctrine verify checkout step", CHECKOUT_ACTION, ["with"]);
    const checkoutWith = assertObject(checkout.with, "Doctrine verify checkout inputs");
    assertExactKeys(checkoutWith, ["fetch-depth"], "Doctrine verify checkout inputs");
    if (checkoutWith["fetch-depth"] !== 0) {
        throw new TypeError("Doctrine verify checkout must retain complete history");
    }

    assertActionStep(setupNode, "Doctrine verify setup-node step", SETUP_NODE_ACTION, ["with"]);
    const nodeWith = assertObject(setupNode.with, "Doctrine verify setup-node inputs");
    assertExactKeys(nodeWith, ["node-version-file"], "Doctrine verify setup-node inputs");
    if (nodeWith["node-version-file"] !== ".node-version") {
        throw new TypeError("Doctrine verify setup-node must use repository policy");
    }

    assertActionStep(setupBun, "Doctrine verify setup-bun step", SETUP_BUN_ACTION, ["with"]);
    const bunWith = assertObject(setupBun.with, "Doctrine verify setup-bun inputs");
    assertExactKeys(bunWith, ["bun-version-file"], "Doctrine verify setup-bun inputs");
    if (bunWith["bun-version-file"] !== ".bun-version") {
        throw new TypeError("Doctrine verify setup-bun must use repository policy");
    }

    assertRunStep(
        enableCorepack,
        "Doctrine verify corepack step",
        "Enable the pinned package manager",
        "corepack enable"
    );
    assertRunStep(
        installLean,
        "Doctrine verify Lean step",
        "Install the pinned Lean toolchain",
        `${LEAN_INSTALL_SCRIPT}\n`
    );

    assertActionStep(cache, "Doctrine verify Lean cache step", CACHE_ACTION, ["name", "with"]);
    if (cache.name !== "Cache Lean toolchain and build products") {
        throw new TypeError("Doctrine verify Lean cache step has an unreviewed name");
    }
    const cacheWith = assertObject(cache.with, "Doctrine verify Lean cache inputs");
    assertExactKeys(
        cacheWith,
        ["path", "key", "restore-keys"],
        "Doctrine verify Lean cache inputs"
    );
    if (
        cacheWith.path !== "~/.elan/toolchains\npackages/agent-core/formal/.lake\n" ||
        cacheWith.key !==
            "lean-${{ hashFiles('packages/agent-core/formal/lean-toolchain') }}-${{ hashFiles('packages/agent-core/formal/**/*.lean') }}" ||
        cacheWith["restore-keys"] !==
            "lean-${{ hashFiles('packages/agent-core/formal/lean-toolchain') }}-\n"
    ) {
        throw new TypeError("Doctrine verify Lean cache inputs are not exact");
    }

    assertRunStep(
        install,
        "Doctrine verify dependency step",
        "Install dependencies",
        "pnpm install --frozen-lockfile"
    );
    assertRunStep(verify, "Doctrine verify command step", "Verify", "pnpm verify");

    assertActionStep(upload, "Doctrine verify upload step", UPLOAD_ACTION, ["name", "if", "with"]);
    if (upload.name !== "Upload quality reports" || upload.if !== "failure()") {
        throw new TypeError("Doctrine verify upload must run only after failure");
    }
    const uploadWith = assertObject(upload.with, "Doctrine verify upload inputs");
    assertExactKeys(
        uploadWith,
        ["name", "path", "if-no-files-found"],
        "Doctrine verify upload inputs"
    );
    if (
        uploadWith.name !== "quality-reports" ||
        uploadWith.path !==
            "packages/agent-core/reports/quality\npackages/agent-core-cloudflare/reports/quality\n" ||
        uploadWith["if-no-files-found"] !== "ignore"
    ) {
        throw new TypeError("Doctrine verify upload inputs are not exact");
    }
}

function assertActionStep(step, owner, action, extraKeys) {
    assertExactKeys(step, ["uses", ...extraKeys], owner);
    if (step.uses !== action) throw new TypeError(`${owner} uses an unreviewed action`);
}

function assertRunStep(step, owner, name, command) {
    assertExactKeys(step, ["name", "run"], owner);
    if (step.name !== name || step.run !== command) {
        throw new TypeError(`${owner} is not the exact reviewed command`);
    }
}

function validateReadOnlyPermissions(value, owner) {
    const permissions = assertObject(value, owner);
    assertExactKeys(permissions, ["contents", "pull-requests"], owner);
    if (Object.values(permissions).some((permission) => permission === "write")) {
        throw new TypeError("Doctrine workflow must not grant write permissions");
    }
    if (permissions.contents !== "read" || permissions["pull-requests"] !== "read") {
        throw new TypeError(`${owner} lacks required read permissions`);
    }
    if (Object.values(permissions).some((permission) => !["read", "none"].includes(permission))) {
        throw new TypeError(`${owner} contains an invalid permission level`);
    }
}

async function main() {
    const policy = await readDoctrinePolicy();
    const doctrinePath = resolve(repositoryRoot, "AGENT_OPERATING_DOCTRINE.md");
    const doctrine = await readFile(doctrinePath, "utf8");
    const traceability = await readCanonicalJson(resolve(artifactRoot, "traceability.yaml"));
    validateDoctrinePolicy(policy, doctrine, traceability);
    const agents = await readFile(resolve(repositoryRoot, "AGENTS.md"), "utf8");
    if (!agents.includes("`AGENT_OPERATING_DOCTRINE.md` governs claim integrity")) {
        throw new TypeError("AGENTS.md lacks the mandatory doctrine stop line");
    }
    const codeowners = await readFile(resolve(repositoryRoot, ".github/CODEOWNERS"), "utf8");
    if (!codeowners.split("\n").some((line) => line.startsWith("/AGENT_OPERATING_DOCTRINE.md "))) {
        throw new TypeError("The doctrine lacks an exact CODEOWNERS rule");
    }
    validateWorkflowSource(
        await readFile(resolve(repositoryRoot, ".github/workflows/verify.yml"), "utf8")
    );
    for (const rule of policy.rules) {
        await access(resolve(packageRoot, rule.checker));
    }
    await writeCanonicalJson(resolve(packageRoot, "reports/quality/doctrine.json"), {
        edition: "1.0.0",
        adoptionBase: policy.adoptionBase,
        rules: policy.rules.map((rule) => ({ id: rule.id, state: rule.state })),
        complete: true
    });
    console.log(`Doctrine controls verified: ${policy.rules.length} rules`);
}

function validateTrustRoot(trustRoot) {
    for (const [field, value] of Object.entries(trustRoot ?? {})) {
        if (!isNonEmptyString(value))
            throw new TypeError(`Doctrine trust root ${field} is invalid`);
    }
    if (
        trustRoot?.path !== ".github/CODEOWNERS" ||
        trustRoot.protectedPath !== "/AGENT_OPERATING_DOCTRINE.md" ||
        trustRoot.bootstrapPath !== "/AGENTS.md"
    ) {
        throw new TypeError("Doctrine trust root is not the reviewed CODEOWNERS bootstrap path");
    }
}

function validateClaimSurfaces(paths) {
    if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) {
        throw new TypeError("Doctrine claim surfaces are empty or duplicated");
    }
    for (const path of paths) {
        if (!isNonEmptyString(path) || path.startsWith("/") || path.includes("..")) {
            throw new TypeError(`Doctrine claim surface is invalid: ${path}`);
        }
    }
}

function validateInfrastructureObligations(obligations, milestoneRoots) {
    if (!Array.isArray(obligations)) {
        throw new TypeError("Doctrine infrastructure obligations are malformed");
    }
    assertUniqueIds(obligations, (obligation) => obligation.id, "doctrine infrastructure");
    const actual = obligations.map((obligation) => obligation.id).sort();
    const expected = [...milestoneRoots].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(
            "Doctrine infrastructure obligations do not cover every gated milestone"
        );
    }
    for (const obligation of obligations) {
        if (
            obligation.disposition !== "candidate" ||
            obligation.owner !== "W0" ||
            obligation.priority !== 1
        ) {
            throw new TypeError(`Doctrine infrastructure obligation ${obligation.id} is invalid`);
        }
        validateMilestoneOracle(obligation.id, obligation.oracle);
    }
}

function validateMilestoneOracle(id, oracle) {
    const owner = `Doctrine infrastructure obligation ${id} oracle`;
    if (id === "M-1") {
        assertExactKeys(
            oracle,
            [
                "kind",
                "repository",
                "branch",
                "requiredChecks",
                "allowBypass",
                "approvalRoutes",
                "codeOwnerRoute",
                "signatureRoute"
            ],
            owner
        );
        if (
            oracle.kind !== "github-default-branch-controls" ||
            oracle.repository !== "AshishKumar4/agent-core" ||
            oracle.branch !== "main" ||
            JSON.stringify(oracle.requiredChecks) !==
                JSON.stringify(["change-control", "verify"]) ||
            oracle.allowBypass !== false ||
            oracle.approvalRoutes !== "independent-codeowner-review-or-required-signed-commits" ||
            oracle.codeOwnerRoute !== "required-review-and-stale-dismissal" ||
            oracle.signatureRoute !== "required-signed-commits-and-non-agent-held-key"
        ) {
            throw new TypeError(`${owner} does not encode the required external controls`);
        }
        return;
    }
    if (id === "M-2") {
        assertExactKeys(oracle, ["kind", "source", "schema", "expectedLegacyCount"], owner);
        if (
            oracle.kind !== "typed-source-obligations" ||
            oracle.source !== "artifacts/traceability.yaml#requirements[].remainingEvidence[]" ||
            oracle.schema !== "traceability-source-obligation-v1" ||
            oracle.expectedLegacyCount !== 0
        ) {
            throw new TypeError(`${owner} does not require zero untyped sources`);
        }
        return;
    }
    if (id === "M-6") {
        assertExactKeys(
            oracle,
            [
                "kind",
                "transpilerChecker",
                "transpilerEvidence",
                "quintChecker",
                "quintEvidence",
                "expected"
            ],
            owner
        );
        if (
            oracle.kind !== "composite-checker-artifacts" ||
            !validMachinePath(oracle.transpilerChecker, "scripts/quality/", ".mjs") ||
            !validMachinePath(oracle.transpilerEvidence, "artifacts/", ".json") ||
            !validMachinePath(oracle.quintChecker, "scripts/quality/", ".mjs") ||
            !validMachinePath(oracle.quintEvidence, "artifacts/", ".json") ||
            !isNonEmptyString(oracle.expected)
        ) {
            throw new TypeError(`${owner} is not an exact composite checker oracle`);
        }
        return;
    }
    assertExactKeys(oracle, ["kind", "checker", "registry", "evidence", "expected"], owner);
    if (
        oracle.kind !== "checker-artifacts" ||
        !validMachinePath(oracle.checker, "scripts/quality/", ".mjs") ||
        !validMachinePath(oracle.registry, "artifacts/", ".json") ||
        !validMachinePath(oracle.evidence, "artifacts/", ".json") ||
        !isNonEmptyString(oracle.expected)
    ) {
        throw new TypeError(`${owner} is not an exact checker-and-artifact oracle`);
    }
    if (
        id === "A-2" &&
        (oracle.registry !== "artifacts/findings/index.json" ||
            oracle.evidence !== "artifacts/findings/resolutions.json")
    ) {
        throw new TypeError(`${owner} does not use the reviewed findings namespace`);
    }
}

function validMachinePath(value, prefix, suffix) {
    return (
        isNonEmptyString(value) &&
        value.startsWith(prefix) &&
        value.endsWith(suffix) &&
        !value.includes("..")
    );
}

function validateBacklogMilestone(policy, traceability) {
    const milestone = policy.rules.find((rule) => rule.id === "M-2");
    const workflow = policy.rules.find((rule) => rule.id === "W-2");
    if (
        milestone?.state !== workflow?.state ||
        (milestone.state === "milestone-gated" && workflow.milestone !== "M-2")
    ) {
        throw new TypeError("W-2 and M-2 must share the M-2 milestone state");
    }
    if (!Array.isArray(traceability.requirements)) {
        throw new TypeError("Traceability requirements are malformed");
    }
    let legacyCount = 0;
    const sourceIds = new Set();
    for (const requirement of traceability.requirements) {
        if (!Array.isArray(requirement.remainingEvidence)) {
            throw new TypeError(
                `Traceability requirement ${requirement.id} has malformed source obligations`
            );
        }
        for (const obligation of requirement.remainingEvidence) {
            if (jsonKind(obligation) === "string") {
                legacyCount += 1;
                continue;
            }
            validateSourceObligation(requirement.id, obligation, sourceIds);
        }
    }
    if (milestone.state === "active" && legacyCount > 0) {
        throw new TypeError(
            `M-2 cannot be active while traceability contains untyped source obligations (${legacyCount})`
        );
    }
}

function validateSourceObligation(requirementId, obligation, sourceIds) {
    const owner = `Traceability requirement ${requirementId} source obligation`;
    assertExactKeys(
        obligation,
        ["id", "summary", "disposition", "owner", "priority", "oracle"],
        owner
    );
    if (
        !isNonEmptyString(obligation.id) ||
        !isNonEmptyString(obligation.summary) ||
        !SOURCE_DISPOSITIONS.has(obligation.disposition) ||
        !isNonEmptyString(obligation.owner) ||
        !Number.isInteger(obligation.priority) ||
        obligation.priority < 1
    ) {
        throw new TypeError(`${owner} has invalid typed fields`);
    }
    if (sourceIds.has(obligation.id)) {
        throw new TypeError(`Duplicate traceability source obligation ${obligation.id}`);
    }
    sourceIds.add(obligation.id);
    assertExactKeys(obligation.oracle, ["kind", "selector", "expected"], `${owner} oracle`);
    if (
        !isNonEmptyString(obligation.oracle.kind) ||
        !isNonEmptyString(obligation.oracle.selector) ||
        !isNonEmptyString(obligation.oracle.expected)
    ) {
        throw new TypeError(`${owner} lacks an exact machine oracle`);
    }
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) await main();
