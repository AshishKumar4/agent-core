// @ts-nocheck
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactRoot, packageRoot, readCanonicalJson, sha256 } from "./project.mjs";

export async function specRequirements(path = resolve(packageRoot, "SPEC.md")) {
    const source = await readFile(path, "utf8");
    const policy = await readCanonicalJson(resolve(artifactRoot, "quality/policy.json"));
    const normativeMap = await readCanonicalJson(
        resolve(artifactRoot, "quality/normative-map.json")
    );
    const summaries = section13(source);
    const requirements = [
        ...authoritativeRequirements(source, summaries, normativeMap),
        ...profiles(source, policy.finalRequiredProfiles)
    ];
    const ids = requirements.map((item) => item.id);
    if (new Set(ids).size !== ids.length)
        throw new TypeError("SPEC contains duplicate atomic labels");
    const idSetSha256 = `sha256:${sha256([...ids].sort().join("\n"))}`;
    if (normativeMap.edition !== "1.0.0" || normativeMap.idSetSha256 !== idSetSha256) {
        throw new TypeError(`SPEC reviewed ID-set digest changed: ${idSetSha256}`);
    }
    return requirements.sort((left, right) => left.id.localeCompare(right.id));
}

function authoritativeRequirements(source, summaries, normativeMap) {
    const section13Start = source.indexOf("## 13. Conformance");
    const normativeSource = source.slice(0, section13Start);
    const requiredOutside = new Set(normativeMap.authoritativeOutsideSection13);
    if (
        !Array.isArray(normativeMap.authoritativeOutsideSection13) ||
        requiredOutside.size !== normativeMap.authoritativeOutsideSection13.length
    ) {
        throw new TypeError("Normative map outside-section labels must be a unique array");
    }
    const summaryIds = new Set(summaries.map((item) => item.id));
    for (const id of requiredOutside) {
        if (!summaryIds.has(id)) throw new TypeError(`Normative map references unknown atom ${id}`);
    }
    return summaries.map((summary) => {
        const marker = `**${summary.id}**`;
        const occurrences = normativeSource.split(marker).length - 1;
        if (requiredOutside.has(summary.id) && occurrences !== 1) {
            throw new TypeError(
                `Authoritative normative atom ${summary.id} must appear exactly once outside §13`
            );
        }
        if (!requiredOutside.has(summary.id) && occurrences > 0) {
            throw new TypeError(`Unreviewed outside-§13 normative mapping for ${summary.id}`);
        }
        const text = occurrences === 1 ? containingBlock(normativeSource, marker) : summary.text;
        return requirement(summary.id, normalizeNormativeText(text), summary.owner);
    });
}

function containingBlock(source, marker) {
    const at = source.indexOf(marker);
    const start = source.lastIndexOf("\n\n", at);
    const end = source.indexOf("\n\n", at + marker.length);
    if (at < 0 || end < 0) throw new TypeError(`Malformed normative mapping ${marker}`);
    return source.slice(start < 0 ? 0 : start + 2, end);
}

function normalizeNormativeText(text) {
    return text.replaceAll(/\s+/gu, " ").trim();
}

function section13(source) {
    const section = between(source, "## 13. Conformance", "## 14. The formal model");
    const requirements = [];
    const lines = section.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^- \*\*(C13-[A-Z0-9-]+)\*\* (.+)$/.exec(lines[index]);
        if (match === null) continue;
        const text = [match[2]];
        while (index + 1 < lines.length && !lines[index + 1].startsWith("- **C13-")) {
            const continuation = lines[index + 1].trim();
            text.push(continuation);
            index += 1;
        }
        requirements.push(requirement(match[1], text.join("\n").trim(), ownerFor(match[1])));
    }
    if (requirements.length === 0)
        throw new TypeError("SPEC section 13 contains no atomic requirement IDs");
    return requirements;
}

