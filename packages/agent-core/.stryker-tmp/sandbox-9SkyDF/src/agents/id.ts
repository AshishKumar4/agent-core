// @ts-nocheck
import { TextId } from "../core";

export class AgentId extends TextId {
    public constructor(value: string) {
        super(value, "Agent ID");
    }
}

export class AgentProfileId extends TextId {
    public constructor(value: string) {
        super(value, "Agent profile ID");
    }
}

export class AgentPolicyId extends TextId {
    public constructor(value: string) {
        super(value, "Agent policy ID");
    }
}

export class ModelPolicyId extends TextId {
    public constructor(value: string) {
        super(value, "Model policy ID");
    }
}
