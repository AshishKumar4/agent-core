import { validateLiveEvidence } from "./live-substrate-evidence.mjs";

const { selectors, manifest, pending } = validateLiveEvidence();
const archive = `${selectors.size} scenarios at ${manifest.commit.slice(0, 12)} across ${manifest.deployments.length} deployments`;
console.log(
    pending.sources.length === 0
        ? `live substrate evidence verified: ${archive}`
        : `live substrate evidence pending re-run: ${archive}, and ${pending.sources.length} fingerprinted source(s) have drifted since it — ${pending.sources.join(", ")}. No row claims verified from this archive; ${pending.requirements.length} row(s) await one operator re-run of the consented lane: ${pending.requirements.join(", ")}`
);
