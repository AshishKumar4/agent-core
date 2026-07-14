import { TextId } from "../core";

export class RunId extends TextId {
    public constructor(value: string) {
        super(value, "Run ID");
    }
}

export class TurnId extends TextId {
    public constructor(value: string) {
        super(value, "Turn ID");
    }
}

export class RunCommitId extends TextId {
    public constructor(value: string) {
        super(value, "Run commit ID");
    }
}
