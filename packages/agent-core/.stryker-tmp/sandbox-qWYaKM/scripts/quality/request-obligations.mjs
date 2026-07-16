// @ts-nocheck
import { createHash } from "node:crypto";

export function extractRequestObligations(source, sourceSha256, bytes) {
    if (source.endsWith(".md")) {
        return source.endsWith("W8/normative-clarifications.md")
            ? markdownSections(source, sourceSha256, bytes)
            : [singleton(source, sourceSha256, bytes)];
    }
    if (!source.endsWith(".json")) return [singleton(source, sourceSha256, bytes)];

    const document = JSON.parse(bytes);
    if (document.schemaVersion === "agent-core.integration-request/v1") {
        return collection(
            source,
            sourceSha256,
            "integration",
            document.requests,
            (item) => item.id
        );
    }
    if (document.schemaVersion === "agent-core.consent-gate/v1") {
        return collection(source, sourceSha256, "consent", document.gates, (item) => item.id);
    }
    if (
        document.edition === "1.0.0" &&
        typeof document.owner === "string" &&
        typeof document.kind === "string" &&
        Array.isArray(document.requests)
    ) {
        return collection(source, sourceSha256, document.kind, document.requests, (item) =>
            naturalKey(document.kind, item)
        );
    }
    if (source.endsWith("/W2/conformance.json")) {
        return collection(source, sourceSha256, "conformance", document.atoms, (item) => item.id);
    }
    if (source.endsWith("/W2/ownership.json")) {
        return collection(source, sourceSha256, "records", document.records, (item) => item.kind);
    }
    if (source.endsWith("/W2/shared-seams.json")) {
        return collection(source, sourceSha256, "seams", document.requests, (item) => item.id);
    }
    if (source.endsWith("/W5/clarifications.json")) {
        return collection(
            source,
            sourceSha256,
            "clarifications",
            document.entries,
            (item) => item.id
        );
    }
    if (source.endsWith("/W5/exports.json")) {
        return collection(source, sourceSha256, "exports", document.entries, (item) => item.barrel);
    }
    if (source.endsWith("/W5/ownership.json")) {
        return collection(source, sourceSha256, "records", document.records, (item) => item.kind);
    }
    if (source.endsWith("/W5/ports.json")) {
        return collection(source, sourceSha256, "ports", document.ports, (item) => item.port);
    }
    return [singleton(source, sourceSha256, bytes)];
}

function collection(source, sourceSha256, family, items, key) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new TypeError(`Request collection is empty: ${source}`);
    }
    const obligations = items.map((item, index) =>
        obligation(
            source,
            sourceSha256,
            family,
            String(key(item)),
            `#/${collectionName(source, family)}/${index}`,
            item
        )
    );
    if (new Set(obligations.map((item) => item.obligationId)).size !== obligations.length) {
        throw new TypeError(`Request collection has duplicate obligation identities: ${source}`);
    }
    return obligations;
}

function collectionName(source, family) {
    if (family === "consent") return "gates";
    if (family === "conformance") return "atoms";
    if (family === "clarifications" || source.endsWith("/W5/exports.json")) return "entries";
    if (family === "records") return "records";
    if (family === "ports") return "ports";
    return "requests";
}

function markdownSections(source, sourceSha256, bytes) {
    const sections = [...bytes.matchAll(/^## (.+)$/gmu)];
    if (sections.length === 0) throw new TypeError(`Normative Markdown has no sections: ${source}`);
    return sections.map((match, index) => {
        const start = match.index;
        const end = sections[index + 1]?.index ?? bytes.length;
        const heading = match[1];
        const slug = heading
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/gu, "-")
            .replace(/^-|-$/gu, "");
        return obligation(
            source,
            sourceSha256,
            "decision",
            slug,
            `#${slug}`,
            bytes.slice(start, end)
        );
    });
}

function singleton(source, sourceSha256, bytes) {
    return obligation(source, sourceSha256, "document", "document", "#", bytes);
}

function obligation(source, sourceSha256, family, key, anchor, value) {
    if (!key || key === "undefined")
        throw new TypeError(`Request obligation lacks a key: ${source}`);
    return Object.freeze({
        obligationId: `${source}::${family}::${key}`,
        source,
        sourceSha256,
        anchor,
        atomSha256: sha256(typeof value === "string" ? value : JSON.stringify(canonical(value)))
    });
}

function naturalKey(kind, item) {
    if (kind === "dependencies") return `${item.context}:${item.symbol}`;
    if (kind === "errors") return item.code;
    if (kind === "exports") return `${item.specifier}:${item.symbol}`;
    if (kind === "source-removals") return item.path;
    throw new TypeError(`Unsupported request fragment kind: ${kind}`);
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])])
        );
    }
    return value;
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
