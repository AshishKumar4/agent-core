import { TextId } from "../core";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * A premise of the runtime plane, named in this plane's own vocabulary.
 *
 * Deliberately not an `ASM-*` value. Binding a runtime premise to a traceability assumption
 * is a reviewed claim-surface act under `AGENT_OPERATING_DOCTRINE.md` §2, and a module that
 * minted `ASM-*` strings would be asserting entries the ledger does not carry.
 */
export class RuntimePremiseId extends TextId {
    public constructor(value: string) {
        super(value, "Runtime premise ID");
        requireToken(value, "Runtime premise ID");
    }
}

/** A fault of the runtime plane, in the same vocabulary. */
export class RuntimeFaultId extends TextId {
    public constructor(value: string) {
        super(value, "Runtime fault ID");
        requireToken(value, "Runtime fault ID");
    }
}

/**
 * A claim whose deployed standing this plane tracks. The value is the ledger's own id —
 * `AC-*` or `NC-*` on the formal plane, `C13-*` or `P11-*` on the conformance plane. Both
 * shapes are admitted and neither is inferred from the other, because routing a claim
 * through the wrong plane is the mistake D-2 exists to prevent.
 */
export class AssuredClaimId extends TextId {
    public constructor(value: string) {
        super(value, "Assured claim ID");
        if (!/^(?:AC|NC|C13|P11)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value)) {
            throw new TypeError(
                "Assured claim ID must be an AC-, NC-, C13-, or P11- ledger identifier"
            );
        }
    }
}

/** The monitor an observation came from. */
export class RuntimeMonitorId extends TextId {
    public constructor(value: string) {
        super(value, "Runtime monitor ID");
    }
}

/** One report from one monitor over one observation window. */
export class MonitorReportId extends TextId {
    public constructor(value: string) {
        super(value, "Monitor report ID");
    }
}

function requireToken(value: string, subject: string): void {
    if (!TOKEN.test(value)) {
        throw new TypeError(`${subject} must be a lowercase hyphenated token`);
    }
}
