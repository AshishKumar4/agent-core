import type { PrincipalId } from "./id";

export type PrincipalKind = "user" | "service" | "agent";

export type PrincipalStatus = "active" | "disabled";

export class Principal {
    public constructor(
        public readonly id: PrincipalId,
        public readonly kind: PrincipalKind,
        public readonly status: PrincipalStatus
    ) {
    }

    public get canAct(): boolean {
        return this.status === "active";
    }

    public disable(): Principal {
        return new Principal(this.id, this.kind, "disabled");
    }
}
