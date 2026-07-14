import { resolve } from "node:path";
import { artifactRoot, writeCanonicalJson } from "./project.mjs";
import { specRequirements } from "./spec.mjs";

if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
    throw new TypeError(
        "Seeding the conformance ledger requires QUALITY_WRITE_BASELINE=1 outside CI"
    );
}

const requirements = (await specRequirements()).map((requirement) => ({
    id: requirement.id,
    owner: requirement.owner,
    specAnchor: requirement.id,
    specTextSha256: requirement.digest,
    status: "planned",
    prerequisites: [],
    sourceSymbols: [],
    testSelectors: [],
    checkerInvariants: [],
    remainingEvidence: [
        "The owning implementation wave must provide runtime and adversarial evidence"
    ]
}));

await writeCanonicalJson(resolve(artifactRoot, "conformance/seed.json"), {
    edition: "1.0.0",
    owner: "W0-seed",
    requirements
});
console.log(`seeded ${requirements.length} atomic SPEC requirements`);
