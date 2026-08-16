import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { artifactRoot, packageRoot, readCanonicalJson, sha256 } from "./project.mjs";

const conformanceAtomPattern = /^C13-[A-Z0-9-]+$/u;
const profileAtomPattern = /^P11-[A-Z0-9-]+$/u;
const atomPattern = /^(?:C13|P11)-[A-Z0-9-]+$/u;
const htmlCommentPattern = /^<!--(?:(?!-->)[\s\S])*-->$/u;
const inlineCodePlaceholder = "\ufffc";

export async function canonicalSpec(path = resolve(packageRoot, "SPEC.md")) {
    const source = await readFile(path, "utf8");
    const model = markdownModel(source);
    const structure = structuralFacts(model);
    const sections = structuralSections(structure.headings, source.length);
    const policy = await readCanonicalJson(resolve(artifactRoot, "quality/policy.json"));
    const normativeMap = await readCanonicalJson(
        resolve(artifactRoot, "quality/normative-map.json")
    );
    const summaries = section13(
        model,
        sectionChildren(model, sections, "13"),
        normativeMap.section13IntroductionSha256
    );
    const profileRequirements = profiles(
        model,
        sectionChildren(model, sections, "11"),
        policy.finalRequiredProfiles
    );
    const ids = [...summaries, ...profileRequirements].map((item) => item.id);
    if (new Set(ids).size !== ids.length)
        throw new TypeError("SPEC contains duplicate atomic labels");
    const idSetSha256 = `sha256:${sha256([...ids].sort().join("\n"))}`;
    if (normativeMap.edition !== "1.0.0" || normativeMap.idSetSha256 !== idSetSha256) {
        throw new TypeError(`SPEC reviewed ID-set digest changed: ${idSetSha256}`);
    }
    const anchors = validateAtomLabels(structure.labels, new Set(ids));
    validateConformanceSummaryAnchors(summaries, anchors, sections);
    const atoms = classifyAtoms(summaries, anchors, sections, normativeMap);
    const requirements = [...authoritativeRequirements(atoms), ...profileRequirements];
    const normative = declaredNormativeVocabulary(structure.visibleBlocks, sections);
    validateAuthoritativeAtomLocations(atoms, anchors, sections, normative.sections);
    validateProfileAtomLocations(requirements, anchors);
    return {
        source,
        requirements: requirements.sort((left, right) => left.id.localeCompare(right.id)),
        atoms,
        anchors: anchors.map(({ id, start, end }) => ({ id, start, end })),
        units: structure.units,
        unsupportedBlocks: structure.unsupportedBlocks,
        visibleBlocks: structure.visibleBlocks,
        inlineCodePlaceholder,
        headings: structure.headings,
        sections,
        normativeSections: normative.sections,
        normativeKeywords: normative.keywords
    };
}

export async function specRequirements(path = resolve(packageRoot, "SPEC.md")) {
    return (await canonicalSpec(path)).requirements;
}

function classifyAtoms(summaries, anchors, sections, normativeMap) {
    const reviewed = new Set(normativeMap.authoritativeOutsideSection13);
    if (
        !Array.isArray(normativeMap.authoritativeOutsideSection13) ||
        reviewed.size !== normativeMap.authoritativeOutsideSection13.length
    ) {
        throw new TypeError("Normative map outside-section labels must be a unique array");
    }
    const summaryIds = new Set(summaries.map((item) => item.id));
    for (const id of reviewed) {
        if (!summaryIds.has(id)) throw new TypeError(`Normative map references unknown atom ${id}`);
    }
    const conformance = sections.find((candidate) => candidate.id === "13");
    if (conformance === undefined) throw new TypeError("SPEC is missing §13");
    return summaries.map((summary) => {
        const occurrences = anchors.filter(
            (anchor) =>
                anchor.id === summary.id &&
                (anchor.start < conformance.start || anchor.start >= conformance.end)
        );
        const text =
            occurrences.length === 1
                ? `${occurrences[0].source}\n§13 summary: ${summary.text}`
                : summary.text;
        const sourceText = normalizeNormativeText(
            occurrences.length === 1 ? occurrences[0].source : summary.text
        );
        return {
            ...requirement(summary.id, normalizeNormativeText(text), summary.owner),
            sourceDigest: `sha256:${sha256(sourceText)}`,
            reviewed: reviewed.has(summary.id),
            occurrences: occurrences.length
        };
    });
}

