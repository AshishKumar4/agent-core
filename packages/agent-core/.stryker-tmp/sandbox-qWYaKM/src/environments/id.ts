// @ts-nocheck
import { TextId } from "../core";

export class EnvironmentId extends TextId {
    public constructor(value: string) {
        super(value, "Environment ID");
    }
}

export class ProviderId extends TextId {
    public constructor(value: string) {
        super(value, "Provider ID");
    }
}

export class EnvironmentSessionId extends TextId {
    public constructor(value: string) {
        super(value, "Environment session ID");
    }
}

export class EnvironmentSnapshotId extends TextId {
    public constructor(value: string) {
        super(value, "Environment snapshot ID");
    }
}

export class PortExposureId extends TextId {
    public constructor(value: string) {
        super(value, "Port exposure ID");
    }
}
