import { validateLiveEvidence } from "./live-substrate-evidence.mjs";

const { selectors, manifest } = validateLiveEvidence();
console.log(
    `live substrate evidence verified: ${selectors.size} scenarios at ${manifest.commit.slice(0, 12)} across ${manifest.deployments.length} deployments`
);
