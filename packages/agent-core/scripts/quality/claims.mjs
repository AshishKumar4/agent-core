import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
    artifactRoot,
    isNonEmptyString,
    readCanonicalJson,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";

const FORMAL_CITATION = /\b(?:AC|NC|ASM)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/u;
const CONFORMANCE_CITATION = /\b(?:C13|P11)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/u;
const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });
const FORMAL_CLAIM =
    /\b(?:formal\s+model\s+backed|formally\s+modeled\s+abstract\s+subset|kernel\s+propert(?:y|ies)\s+proved\s+in\s+lean(?:\s+4)?|proved\s+in\s+lean(?:\s+4)?)\b/iu;
const CONFORMANCE_CLAIM =
    /\b(?:implementation|substrate|profile|product|platform)\b.*\b(?:verified|proven|conformant)\b/iu;
const BANNED = /\b(?:formally\s+verified|formally\s+proven|provably\s+correct)\b/iu;
const NEGATED =
    /\b(?:does\s+not|is\s+not|are\s+not|not|never)\s+(?:claim\s+)?(?:formal\s+verification|formally\s+verified|formally\s+proven|provably\s+correct)\b$/iu;
const CONFORMANCE_NEGATED =
    /\b(?:does\s+not|is\s+not|are\s+not|not|never)\s+(?:claim\s+)?(?:formally\s+)?(?:verified|proven|conformant)\b$/iu;
const FORMAL_VERIFICATION_ASSURANCE =
    /\b(?:provides?|offers?|has)\s+formal\s+verification\b|\bformal\s+verification\s+(?:of|for)\b/iu;
const ASSURANCE_MARKER =
    /\b(?:lean|kernel|machine\s+checked|mechanically\s+checked|kernel\s+checked|lean\s+checked|mathematically|formally|provably|proved|proven|verified|certified|guaranteed|guarantees?)\b/u;
const ASSURANCE_PROPERTY = /\b(?:correct|correctness|safe|safety|secure|security)\b/u;
const NEGATED_COPULA_ASSURANCE =
    /\b(?:is|are|was|were)\s+not\s+(?:(?:mathematically|formally|provably|proved|proven|verified|certified)\s+)*(?:correct|correctness|safe|safety|secure|security)$/u;
const NEGATED_EPISTEMIC_ASSURANCE =
    /\b(?:(?:does|do|can|will)\s+not|cannot)\s+(?:prove|guarantee|certify|ensure)\b.*\b(?:correct|correctness|safe|safety|secure|security)$/u;
const NEGATED_PROPERTY_ASSURANCE =
    /\b(?:correctness|safety|security)\s+(?:is|are)\s+not\s+(?:guaranteed|certified|proved|proven|verified)$/u;
const INFALLIBILITY_ASSERTION =
    /\b(?:cannot|can\s+never|will\s+never)\b.*\b(?:incorrect|wrong|unsafe|insecure|invalid)\b/u;

export function validateClaimText(source, label) {
    const visible = markdownProse(source);
    const paragraphs = visible.split(/\n\s*\n/u);
    for (const paragraph of paragraphs) {
        for (const sentence of SENTENCES.segment(paragraph)) {
            const normalized = sentence.segment
                .normalize("NFKC")
                .toLowerCase()
                .replace(/\p{Cf}+/gu, "")
                .replace(/[\p{P}\p{S}]+/gu, " ")
                .replace(/\s+/gu, " ")
                .trim();
            if (
                hasUnnegatedMatch(BANNED, normalized) ||
                hasUnnegatedMatch(FORMAL_VERIFICATION_ASSURANCE, normalized) ||
                makesUnboundedAssurance(normalized)
            ) {
                throw new TypeError(`${label} makes a banned system-level formal claim`);
            }
            if (FORMAL_CLAIM.test(normalized) && !FORMAL_CITATION.test(paragraph)) {
                throw new TypeError(`${label} makes an uncited formal claim`);
            }
            if (
                hasUnnegatedMatch(CONFORMANCE_CLAIM, normalized, CONFORMANCE_NEGATED) &&
                !CONFORMANCE_CITATION.test(paragraph)
            ) {
                throw new TypeError(`${label} makes an uncited implementation claim`);
            }
        }
    }
}

function makesUnboundedAssurance(text) {
    if (
        NEGATED_COPULA_ASSURANCE.test(text) ||
        NEGATED_EPISTEMIC_ASSURANCE.test(text) ||
        NEGATED_PROPERTY_ASSURANCE.test(text)
    ) {
        return false;
    }
    return (
        (ASSURANCE_MARKER.test(text) && ASSURANCE_PROPERTY.test(text)) ||
        INFALLIBILITY_ASSERTION.test(text)
    );
}

function hasUnnegatedMatch(pattern, text, negation = NEGATED) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`));
    for (const match of matches) {
        const context = text.slice(0, (match.index ?? 0) + match[0].length);
        if (!negation.test(context)) return true;
    }
    return false;
}

export function markdownProse(source) {
    const document = fromMarkdown(source);
    const definitionTitles = new Map();
    collectDefinitionTitles(document, definitionTitles);
    return markdownNodeText(document, definitionTitles);
}

/**
 * @param {import("mdast").Nodes} node
 * @param {Map<string, string>} definitionTitles
 */
function markdownNodeText(node, definitionTitles) {
    if (node.type === "code" || node.type === "inlineCode") return "";
    if (node.type === "text") return node.value;
    if (node.type === "break" || node.type === "thematicBreak") return "\n";
    if (node.type === "definition") return "";
    if (node.type === "image") return [node.alt, node.title].filter(isNonEmptyString).join("\n");
    if (node.type === "imageReference") {
        return [node.alt, definitionTitles.get(node.identifier)]
            .filter(isNonEmptyString)
            .join("\n");
    }
    if (node.type === "html") {
        if (node.value.startsWith("<!--") && node.value.endsWith("-->")) return "";
        throw new TypeError("Public claim surfaces must not contain raw HTML");
    }
    if ("children" in node) {
        const title = node.type === "link" ? node.title : undefined;
        const separator =
            node.type === "root" ||
            node.type === "blockquote" ||
            node.type === "list" ||
            node.type === "listItem"
                ? "\n\n"
                : "";
        const text = node.children
            .map((child) => markdownNodeText(child, definitionTitles))
            .join(separator);
        const referenceTitle =
            node.type === "linkReference" ? definitionTitles.get(node.identifier) : undefined;
        return [text, title, referenceTitle].filter(isNonEmptyString).join("\n");
    }
    return "";
}

/**
 * @param {import("mdast").Nodes} node
 * @param {Map<string, string>} titles
 */
function collectDefinitionTitles(node, titles) {
    if (node.type === "definition" && isNonEmptyString(node.title)) {
        titles.set(node.identifier, node.title);
    }
    if ("children" in node) {
        for (const child of node.children) collectDefinitionTitles(child, titles);
    }
}

async function main() {
    const policy = await readCanonicalJson(resolve(artifactRoot, "quality/doctrine.json"));
    for (const path of policy.claimSurfaces) {
        validateClaimText(await readFile(resolve(repositoryRoot, path), "utf8"), path);
    }
    await writeCanonicalJson(
        resolve(repositoryRoot, "packages/agent-core/reports/quality/claims.json"),
        {
            edition: "1.0.0",
            surfaces: policy.claimSurfaces,
            complete: true
        }
    );
    console.log(`Public claim surfaces verified: ${policy.claimSurfaces.length}`);
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) await main();
