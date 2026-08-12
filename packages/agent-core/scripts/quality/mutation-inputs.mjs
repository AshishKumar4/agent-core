// The inputs a mutation run of one area can read, and the fingerprint over them.
//
// The fingerprint decides when a pinned measurement has gone stale, so it must cover
// every input that can change a result and nothing else. Hashing more than that is not
// merely wasteful: it stales all 23 areas — roughly an hour and a half of measurement —
// for a provably identical outcome, which is how a ratchet stops being run. The
// equivalence register is one of those inputs, sliced per area so it stales only what it
// actually decides.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import mutationVitestConfig from "../../vitest.mutation.config.mjs";
import {
    equivalenceArea,
    equivalenceKey,
    readEquivalenceRegister
} from "./mutation-equivalence.mjs";
import { artifactRoot, globMatches, packageRoot, parseCanonicalJson } from "./project.mjs";

// An area is a src/ subdirectory, or a single root module such as errors.
export function sourceAreas() {
    return readdirSync(resolve(packageRoot, "src"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".ts")))
        .map((entry) => (entry.isDirectory() ? entry.name : entry.name.slice(0, -3)))
        .sort();
}

// The test files a mutation run is allowed to execute. The lanes
// vitest.mutation.config.mjs excludes never run under Stryker, so nothing in them can
// change a measurement. Their exclusion is read from that config rather than restated
// here, so the two cannot drift apart.
export function mutationTestFiles() {
    return walkTypeScript(resolve(packageRoot, "test")).filter((path) => {
        const portable = relative(packageRoot, path).replaceAll("\\", "/");
        return !mutationVitestConfig.test.exclude.some((pattern) => globMatches(pattern, portable));
    });
}

/**
 * The fingerprint of one area under one equivalence register. The register is an input
 * because it decides which survivors count as actionable: dropping an entry raises the
 * count an area's pinned baseline is holding down, and staling the area is what forces
 * that back through the ratchet instead of leaving the floor quietly loose.
 */
export function mutationFingerprint(area, register = committedRegister()) {
    const files = [
        ...typescriptFilesForArea(area),
        ...mutationTestFiles(),
        resolve(packageRoot, "package.json"),
        resolve(packageRoot, "stryker.conf.mjs"),
        // The mutation config spreads the default one and aliases the bun built-ins to
        // local shims; a run loads those shims, so they are inputs like any other.
        resolve(packageRoot, "vitest.config.mjs"),
        resolve(packageRoot, "vitest.mutation.config.mjs"),
        ...Object.values(mutationVitestConfig.resolve.alias),
        resolve(packageRoot, "../..", "pnpm-lock.yaml")
    ].sort();
    const hash = createHash("sha256");
    for (const path of files) {
        hash.update(relative(packageRoot, path).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
    }
    // Only entry identity is hashed, and only for this area: rewording a proof cannot
    // change a count, and an area with no entries hashes nothing extra, so no measurement
    // stales for a register slice it does not depend on.
    const keys = register
        .filter((entry) => equivalenceArea(entry.file) === area)
        .map(equivalenceKey)
        .sort();
    for (const key of keys) {
        hash.update(key);
        hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
}

function committedRegister() {
    const offset = "quality/mutation-equivalence.json";
    const source = readFileSync(resolve(artifactRoot, offset), "utf8");
    return readEquivalenceRegister(parseCanonicalJson(source, `artifacts/${offset}`));
}

function typescriptFilesForArea(area) {
    const directory = resolve(packageRoot, "src", area);
    if (existsSync(directory) && statSync(directory).isDirectory())
        return walkTypeScript(directory);
    const file = resolve(packageRoot, "src", `${area}.ts`);
    return existsSync(file) ? [file] : [];
}

function walkTypeScript(root) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...walkTypeScript(path));
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
}
