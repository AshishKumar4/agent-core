import type { FacetSet } from "../../facets";
import type { RunBranch, RunCommit, Run } from "./run";
import type { RunId, TurnId } from "./id";

export class RunStartRecord {
    public constructor(
        public readonly run: Run,
        public readonly rootBranch: RunBranch,
        public readonly rootCommit: RunCommit
    ) {
    }
}

export class RunCommitRecord {
    public constructor(
        public readonly turnId: TurnId,
        public readonly leaseEpoch: number,
        public readonly commit: RunCommit,
        public readonly branch: RunBranch
    ) {
        if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 0) {
            throw new TypeError("Run commit lease epoch must be a non-negative safe integer");
        }
    }
}

export class RunSpawnRecord {
    public constructor(
        public readonly parentTurnId: TurnId,
        public readonly parentLeaseEpoch: number,
        public readonly run: Run,
        public readonly facets: FacetSet
    ) {
        if (!Number.isSafeInteger(parentLeaseEpoch) || parentLeaseEpoch < 0) {
            throw new TypeError("Run spawn lease epoch must be a non-negative safe integer");
        }
    }
}

export class RunBranchRecord {
    public constructor(
        public readonly sourceRunId: RunId,
        public readonly branch: RunBranch
    ) {
    }
}
