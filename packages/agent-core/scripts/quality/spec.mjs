import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { artifactRoot, packageRoot, readCanonicalJson, sha256 } from "./project.mjs";

const conformanceAtomPattern = /^C13-[A-Z0-9-]+$/u;
const profileAtomPattern = /^P11-[A-Z0-9-]+$/u;

export async function specRequirements(path = resolve(packageRoot, "SPEC.md")) {
    const source = await readFile(path, "utf8");
    const policy = await readCanonicalJson(resolve(artifactRoot, "quality/policy.json"));
    const normativeMap = await readCanonicalJson(
        resolve(artifactRoot, "quality/normative-map.json")
    );
    const requirements = [
        ...authoritativeRequirements(source, normativeMap),
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

/**
 * Every §13 atom with the prose block that is its hash input, how many times its bold
 * anchor occurs outside §13, and whether the normative map reviewed it as authoritative
 * there. Classification only: the anchor rules are applied by the callers so a document
 * checker can report a contradiction that the ledger refuses to parse past.
 */
export function specAtoms(source, normativeMap) {
    const document = fromMarkdown(source);
    const reviewed = new Set(normativeMap.authoritativeOutsideSection13);
    if (
        !Array.isArray(normativeMap.authoritativeOutsideSection13) ||
        reviewed.size !== normativeMap.authoritativeOutsideSection13.length
    ) {
        throw new TypeError("Normative map outside-section labels must be a unique array");
    }
    const conformance = section(document, "13. Conformance");
    const summaries = section13(source, conformance.children);
    const summaryIds = new Set(summaries.map((item) => item.id));
    for (const id of reviewed) {
        if (!summaryIds.has(id)) throw new TypeError(`Normative map references unknown atom ${id}`);
    }
    const normativeSource = source.slice(0, conformance.heading.position.start.offset);
    const normativeLabels = strongLabels(document, conformance.heading.position.start.offset);
    return summaries.map((summary) => {
        const occurrences = normativeLabels.filter((label) => label.id === summary.id);
        const text =
            occurrences.length === 1
                ? containingBlock(normativeSource, occurrences[0].position.start.offset)
                : summary.text;
        return {
            ...requirement(summary.id, normalizeNormativeText(text), summary.owner),
            reviewed: reviewed.has(summary.id),
            occurrences: occurrences.length
        };
    });
}

/** The explicit `P11-*` labels of §11, in document order. */
export function profileLabels(source) {
    const profileSection = section(fromMarkdown(source), "11. Profiles");
    return atomicListItems(source, profileSection.children).map((atom) => atom.id);
}

function authoritativeRequirements(source, normativeMap) {
    return specAtoms(source, normativeMap).map(({ reviewed, occurrences, ...atom }) => {
        if (reviewed && occurrences !== 1) {
            throw new TypeError(
                `Authoritative normative atom ${atom.id} must appear exactly once outside §13`
            );
        }
        if (!reviewed && occurrences > 0) {
            throw new TypeError(`Unreviewed outside-§13 normative mapping for ${atom.id}`);
        }
        return atom;
    });
}

function containingBlock(source, at) {
    const end = source.indexOf("\n\n", at);
    if (end < 0) throw new TypeError("Malformed normative mapping");
    const start = source.lastIndexOf("\n\n", at);
    return source.slice(tableBefore(source, start < 0 ? 0 : start + 2), tableAfter(source, end));
}

/**
 * A markdown table is its own blank-line-delimited block, so an anchor could never reach
 * one: C13-TURN-LIFECYCLE claims "the complete lifecycle table" and C13-WRITER-MATRIX
 * "the exact CommitWriter matrix", yet editing a row restaled neither. A table is not a
 * standalone normative unit — it is the data the prose beside it introduces or closes —
 * so the two hash as one. Both adjacencies occur: the lifecycle table follows its
 * paragraph, the commit-kind matrix precedes its own.
 */
function tableAfter(source, end) {
    let cursor = end;
    for (;;) {
        const next = source.indexOf("\n\n", cursor + 2);
        if (next < 0 || !source.startsWith("|", cursor + 2)) return cursor;
        cursor = next;
    }
}

function tableBefore(source, start) {
    let cursor = start;
    while (cursor > 0) {
        const boundary = source.lastIndexOf("\n\n", cursor - 3);
        const previous = boundary < 0 ? 0 : boundary + 2;
        if (!source.startsWith("|", previous)) return cursor;
        cursor = previous;
    }
    return cursor;
}

function normalizeNormativeText(text) {
    return text.replaceAll(/\s+/gu, " ").trim();
}

function section13(source, children) {
    const requirements = atomicListItems(source, children, conformanceAtomPattern).map((atom) =>
        requirement(atom.id, atom.text, ownerFor(atom.id))
    );
    if (requirements.length === 0)
        throw new TypeError("SPEC section 13 contains no atomic requirement IDs");
    return requirements;
}

function profiles(source, requiredProfiles) {
    const profileSection = section(fromMarkdown(source), "11. Profiles");
    const headings = profileSection.children.filter(
        (node) => node.type === "heading" && node.depth === 3
    );
    const parsedHeadings = headings.map((heading) => ({
        heading,
        match: /^11\.(\d+) (.+)$/u.exec(plainText(heading))
    }));
    const discovered = parsedHeadings.flatMap(({ match }) =>
        match === null ? [] : [`11.${match[1]}`]
    );
    if (JSON.stringify(discovered) !== JSON.stringify(requiredProfiles)) {
        throw new TypeError(`SPEC profile denominator changed: ${discovered.join(",")}`);
    }
    const profiles = parsedHeadings.map(({ heading, match }) => {
        if (match === null) throw new TypeError("SPEC profile heading is malformed");
        return { heading, number: match[1], name: match[2] };
    });
    const firstHeading = profiles[0]?.heading;
    if (firstHeading === undefined) throw new TypeError("SPEC profiles are missing");
    const preamble = explicitProfileAtoms(
        source,
        profileSection.children.filter(
            (node) => node.position.start.offset < firstHeading.position.start.offset
        ),
        "BASE"
    );
    return [
        ...preamble,
        ...profiles.flatMap((profile, index) => {
            const end = profiles[index + 1]?.heading.position.start.offset ?? profileSection.end;
            const body = profileSection.children.filter(
                (node) =>
                    node.position.start.offset > profile.heading.position.end.offset &&
                    node.position.start.offset < end
            );
            const family = profile.name.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, "-");
            return explicitProfileAtoms(source, body, family, profile.name);
        })
    ];
}

function explicitProfileAtoms(source, children, family, name) {
    const structural = children.filter((node) => node.type !== "thematicBreak");
    if (structural.some((node) => node.type !== "list")) {
        throw new TypeError(`SPEC profile ${family} contains unlabeled normative prose`);
    }
    const atoms = atomicListItems(source, structural);
    for (const atom of atoms) {
        if (!atom.id.startsWith(`P11-${family}-`)) {
            throw new TypeError(`SPEC profile label ${atom.id} is outside family ${family}`);
        }
    }
    if (atoms.length === 0) throw new TypeError(`SPEC profile ${family} has no explicit atoms`);
    return atoms.map((atom) =>
        requirement(atom.id, name === undefined ? atom.text : `${name}: ${atom.text}`, "W8")
    );
}

function atomicListItems(source, children, pattern = profileAtomPattern) {
    return children.flatMap((node) => {
        if (node.type !== "list") return [];
        if (node.ordered) throw new TypeError("SPEC atomic requirements must be unordered");
        return node.children.map((item) => atomicListItem(source, item, pattern));
    });
}

function atomicListItem(source, item, pattern) {
    const paragraph = item.children[0];
    const label = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    const id = label?.type === "strong" ? plainText(label) : undefined;
    if (id === undefined || !pattern.test(id)) {
        throw new TypeError("SPEC contains an unlabeled atomic requirement");
    }
    return {
        id,
        text: normalizeNormativeText(
            source.slice(label.position.end.offset, item.position.end.offset)
        )
    };
}

function section(document, title) {
    const start = document.children.findIndex(
        (node) => node.type === "heading" && node.depth === 2 && plainText(node) === title
    );
    const end = document.children.findIndex(
        (node, index) => index > start && node.type === "heading" && node.depth === 2
    );
    if (start < 0 || end < 0) throw new TypeError(`SPEC is missing ${title}`);
    return {
        heading: document.children[start],
        children: document.children.slice(start + 1, end),
        end: document.children[end].position.start.offset
    };
}

function strongLabels(document, before) {
    const labels = [];
    visit(document, (node) => {
        if (node.type !== "strong" || node.position.start.offset >= before) return;
        const id = plainText(node);
        if (conformanceAtomPattern.test(id)) labels.push({ id, position: node.position });
    });
    return labels;
}

function visit(node, visitor) {
    visitor(node);
    for (const child of node.children ?? []) visit(child, visitor);
}

function plainText(node) {
    if (node.type === "text" || node.type === "inlineCode") return node.value;
    return (node.children ?? []).map((child) => plainText(child)).join("");
}

function requirement(id, text, owner) {
    return { id, owner, text, digest: `sha256:${sha256(text)}` };
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
