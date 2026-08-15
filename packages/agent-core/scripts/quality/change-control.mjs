import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    artifactRoot,
    isJsonObject,
    isNonEmptyString,
    parseCanonicalJson,
    readCanonicalJson,
    repositoryRoot,
    sha256
} from "./project.mjs";

const TIERS = ["P", "I", "L", "D", "S"];
const APPROVAL_TIERS = ["L", "D", "S"];
const BOOTSTRAP_TRUST_ROOT = {
    path: ".github/CODEOWNERS",
    protectedPath: "/AGENT_OPERATING_DOCTRINE.md",
    bootstrapPath: "/AGENTS.md"
};
const CONTROL_PATHS = [
    ".github/",
    "AGENT_OPERATING_DOCTRINE.md",
    "AGENTS.md",
    "package.json",
    "packages/agent-core/package.json",
    "packages/agent-core/scripts/",
    "packages/agent-core/test/quality/",
    "packages/agent-core/artifacts/quality/",
    "packages/agent-core-cloudflare/scripts/",
    "packages/agent-core-harness/scripts/",
    "tools/oxlint/"
];
function isControlPath(path) {
    return (
        CONTROL_PATHS.some((prefix) => path === prefix || path.startsWith(prefix)) ||
        [
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            ".bun-version",
            ".node-version",
            ".oxlintrc.json",
            ".prettierignore",
            ".prettierrc.json"
        ].includes(path) ||
        path.endsWith("/package.json") ||
        /(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s)$/u.test(path)
    );
}

function isImplementationPath(path) {
    return [
        "packages/agent-core/src/",
        "packages/agent-core/test/",
        "packages/agent-core-cloudflare/src/",
        "packages/agent-core-cloudflare/test/",
        "packages/agent-core-harness/src/",
        "packages/agent-core-harness/test/"
    ].some((prefix) => path.startsWith(prefix));
}

export function classifyChange(paths, lockChanged, claimSurfaces) {
    const categories = new Set();
    for (const path of paths) {
        let classified = false;
        if (path === "packages/agent-core/SPEC.md") {
            categories.add("S");
            classified = true;
        }
        if (
            path === "packages/agent-core/artifacts/traceability.yaml" ||
            path.startsWith("packages/agent-core/artifacts/conformance/")
        ) {
            categories.add("L");
            classified = true;
        }
        if (
            path === "packages/agent-core/artifacts/normative.lock" ||
            path.startsWith("packages/agent-core/artifacts/scenarios/") ||
            isControlPath(path)
        ) {
            categories.add("D");
            classified = true;
        }
        if (path.startsWith("packages/agent-core/formal/")) {
            categories.add(lockChanged ? "D" : "P");
            classified = true;
        }
        if (claimSurfaces.has(path)) {
            categories.add("L");
            classified = true;
        }
        if (!classified) {
            categories.add(path.endsWith(".md") ? "L" : isImplementationPath(path) ? "I" : "D");
        }
    }
    if (categories.size === 0) throw new TypeError("Change-control diff is empty");
    const ordered = TIERS.filter((tier) => categories.has(tier));
    return { categories: ordered, tier: ordered.at(-1) };
}

export function validateReviewedBase(mergeBase, base) {
    if (mergeBase !== base) {
        throw new TypeError("Reviewed head is not based on the exact change-control base");
    }
}