function profiles(source, requiredProfiles) {
    const section = between(source, "## 11. Profiles", "## 12. Assembly sketches");
    const matches = [...section.matchAll(/^### 11\.(\d+) (.+)$/gm)];
    const discovered = matches.map((match) => `11.${match[1]}`);
    if (JSON.stringify(discovered) !== JSON.stringify(requiredProfiles)) {
        throw new TypeError(`SPEC profile denominator changed: ${discovered.join(",")}`);
    }
    const preamble = explicitProfileAtoms(section.slice(0, matches[0].index), "BASE");
    return [
        ...preamble,
        ...matches.flatMap((match, index) => {
            const start = match.index;
            const end = matches[index + 1]?.index ?? section.length;
            const body = section.slice(start + match[0].length, end).trim();
            const family = match[2].toUpperCase().replaceAll(/[^A-Z0-9]+/gu, "-");
            return explicitProfileAtoms(body, family, match[2]);
        })
    ];
}

function explicitProfileAtoms(body, family, name) {
    const lines = body.split("\n");
    const atoms = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim().length === 0 || line.trim() === "---") continue;
        const match = /^- \*\*(P11-[A-Z0-9-]+)\*\* (.+)$/.exec(line);
        if (match === null) {
            throw new TypeError(`SPEC profile ${family} contains unlabeled normative prose`);
        }
        if (!match[1].startsWith(`P11-${family}-`)) {
            throw new TypeError(`SPEC profile label ${match[1]} is outside family ${family}`);
        }
        const text = [match[2].trim()];
        while (index + 1 < lines.length && /^\s{2,}\S/u.test(lines[index + 1])) {
            text.push(lines[index + 1].trim());
            index += 1;
        }
        atoms.push(
            requirement(
                match[1],
                name === undefined ? text.join(" ") : `${name}: ${text.join(" ")}`,
                "W8"
            )
        );
    }
    if (atoms.length === 0) throw new TypeError(`SPEC profile ${family} has no explicit atoms`);
    return atoms;
}

function requirement(id, text, owner) {
    return { id, owner, text, digest: `sha256:${sha256(text)}` };
}

function between(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new TypeError(`SPEC is missing ${start} or ${end}`);
    return source.slice(from + start.length, to);
}

function ownerFor(id) {
    const prefixOwners = [
        ["C13-AUTH-", "W2"],
        ["C13-PLACEMENT-", "W4"],
        ["C13-POLICY-", "W4"],
        ["C13-CONFIG-", "W4"],
        ["C13-FACET-", "W3"],
        ["C13-PROFILE-", "W8"],
        ["C13-CLOUDFLARE-", "W8"],
        ["C13-COMMAND-", "W3"],
        ["C13-INTERCEPTOR-", "W3"],
        ["C13-ENVIRONMENT-", "W8"],
        ["C13-TRUST-", "W7"],
        ["C13-SUBSCRIPTION-", "W7"],
        ["C13-ROUTE-", "W7"],
        ["C13-PREPARED-", "W6"],
        ["C13-RECEIPT-", "W6"],
        ["C13-EFFECT-", "W6"],
        ["C13-CLAIM-", "W6"],
        ["C13-ATTEMPT-", "W6"],
        ["C13-BATCH-", "W6"],
        ["C13-AUDIT-", "W6"],
        ["C13-RUN-", "W5"],
        ["C13-WRITER-", "W5"],
        ["C13-TURN-", "W5"],
        ["C13-VIEW-", "W7"],
        ["C13-CONTENT-", "W1"],
        ["C13-CODEC-", "W1"],
        ["C13-PROTOCOL-", "W1"],
        ["C13-OWNERSHIP-", "W0"],
        ["C13-BLUEPRINT-", "W4"]
    ];
    if (id.startsWith("C13-ADV-")) return adversarialOwner(id);
    const owner = prefixOwners.find(([prefix]) => id.startsWith(prefix))?.[1];
    if (owner === undefined) throw new TypeError(`No owner is assigned to ${id}`);
    return owner;
}

function adversarialOwner(id) {
    if (/(?:LEASE|SIBLING|MERGE|PIN|PACKAGE|POST-TERMINAL|WRITER|POST-FENCE)/.test(id)) return "W5";
    if (/(?:ALLOW|DENY|WATERMARK|DEADLINE|MEDIATED-STALE)/.test(id)) return "W2";
    if (/PLACEMENT/.test(id)) return "W4";
    if (/(?:TRUST|INITIATOR|PROJECTION|ROUTE|CROSS-TENANT|TIER)/.test(id)) return "W7";
    if (/(?:BATCH|CLAIM|RECOVERY|AGGREGATE|ITEM-KEY|INTENT|APPROVAL|RECEIPT|AUDIT)/.test(id))
        return "W6";
    if (/(?:SLOT|INTERCEPTOR)/.test(id)) return "W3";
    if (/COMMAND/.test(id)) return "W1";
    if (/CACHE-LOSS/.test(id)) return "W0";
    throw new TypeError(`No adversarial owner is assigned to ${id}`);
}