function authoritativeRequirements(atoms) {
    return atoms.map(({ reviewed, occurrences, sourceDigest: _sourceDigest, ...atom }) => {
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

/** Inline wrappers preserve adjacency; only a change of owning block inserts a separator. */
function structuralFacts(model) {
    const labels = [];
    const units = [];
    const unsupportedBlocks = [];
    const targetByNode = new Map();
    visit(model.document, (node, ancestors) => {
        const kind = isStructuralUnit(node, ancestors)
            ? "unit"
            : node.type === "heading"
              ? "heading"
              : undefined;
        if (kind === undefined) return;
        const target = {
            kind,
            node,
            depth: node.type === "heading" ? node.depth : undefined,
            outline: node.type === "heading" && ancestors.at(-1)?.type === "root",
            start: node.position.start.offset,
            end: node.position.end.offset,
            fragments: [],
            renderedFragments: [],
            inlineCodeRanges: [],
            renderedLength: 0,
            anchors: [],
            lastBlock: undefined,
            source:
                kind === "unit"
                    ? sourceOwnedBy(model, node, ancestors)
                    : semanticSource(model, node.position.start.offset, node.position.end.offset)
        };
        if (kind === "unit") units.push(target);
        else unsupportedBlocks.push(target);
        targetByNode.set(node, target);
    });
    visit(
        model.document,
        (node, ancestors) => {
            const target = owningTarget(ancestors, targetByNode);
            // Struck content is dropped from the visible census, so a struck rule would
            // leave the normative unit it states and never be counted. A struck atom
            // label is reported precisely by validateAtomLabels; anything else struck is
            // prose the document still shows and the census would silently lose.
            if (node.type === "delete" && !carriesAtomLabel(node)) {
                throw new TypeError(
                    `SPEC strikethrough hides prose: ${renderedInlineText(node).slice(0, 80)}`
                );
            }
            const deleted = ancestors.some((ancestor) => ancestor.type === "delete");
            const fragment = deleted ? undefined : visibleFragment(node);
            if (fragment !== undefined) {
                if (target === undefined) {
                    throw new TypeError(`SPEC visible ${node.type} has no structural owner`);
                }
                appendVisible(target, fragment, ancestors);
            }
            if (node.type !== "strong") return;
            const label = exactStrongLabel(node);
            if (label === undefined) {
                const candidate = renderedInlineText(node);
                if (atomPattern.test(candidate)) {
                    throw new TypeError(`Atom ${candidate} uses unsupported label markup`);
                }
                return;
            }
            const id = label.id;
            if (!atomPattern.test(id)) return;
            labels.push({
                id,
                start: node.position.start.offset,
                end: node.position.end.offset,
                deleted,
                target
            });
        },
        [],
        (node, ancestors) => {
            if (ancestors.some((ancestor) => ancestor.type === "delete")) return;
            const title = visibleTitle(model, node);
            if (title === undefined) return;
            const target = owningTarget(ancestors, targetByNode);
            if (target === undefined) {
                throw new TypeError(`SPEC visible ${node.type} title has no structural owner`);
            }
            appendVisible(target, { prose: ` ${title}`, rendered: ` ${title}` }, ancestors);
        }
    );
    const unitFacts = units.map(unitFact);
    const headingBlocks = unsupportedBlocks.map((block) => ({
        ...unitFact(block),
        depth: block.depth
    }));
    const headings = headingBlocks.filter(
        (_heading, index) => unsupportedBlocks[index]?.outline === true
    );
    return {
        labels,
        units: unitFacts,
        unsupportedBlocks: headingBlocks.map((heading) => ({
            ...heading,
            kind: "heading"
        })),
        visibleBlocks: [...unitFacts, ...headingBlocks].sort(
            (left, right) => left.start - right.start
        ),
        headings
    };
}

function validateAtomLabels(labels, ids) {
    const anchors = [];
    for (const label of labels) {
        if (label.deleted) throw new TypeError(`Atom ${label.id} is struck through`);
        if (!ids.has(label.id)) throw new TypeError(`SPEC names unknown atom ${label.id}`);
        if (label.target?.kind !== "unit") {
            throw new TypeError(`Atom ${label.id} is not owned by a supported rule unit`);
        }
        label.target.anchors.push(label.id);
        anchors.push({
            id: label.id,
            start: label.start,
            end: label.end,
            source: label.target.source
        });
    }
    return anchors;
}

function validateConformanceSummaryAnchors(summaries, anchors, sections) {
    const conformance = sections.find((section) => section.id === "13");
    if (conformance === undefined) throw new TypeError("SPEC is missing §13");
    for (const summary of summaries) {
        const occurrences = anchors.filter(
            (anchor) =>
                anchor.id === summary.id &&
                anchor.start >= conformance.start &&
                anchor.start < conformance.end
        );
        const leading = occurrences.filter(
            (anchor) => anchor.start === summary.anchorStart && anchor.end === summary.anchorEnd
        );
        if (occurrences.length !== 1 || leading.length !== 1) {
            throw new TypeError(
                `Conformance atom ${summary.id} must have exactly one leading §13 summary anchor`
            );
        }
    }
}

/** Numbering and containment are properties of parsed headings, never of source lines. */
function structuralSections(headings, documentEnd) {
    const hierarchy = new Map();
    const seen = new Set();
    const sections = [];
    let reachedAppendices = false;
    for (const [index, heading] of headings.entries()) {
        for (const depth of hierarchy.keys()) {
            if (depth >= heading.depth) hierarchy.delete(depth);
        }
        const numbered = numberedHeading(heading.prose);
        const appendix = appendixHeading(heading.prose);
        if (numbered === undefined && appendix === undefined) {
            if (heading.depth === 1 && index === 0) continue;
            if (heading.depth === 2) {
                throw new TypeError(`SPEC root heading is unnumbered: ${heading.prose}`);
            }
            continue;
        }
        if (appendix !== undefined) {
            if (heading.depth !== 2) {
                throw new TypeError(`SPEC appendix ${appendix.id} must be a root section`);
            }
            reachedAppendices = true;
        } else {
            if (reachedAppendices) {
                throw new TypeError(`SPEC numbered section §${numbered.id} follows an appendix`);
            }
            const components = numbered.id.split(".");
            if (heading.depth !== components.length + 1) {
                throw new TypeError(
                    `Section §${numbered.id} does not match heading depth ${heading.depth}`
                );
            }
            if (heading.depth > 2) {
                const parent = components.slice(0, -1).join(".");
                if (hierarchy.get(heading.depth - 1) !== parent) {
                    throw new TypeError(`Section §${numbered.id} is not nested under §${parent}`);
                }
            }
        }
        const { id } = appendix ?? numbered;
        if (seen.has(id)) throw new TypeError(`SPEC contains duplicate section §${id}`);
        seen.add(id);
        hierarchy.set(heading.depth, id);
        sections.push({
            id,
            depth: heading.depth,
            start: heading.start,
            bodyStart: heading.end,
            end: documentEnd
        });
    }
    return sections.map((section) => ({
        ...section,
        end:
            headings.find(
                (heading) => heading.start > section.start && heading.depth <= section.depth
            )?.start ?? documentEnd
    }));
}

function declaredNormativeVocabulary(visibleBlocks, sections) {
    const declarationSection = sections.find((section) => section.id === "1.3");
    if (declarationSection === undefined) throw new TypeError("SPEC is missing §1.3");
    const declarationText = visibleBlocks
        .filter(
            (block) =>
                block.start >= declarationSection.bodyStart && block.start < declarationSection.end
        )
        .map((block) => block.prose)
        .join("\n");
    const declarations = [...declarationText.matchAll(/\bSections ([^;]+?) are normative;/gu)];
    const keywordDeclarations = [
        ...declarationText.matchAll(
            /\b([A-Z]+(?:, [A-Z]+)*,? and [A-Z]+) are RFC 2119 keywords\b/gu
        )
    ];
    if (declarations.length !== 1 || keywordDeclarations.length !== 1) {
        throw new TypeError("SPEC §1.3 must declare its normative sections and keywords once");
    }
    const ranges = terms(declarations[0][1]).map((token) => {
        const range = /^(\d+(?:\.\d+)*)(?:[–-](\d+(?:\.\d+)*))?$/u.exec(token);
        if (range === null) throw new TypeError(`SPEC §1.3 names an unreadable section ${token}`);
        return [range[1], range[2] ?? range[1]];
    });
    const sectionIds = new Set(sections.map((section) => section.id));
    if (ranges.some(([from, to]) => !validSectionRange(from, to, sectionIds))) {
        throw new TypeError("SPEC §1.3 names an empty or reversed section range");
    }
    const normativeSections = sections
        .filter((section) => ranges.some(([from, to]) => inSectionRange(section.id, from, to)))
        .map((section) => section.id);
    const keywords = terms(keywordDeclarations[0][1]);
    if (keywords.some((keyword) => !/^[A-Z]+$/u.test(keyword))) {
        throw new TypeError("SPEC §1.3 declares an unreadable RFC 2119 keyword");
    }
    return { sections: normativeSections, keywords };
}

function validateAuthoritativeAtomLocations(atoms, anchors, sections, normativeSections) {
    const normative = new Set(normativeSections);
    const conformance = sections.find((section) => section.id === "13");
    if (conformance === undefined) throw new TypeError("SPEC is missing §13");
    for (const atom of atoms) {
        if (!atom.reviewed) continue;
        const outside = anchors.filter(
            (anchor) => anchor.id === atom.id && anchor.start < conformance.start
        );
        if (outside.length !== 1) {
            throw new TypeError(
                `Authoritative normative atom ${atom.id} has no unique structural anchor`
            );
        }
        const section = sectionAt(sections, outside[0].start);
        if (section === undefined || !normative.has(section.id)) {
            throw new TypeError(
                `Authoritative normative atom ${atom.id} is anchored in non-normative §${section?.id ?? "0"}`
            );
        }
    }
}

function validateProfileAtomLocations(requirements, anchors) {
    for (const requirement of requirements) {
        if (!profileAtomPattern.test(requirement.id)) continue;
        const occurrences = anchors.filter((anchor) => anchor.id === requirement.id);
        if (occurrences.length !== 1) {
            throw new TypeError(`Profile atom ${requirement.id} must have one structural anchor`);
        }
    }
}

function sectionAt(sections, offset) {
    return sections.findLast((section) => section.start <= offset && offset < section.end);
}

function terms(list) {
    return list
        .split(/,|\band\b/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 0);
}

function inSectionRange(id, from, to) {
    if (from.includes(".") || to.includes(".")) {
        return compareSectionIds(id, from) >= 0 && compareSectionIds(id, to) <= 0;
    }
    const chapter = Number.parseInt(id, 10);
    return chapter >= Number.parseInt(from, 10) && chapter <= Number.parseInt(to, 10);
}

function validSectionRange(from, to, sectionIds) {
    if (!sectionIds.has(from) || !sectionIds.has(to)) return false;
    return compareSectionIds(from, to) <= 0;
}

export function compareSectionIds(left, right) {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
        if (difference !== 0) return difference;
    }
    return 0;
}

function isStructuralUnit(node, ancestors) {
    if (node.type === "listItem" || node.type === "tableRow") return true;
    return (
        node.type === "paragraph" &&
        !ancestors.some((ancestor) => ancestor.type === "listItem" || ancestor.type === "tableRow")
    );
}

function owningTarget(ancestors, targetByNode) {
    const node = ancestors.findLast((ancestor) => targetByNode.has(ancestor));
    return node === undefined ? undefined : targetByNode.get(node);
}

function visibleFragment(node) {
    switch (node.type) {
        case "text":
            return { prose: node.value, rendered: node.value };
        case "inlineCode":
            return { prose: inlineCodePlaceholder, rendered: node.value, inlineCode: true };
        case "image":
        case "imageReference":
            return { prose: node.alt ?? "", rendered: node.alt ?? "" };
        case "break":
            return { prose: "\n", rendered: "\n" };
        case "root":
        case "blockquote":
        case "list":
        case "listItem":
        case "paragraph":
        case "heading":
        case "thematicBreak":
        case "definition":
        case "emphasis":
        case "strong":
        case "delete":
        case "link":
        case "linkReference":
        case "table":
        case "tableRow":
        case "tableCell":
        case "code":
        case "html":
            return undefined;
        default:
            throw new TypeError(`SPEC Markdown node ${node.type} is not classified`);
    }
}

function visibleTitle(model, node) {
    if (node.type === "link" || node.type === "image") return nonEmptyTitle(node.title);
    if (node.type !== "linkReference" && node.type !== "imageReference") return undefined;
    return nonEmptyTitle(model.definitions.get(node.identifier)?.title);
}

function nonEmptyTitle(title) {
    return title === null || title === undefined || title.length === 0 ? undefined : title;
}

function appendVisible(target, fragment, ancestors) {
    const block = ancestors.findLast(
        (ancestor) =>
            ancestor === target.node ||
            ancestor.type === "paragraph" ||
            ancestor.type === "tableCell" ||
            ancestor.type === "heading"
    );
    if (target.lastBlock !== undefined && target.lastBlock !== block) {
        target.fragments.push("\n");
        target.renderedFragments.push("\n");
        target.renderedLength += 1;
    }
    const renderedStart = target.renderedLength;
    target.fragments.push(fragment.prose);
    target.renderedFragments.push(fragment.rendered);
    target.renderedLength += fragment.rendered.length;
    if (fragment.inlineCode === true) {
        target.inlineCodeRanges.push([renderedStart, target.renderedLength]);
    }
    target.lastBlock = block;
}

function unitFact(target) {
    return {
        start: target.start,
        end: target.end,
        source: target.source,
        prose: target.fragments.join(""),
        rendered: target.renderedFragments.join(""),
        inlineCodeRanges: target.inlineCodeRanges,
        anchors: target.anchors
    };
}

function normalizeNormativeText(text) {
    return text.replaceAll(/\s+/gu, " ").trim();
}

function section13(model, children, reviewedIntroductionSha256) {
    const [mapIntroduction, implementationIntroduction, summaries, ...unexpected] = children;
    if (
        mapIntroduction?.type !== "paragraph" ||
        implementationIntroduction?.type !== "paragraph" ||
        summaries?.type !== "list" ||
        unexpected.length > 0
    ) {
        throw new TypeError(
            "SPEC §13 must contain exactly its reviewed introduction and atomic summary list"
        );
    }
    const introduction = normalizeNormativeText(
        semanticSource(
            model,
            mapIntroduction.position.start.offset,
            implementationIntroduction.position.end.offset
        )
    );
    const introductionSha256 = `sha256:${sha256(introduction)}`;
    if (reviewedIntroductionSha256 !== introductionSha256) {
        throw new TypeError(`SPEC §13 reviewed introduction digest changed: ${introductionSha256}`);
    }
    const requirements = atomicListItems(model, [summaries], conformanceAtomPattern).map(
        (atom) => ({
            ...requirement(atom.id, atom.text, ownerFor(atom.id)),
            anchorStart: atom.anchorStart,
            anchorEnd: atom.anchorEnd
        })
    );
    if (requirements.length === 0)
        throw new TypeError("SPEC section 13 contains no atomic requirement IDs");
    return requirements;
}

function profiles(model, profileChildren, requiredProfiles) {
    const parsedHeadings = profileChildren.flatMap((heading, index) =>
        heading.type === "heading" && heading.depth === 3
            ? [{ index, parsed: numberedHeading(plainText(heading)) }]
            : []
    );
    const discovered = parsedHeadings.flatMap(({ parsed }) =>
        parsed !== undefined && /^11\.\d+$/u.test(parsed.id) ? [parsed.id] : []
    );
    if (JSON.stringify(discovered) !== JSON.stringify(requiredProfiles)) {
        throw new TypeError(`SPEC profile denominator changed: ${discovered.join(",")}`);
    }
    const profiles = parsedHeadings.map(({ index, parsed }) => {
        if (parsed === undefined || !/^11\.\d+$/u.test(parsed.id)) {
            throw new TypeError("SPEC profile heading is malformed");
        }
        return { index, name: parsed.title };
    });
    const firstHeading = profiles[0];
    if (firstHeading === undefined) throw new TypeError("SPEC profiles are missing");
    const preamble = explicitProfileAtoms(
        model,
        profileChildren.slice(0, firstHeading.index),
        "BASE"
    );
    return [
        ...preamble,
        ...profiles.flatMap((profile, index) => {
            const end = profiles[index + 1]?.index ?? profileChildren.length;
            const body = profileChildren.slice(profile.index + 1, end);
            const family = profile.name.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, "-");
            return explicitProfileAtoms(model, body, family, profile.name);
        })
    ];
}

function explicitProfileAtoms(model, children, family, name) {
    const structural = children.filter((node) => node.type !== "thematicBreak");
    if (structural.some((node) => node.type !== "list")) {
        throw new TypeError(`SPEC profile ${family} contains unlabeled normative prose`);
    }
    const atoms = atomicListItems(model, structural);
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

function atomicListItems(model, children, pattern = profileAtomPattern) {
    return children.flatMap((node) => {
        if (node.type !== "list") return [];
        if (node.ordered) throw new TypeError("SPEC atomic requirements must be unordered");
        return node.children.map((item) => atomicListItem(model, item, pattern));
    });
}

function atomicListItem(model, item, pattern) {
    const paragraph = item.children[0];
    const wrapper = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    const label = leadingStrongLabel(wrapper);
    const id = label?.id;
    if (id === undefined || !pattern.test(id)) {
        const candidate = wrapper === undefined ? "" : renderedInlineText(wrapper);
        if (atomPattern.test(candidate)) {
            throw new TypeError(`Atom ${candidate} uses unsupported label markup`);
        }
        throw new TypeError("SPEC contains an unlabeled atomic requirement");
    }
    if (descendantListItemRanges(item).length > 0) {
        throw new TypeError("SPEC atomic requirements cannot contain nested list items");
    }
    return {
        id,
        anchorStart: label.strong.position.start.offset,
        anchorEnd: label.strong.position.end.offset,
        text: normalizeNormativeText(
            [
                ...leadingLabelEvidence(model, label.wrapper),
                semanticSource(model, label.wrapper.position.end.offset, item.position.end.offset)
            ]
                .filter((part) => part.length > 0)
                .join("\n")
        )
    };
}

function markdownModel(source) {
    const document = fromMarkdown(source, {
        extensions: [gfmTable(), gfmStrikethrough()],
        mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()]
    });
    validateHtml(document);
    const definitions = new Map();
    const references = [];
    visit(document, (node, ancestors) => {
        if (node.type === "definition" && !definitions.has(node.identifier)) {
            definitions.set(node.identifier, node);
        }
        if (
            (node.type === "linkReference" || node.type === "imageReference") &&
            !ancestors.some((ancestor) => ancestor.type === "delete")
        ) {
            references.push(node);
        }
    });
    return { source, document, definitions, references };
}

function validateHtml(document) {
    visit(document, (node, ancestors) => {
        if (node.type !== "html") return;
        if (htmlCommentPattern.test(node.value) && ancestors.at(-1)?.type === "root") {
            return;
        }
        throw new TypeError("SPEC contains raw HTML outside a standalone comment");
    });
}

function leadingStrongLabel(wrapper) {
    let current = wrapper;
    let strong;
    while (labelWrapper(current)) {
        if (current.children.length !== 1) return undefined;
        if (current.type === "strong") {
            if (strong !== undefined) return undefined;
            strong = current;
        }
        current = current.children[0];
    }
    return strong !== undefined && current?.type === "text"
        ? { id: current.value, strong, wrapper }
        : undefined;
}

function exactStrongLabel(strong) {
    let current = strong;
    while (labelWrapper(current)) {
        if (current.children.length !== 1) return undefined;
        if (current !== strong && current.type === "strong") return undefined;
        current = current.children[0];
    }
    return current?.type === "text" ? { id: current.value } : undefined;
}

/** Whether a struck subtree contains an exact atom label, which is reported by id instead. */
function carriesAtomLabel(node) {
    if (node.type === "strong" && exactStrongLabel(node) !== undefined) return true;
    return (node.children ?? []).some(carriesAtomLabel);
}

function labelWrapper(node) {
    return (
        node?.type === "strong" ||
        node?.type === "emphasis" ||
        node?.type === "link" ||
        node?.type === "linkReference"
    );
}

function renderedInlineText(node) {
    if (node.type === "text" || node.type === "inlineCode") return node.value;
    if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
    if (node.type === "break") return "\n";
    return (node.children ?? []).map((child) => renderedInlineText(child)).join("");
}

function leadingLabelEvidence(model, wrapper) {
    const evidence = [];
    visit(wrapper, (node) => {
        if (node.type !== "link" && node.type !== "linkReference") return;
        const target =
            node.type === "link"
                ? { title: node.title, url: node.url }
                : model.definitions.get(node.identifier);
        if (target === undefined) {
            throw new TypeError(`Atomic label reference ${node.identifier} is unresolved`);
        }
        evidence.push(
            `Label link: ${JSON.stringify({ url: target.url, title: target.title ?? null })}`
        );
    });
    return evidence;
}

/**
 * Keep this parser structural. Markdown positions delimit the original source used by
 * the reviewed digests; fenced code and raw HTML are omitted by their parsed node kinds,
 * rather than by a second line-oriented Markdown implementation.
 */
function semanticSource(model, start, end, excluded = []) {
    const omitted = [
        ...omittedRanges(model, start, end, new Set(["code", "delete", "definition", "html"])),
        ...excluded
    ].sort(([left], [right]) => left - right);
    const parts = [];
    let cursor = start;
    for (const [from, to] of omitted) {
        if (from < cursor) {
            cursor = Math.max(cursor, to);
            continue;
        }
        parts.push(model.source.slice(cursor, from));
        cursor = to;
    }
    parts.push(model.source.slice(cursor, end));
    const references = referenceEvidence(model, start, end, excluded);
    return references.length === 0 ? parts.join("") : `${parts.join("")}\n${references.join("\n")}`;
}

function referenceEvidence(model, start, end, excluded) {
    const evidence = [];
    for (const node of model.references) {
        const from = node.position.start.offset;
        const to = node.position.end.offset;
        if (from < start || to > end) continue;
        if (
            excluded.some(([excludedFrom, excludedTo]) => from >= excludedFrom && to <= excludedTo)
        ) {
            continue;
        }
        const target = model.definitions.get(node.identifier);
        if (target === undefined) {
            throw new TypeError(`SPEC reference ${node.identifier} is unresolved`);
        }
        evidence.push(
            `Reference target: ${JSON.stringify({ url: target.url, title: target.title ?? null })}`
        );
    }
    return evidence;
}

function omittedRanges(model, start, end, types) {
    const omitted = [];
    visit(model.document, (node) => {
        if (!types.has(node.type)) return;
        const from = Math.max(start, node.position.start.offset);
        const to = Math.min(end, node.position.end.offset);
        if (from < to) omitted.push([from, to]);
    });
    return omitted.sort(([left], [right]) => left - right);
}

function sourceOwnedBy(model, node, ancestors) {
    if (node.type === "tableRow") {
        const table = ancestors.findLast((ancestor) => ancestor.type === "table");
        if (table === undefined || table.children[0] === undefined) {
            throw new TypeError("Malformed normative table row");
        }
        const headerEnd = table.children[1]?.position.start.offset ?? table.position.end.offset;
        const header = semanticSource(model, table.position.start.offset, headerEnd);
        if (node === table.children[0]) return header;
        return `${header}\n${semanticSource(
            model,
            node.position.start.offset,
            node.position.end.offset
        )}`;
    }
    if (node.type === "listItem") {
        return semanticSource(
            model,
            node.position.start.offset,
            node.position.end.offset,
            descendantListItemRanges(node)
        );
    }
    const parent = ancestors.at(-1);
    if (node.type !== "paragraph" || parent === undefined || !("children" in parent)) {
        throw new TypeError("Malformed normative unit");
    }
    if (parent.type !== "root") {
        return semanticSource(model, node.position.start.offset, node.position.end.offset);
    }
    const at = parent.children.indexOf(node);
    if (at < 0) throw new TypeError("Malformed normative mapping");
    let first = adjacentTable(parent.children, at, -1);
    let last = adjacentTable(parent.children, at, 1);
    if (first === undefined) first = at;
    if (last === undefined) last = at;
    return semanticSource(
        model,
        parent.children[first].position.start.offset,
        parent.children[last].position.end.offset
    );
}

function descendantListItemRanges(item) {
    const descendants = [];
    for (const child of item.children) {
        visit(child, (descendant) => {
            if (descendant.type === "listItem") {
                descendants.push([
                    descendant.position.start.offset,
                    descendant.position.end.offset
                ]);
            }
        });
    }
    return descendants;
}

function adjacentTable(siblings, at, direction) {
    let index = at + direction;
    while (transparentRootNode(siblings[index])) index += direction;
    if (siblings[index]?.type !== "table") return undefined;
    let boundary = index;
    while (true) {
        index += direction;
        while (transparentRootNode(siblings[index])) index += direction;
        if (siblings[index]?.type !== "table") return boundary;
        boundary = index;
    }
}

function transparentRootNode(node) {
    return (
        node?.type === "definition" ||
        (node?.type === "html" && htmlCommentPattern.test(node.value))
    );
}

function sectionChildren(model, sections, id) {
    const selected = sections.find((candidate) => candidate.id === id);
    if (selected === undefined) throw new TypeError(`SPEC is missing §${id}`);
    return model.document.children.filter(
        (node) =>
            node.position.start.offset >= selected.bodyStart &&
            node.position.start.offset < selected.end
    );
}

function numberedHeading(text) {
    const match = /^(\d+(?:\.\d+)*)(?:\.\s+|\s+)(\S[\s\S]*)$/u.exec(text);
    if (match !== null) return { id: match[1], title: match[2] };
    if (/^\d/u.test(text)) throw new TypeError(`SPEC heading is malformed: ${text}`);
    return undefined;
}

function appendixHeading(text) {
    const match = /^(Appendix [A-Z]+)(?:\s+|$)/u.exec(text);
    return match === null ? undefined : { id: match[1] };
}

function visit(node, visitor, ancestors = [], exit) {
    visitor(node, ancestors);
    for (const child of node.children ?? []) visit(child, visitor, [...ancestors, node], exit);
    exit?.(node, ancestors);
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