export function parseChangeMetadata(body, knownRules) {
    const tiers = [...body.matchAll(/^Change-Tier:\s*([PIDLS])\s*$/gmu)].map((match) => match[1]);
    if (tiers.length !== 1) throw new TypeError("PR body must declare exactly one Change-Tier");
    const rules = [...body.matchAll(/^Doctrine-Rules:\s*(.+?)\s*$/gmu)];
    if (rules.length !== 1) {
        throw new TypeError("PR body must declare exactly one Doctrine-Rules line");
    }
    const ruleIds = rules[0][1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (ruleIds.length === 0 || new Set(ruleIds).size !== ruleIds.length) {
        throw new TypeError("Doctrine-Rules must contain unique rule ids");
    }
    for (const id of ruleIds) {
        if (!knownRules.has(id)) throw new TypeError(`Doctrine-Rules names unknown rule ${id}`);
    }
    const corrections = [...body.matchAll(/^Integrity-Correction:\s*(\S+)\s*$/gmu)];
    if (corrections.length > 1) {
        throw new TypeError("PR body declares more than one Integrity-Correction");
    }
    return {
        tier: tiers[0],
        ruleIds,
        integrityCorrection: corrections[0]?.[1]
    };
}

export function validateExactHeadApproval(reviews, trustedReviewers, head) {
    const approved = exactHeadApproval(reviews, trustedReviewers, head);
    if (approved === undefined) {
        throw new TypeError("No trusted CODEOWNER approved the exact reviewed head commit");
    }
    return approved;
}

function exactHeadApproval(reviews, trustedReviewers, head) {
    const latest = new Map();
    for (const review of reviews) {
        const login = review.user?.login?.toLowerCase();
        if (!isNonEmptyString(login) || !trustedReviewers.has(login)) continue;
        if (review.state === "COMMENTED" || review.state === "PENDING") continue;
        if (!Number.isSafeInteger(review.id) || review.id < 1) {
            throw new TypeError(`Trusted CODEOWNER review from ${login} has no stable review id`);
        }
        const previous = latest.get(login);
        if (previous === undefined || review.id > previous.id) latest.set(login, review);
    }
    return [...latest.entries()].find(
        ([, review]) => review.state === "APPROVED" && review.commit_id === head
    )?.[0];
}

export function validateVerifiedCommitApproval(commit, trustedReviewers, head) {
    if (!isJsonObject(commit) || commit.oid !== head) {
        throw new TypeError("Signed approval does not bind the exact reviewed head commit");
    }
    const signature = commit.signature;
    if (
        !isJsonObject(signature) ||
        signature.isValid !== true ||
        signature.state !== "VALID" ||
        signature.wasSignedByGitHub !== false ||
        !isNonEmptyString(signature.signature) ||
        !isNonEmptyString(signature.payload) ||
        !isNonEmptyString(signature.verifiedAt)
    ) {
        throw new TypeError("Reviewed head lacks a valid maintainer-controlled commit signature");
    }
    const signer = isJsonObject(signature.signer) ? signature.signer.login : undefined;
    const login = isNonEmptyString(signer) ? signer.toLowerCase() : undefined;
    if (login === undefined || !trustedReviewers.has(login)) {
        throw new TypeError("Reviewed head signature does not belong to a trusted CODEOWNER");
    }
    return login;
}

export function ownersForProtectedPath(source, protectedPath, bootstrapPath, bootstrap) {
    const candidates = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    for (const candidate of candidates) {
        const [pattern, ...owners] = candidate.split(/\s+/u);
        if (
            !pattern.startsWith("/") ||
            pattern.includes("..") ||
            /[*?[\]!\\]/u.test(pattern) ||
            owners.length === 0
        ) {
            throw new TypeError(
                `CODEOWNERS trust root requires absolute, non-pattern ownership rules: ${candidate}`
            );
        }
    }
    const wanted = bootstrap ? [protectedPath, bootstrapPath] : [protectedPath];
    for (const path of wanted) {
        const line = candidates.filter((candidate) => candidate.split(/\s+/u)[0] === path).at(-1);
        if (line === undefined) continue;
        const owners = line
            .split(/\s+/u)
            .slice(1)
            .filter((owner) => owner.startsWith("@") && !owner.includes("/"))
            .map((owner) => owner.slice(1).toLowerCase());
        if (owners.length > 0) return new Set(owners);
    }
    throw new TypeError(`Base CODEOWNERS has no trusted owner for ${protectedPath}`);
}

export function enforceNormativeFreeze(paths, policy, metadata, base) {
    if (base === policy.adoptionBase) {
        const forbiddenBootstrapPath = paths.find(
            (path) =>
                path === "packages/agent-core/SPEC.md" ||
                path.startsWith("packages/agent-core/artifacts/scenarios/") ||
                (path.startsWith("packages/agent-core/formal/") &&
                    path !== "packages/agent-core/formal/AgentCore/Normative.lean")
        );
        if (forbiddenBootstrapPath !== undefined) {
            throw new TypeError(
                `Doctrine bootstrap includes unrelated normative change ${forbiddenBootstrapPath}`
            );
        }
        return;
    }
    const states = new Map(policy.rules.map((rule) => [rule.id, rule.state]));
    const semanticFormal = paths.some(
        (path) =>
            path.startsWith("packages/agent-core/formal/") ||
            path.startsWith("packages/agent-core/artifacts/scenarios/")
    );
    const spec = paths.includes("packages/agent-core/SPEC.md");
    if (!semanticFormal && !spec) return;
    if (states.get("M-5") === "active" && states.get("A-2") === "active") return;
    if (metadata.integrityCorrection === undefined) {
        throw new TypeError("Normative semantic changes are frozen until M-5 and A-2 are active");
    }
    const incidentPath = `packages/agent-core/artifacts/stuck/${metadata.integrityCorrection}.json`;
    if (!paths.includes(incidentPath)) {
        throw new TypeError(`Integrity correction lacks ${incidentPath}`);
    }
}

export function validateIntegrityCorrection(record, id, knownRules, expectedDigests) {
    if (!isJsonObject(record) || record.edition !== "1.0.0" || record.id !== id) {
        throw new TypeError(`Integrity correction ${id} has invalid identity or edition`);
    }
    const nonemptyFields = ["task", "obstruction", "weakeningRejected", "recommendation"];
    for (const field of nonemptyFields) {
        if (!isNonEmptyString(record[field])) {
            throw new TypeError(`Integrity correction ${id} lacks ${field}`);
        }
    }
    for (const field of ["ruleIds", "alternatives", "evidence", "affectedClaimIds"]) {
        const values = record[field];
        if (
            !Array.isArray(values) ||
            values.length === 0 ||
            !values.every(isNonEmptyString) ||
            new Set(values).size !== values.length
        ) {
            throw new TypeError(`Integrity correction ${id} has invalid ${field}`);
        }
    }
    for (const ruleId of record.ruleIds) {
        if (!knownRules.has(ruleId)) {
            throw new TypeError(`Integrity correction ${id} names unknown rule ${ruleId}`);
        }
    }
    for (const field of [
        "beforeNormativeManifest",
        "afterNormativeManifest",
        "beforeSpec",
        "afterSpec"
    ]) {
        if (!/^sha256:[a-f0-9]{64}$/u.test(record[field] ?? "")) {
            throw new TypeError(`Integrity correction ${id} has invalid ${field}`);
        }
        if (record[field] !== expectedDigests[field]) {
            throw new TypeError(`Integrity correction ${id} does not bind the exact ${field}`);
        }
    }
    if (
        !isJsonObject(record.adversaryReview) ||
        record.adversaryReview.mode !== "human" ||
        record.adversaryReview.verdict !== "accepted-integrity-correction" ||
        !isNonEmptyString(record.adversaryReview.report)
    ) {
        throw new TypeError(`Integrity correction ${id} lacks a human adversary review`);
    }
}

async function main() {
    const options = {
        ...parseChangeControlArguments(process.argv.slice(2)),
        token: process.env.GITHUB_TOKEN
    };
    const candidatePolicy = await readCanonicalJson(resolve(artifactRoot, "quality/doctrine.json"));
    const policyPath = "packages/agent-core/artifacts/quality/doctrine.json";
    const basePolicySource = gitBlob(options.base, policyPath);
    const policy = selectEffectivePolicy(
        basePolicySource === "absent"
            ? undefined
            : parseCanonicalJson(gitText(options.base, policyPath), policyPath),
        candidatePolicy,
        options.base
    );
    const paths = gitLines(["diff", "--name-only", `${options.base}...${options.head}`]);
    const lockChanged =
        gitBlob(options.base, "packages/agent-core/artifacts/normative.lock") !==
        gitBlob(options.head, "packages/agent-core/artifacts/normative.lock");
    const classification = classifyChange(paths, lockChanged, new Set(policy.claimSurfaces));
    const context = await approvalContext(options);
    validateReviewedBase(git(["merge-base", options.base, context.reviewHead]), options.base);
    const knownRules = new Set(policy.rules.map((rule) => rule.id));
    const metadata = parseChangeMetadata(context.body, knownRules);
    if (metadata.tier !== classification.tier) {
        throw new TypeError(
            `Declared tier ${metadata.tier} differs from effective tier ${classification.tier}`
        );
    }
    enforceNormativeFreeze(paths, policy, metadata, options.base);
    if (metadata.integrityCorrection !== undefined) {
        const incidentPath = `packages/agent-core/artifacts/stuck/${metadata.integrityCorrection}.json`;
        validateIntegrityCorrection(
            parseCanonicalJson(gitText(options.head, incidentPath), incidentPath),
            metadata.integrityCorrection,
            knownRules,
            {
                beforeNormativeManifest: gitContentHash(
                    options.base,
                    "packages/agent-core/artifacts/normative.lock"
                ),
                afterNormativeManifest: gitContentHash(
                    options.head,
                    "packages/agent-core/artifacts/normative.lock"
                ),
                beforeSpec: gitContentHash(options.base, "packages/agent-core/SPEC.md"),
                afterSpec: gitContentHash(options.head, "packages/agent-core/SPEC.md")
            }
        );
    }
    let approval = null;
    if (policy.approvalTiers.includes(classification.tier)) {
        const codeowners = gitText(options.base, policy.trustRoot.path);
        const trusted = ownersForProtectedPath(
            codeowners,
            policy.trustRoot.protectedPath,
            policy.trustRoot.bootstrapPath,
            options.base === policy.adoptionBase
        );
        const reviewer = exactHeadApproval(context.reviews, trusted, context.reviewHead);
        if (reviewer === undefined) {
            approval = {
                kind: "verified-commit-signature",
                principal: validateVerifiedCommitApproval(
                    await githubCommitSignature(options, context.reviewHead),
                    trusted,
                    context.reviewHead
                )
            };
        } else {
            approval = { kind: "exact-head-codeowner-review", principal: reviewer };
        }
    }
    console.log(
        JSON.stringify({
            edition: "1.0.0",
            base: options.base,
            head: options.head,
            categories: classification.categories,
            effectiveTier: classification.tier,
            doctrineRules: metadata.ruleIds,
            approval
        })
    );
}

export function selectEffectivePolicy(basePolicy, candidatePolicy, base) {
    if (basePolicy !== undefined) return basePolicy;
    if (candidatePolicy.adoptionBase !== base) {
        throw new TypeError("Doctrine bootstrap policy does not bind the exact adoption base");
    }
    if (
        candidatePolicy.edition !== "1.0.0" ||
        JSON.stringify(candidatePolicy.tierOrder) !== JSON.stringify(TIERS) ||
        JSON.stringify(candidatePolicy.approvalTiers) !== JSON.stringify(APPROVAL_TIERS) ||
        candidatePolicy.trustRoot?.path !== BOOTSTRAP_TRUST_ROOT.path ||
        candidatePolicy.trustRoot.protectedPath !== BOOTSTRAP_TRUST_ROOT.protectedPath ||
        candidatePolicy.trustRoot.bootstrapPath !== BOOTSTRAP_TRUST_ROOT.bootstrapPath
    ) {
        throw new TypeError("Doctrine bootstrap policy does not preserve the built-in trust root");
    }
    return candidatePolicy;
}

async function approvalContext(options) {
    if (options.event === undefined) {
        if (options.body === undefined) {
            throw new TypeError("Local change-control requires --body with reviewed metadata");
        }
        return {
            body: await readFile(options.body, "utf8"),
            reviews: [],
            reviewHead: options.head
        };
    }
    const payload = parseCanonicalJson(await readFile(options.event, "utf8"), options.event);
    if (payload.pull_request !== undefined) {
        if (
            payload.pull_request.base.sha !== options.base ||
            payload.pull_request.head.sha !== options.head
        ) {
            throw new TypeError("Pull request event base/head does not match change-control input");
        }
        return {
            body: payload.pull_request.body ?? "",
            reviews: await githubPages(
                options,
                `/repos/${options.repository}/pulls/${payload.pull_request.number}/reviews`
            ),
            reviewHead: options.head
        };
    }
    if (payload.before !== options.base || payload.after !== options.head) {
        throw new TypeError("Push event base/head does not match change-control input");
    }
    const pulls = await githubPages(
        options,
        `/repos/${options.repository}/commits/${options.head}/pulls`
    );
    const pull = selectMergedPull(pulls, options.head, options.base);
    if (pull === undefined)
        throw new TypeError("Protected push has no associated merged pull request");
    return {
        body: pull.body ?? "",
        reviews: await githubPages(
            options,
            `/repos/${options.repository}/pulls/${pull.number}/reviews`
        ),
        reviewHead: pull.head.sha
    };
}

export function selectMergedPull(pulls, head, base) {
    const matches = pulls.filter(
        (candidate) =>
            candidate.merged_at !== null &&
            candidate.merge_commit_sha === head &&
            candidate.base?.sha === base
    );
    if (matches.length > 1) {
        throw new TypeError("Protected push resolves to multiple merged pull requests");
    }
    return matches[0];
}

async function githubPages(options, path) {
    if (options.repository === undefined || options.token === undefined) {
        throw new TypeError("GitHub approval verification requires repository and token");
    }
    const values = [];
    for (let page = 1; ; page += 1) {
        const separator = path.includes("?") ? "&" : "?";
        const response = await fetch(
            `https://api.github.com${path}${separator}per_page=100&page=${page}`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${options.token}`,
                    "X-GitHub-Api-Version": "2022-11-28"
                }
            }
        );
        if (!response.ok) throw new TypeError(`GitHub approval query failed: ${response.status}`);
        const pageValues = parseCanonicalJson(await response.text(), `GitHub API ${path}`);
        if (!Array.isArray(pageValues)) throw new TypeError("GitHub approval query was not a list");
        values.push(...pageValues);
        if (pageValues.length < 100) return values;
    }
}

async function githubCommitSignature(options, head) {
    if (options.repository === undefined || options.token === undefined) {
        throw new TypeError("GitHub approval verification requires repository and token");
    }
    const [owner, name, extra] = options.repository.split("/");
    if (!isNonEmptyString(owner) || !isNonEmptyString(name) || extra !== undefined) {
        throw new TypeError("GitHub repository must have owner/name form");
    }
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({
            query: `query DoctrineCommitSignature($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        oid
        signature {
          isValid
          state
          wasSignedByGitHub
          signer { login }
          signature
          payload
          verifiedAt
        }
      }
    }
  }
}`,
            variables: { owner, name, oid: head }
        })
    });
    if (!response.ok) {
        throw new TypeError(`GitHub signature query failed: ${response.status}`);
    }
    const result = parseCanonicalJson(await response.text(), "GitHub signature query");
    if (!isJsonObject(result) || !isJsonObject(result.data)) {
        throw new TypeError("GitHub signature query returned no data");
    }
    if (Array.isArray(result.errors) && result.errors.length > 0) {
        throw new TypeError("GitHub signature query returned errors");
    }
    const repository = result.data.repository;
    const object = isJsonObject(repository) ? repository.object : undefined;
    if (!isJsonObject(object)) throw new TypeError("GitHub cannot resolve the reviewed head");
    return object;
}

export function parseChangeControlArguments(args) {
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        const value = args[index + 1];
        if (!option?.startsWith("--") || value === undefined) {
            throw new TypeError(`Invalid change-control argument ${option ?? ""}`);
        }
        if (values.has(option)) throw new TypeError(`Duplicate change-control option ${option}`);
        values.set(option, value);
    }
    const base = values.get("--base");
    const head = values.get("--head");
    if (base === undefined || head === undefined) {
        throw new TypeError("Change-control requires --base and --head");
    }
    for (const option of values.keys()) {
        if (!["--base", "--head", "--event", "--repository", "--body"].includes(option)) {
            throw new TypeError(`Unknown change-control option ${option}`);
        }
    }
    return {
        base,
        head,
        event: values.get("--event"),
        repository: values.get("--repository"),
        body: values.get("--body")
    };
}

function gitLines(args) {
    return git(args).split("\n").filter(Boolean);
}

function gitText(commit, path) {
    const result = spawnSync("git", ["show", `${commit}:${path}`], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    if (result.status !== 0) throw new TypeError(`Cannot read ${path} from base commit`);
    return result.stdout;
}

function gitBlob(commit, path) {
    const result = spawnSync("git", ["rev-parse", `${commit}:${path}`], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    return result.status === 0 ? result.stdout.trim() : "absent";
}

function gitContentHash(commit, path) {
    return `sha256:${sha256(gitText(commit, path))}`;
}

function git(args) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.status !== 0) throw new TypeError(`Git command failed: git ${args.join(" ")}`);
    return result.stdout.trim();
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) await main();
