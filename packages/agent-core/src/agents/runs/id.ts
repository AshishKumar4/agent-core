import { TextId } from "../../core";
export { RunCommitId, RunId, TurnId } from "../../execution-references";

export class RunBranchId extends TextId {
    public constructor(value: string) {
        super(value, "Run branch ID");
    }
}

export class RunCheckpointId extends TextId {
    public constructor(value: string) {
        super(value, "Run checkpoint ID");
    }
}

export class TurnInboxEntryId extends TextId {
    public constructor(value: string) {
        super(value, "Turn inbox entry ID");
    }
}

export class SpawnReservationId extends TextId {
    public constructor(value: string) {
        super(value, "Spawn reservation ID");
    }
}
