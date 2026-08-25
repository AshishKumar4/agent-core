import { TextId, type JsonValue } from "../../core";
import { requireExactFields, requireInteger, requireObject, requireString } from "../record-data";

/**
 * The currency one Run lineage records every realized cost in (SPEC §5.2). The rate source
 * is out of scope, so this platform compares codes for equality and never interprets them.
 * The code is opaque text for that reason, and identity is by type and value like every
 * other `TextId`.
 */
export class Currency extends TextId {
    public constructor(value: string) {
        super(value, "Currency");
    }
}

/**
 * One model call's realized cost, as the call incurred it (SPEC §5.2). `micros` is integer
 * millionths of the currency's major unit.
 *
 * There is no estimated form of this value, and that absence is the rule rather than an
 * omission: a host with no realized cost to record declares the `costMicros` dimension
 * nowhere, so a host that has nothing to report has nothing to build here either. The value
 * travels from the executor seam to the Run's running total unchanged, so a rate table can
 * produce the number a host reports but can never stand in for a cost the call incurred.
 */
export class RealizedCost {
    public readonly micros: number;
    public readonly currency: Currency;

    public constructor(micros: number, currency: Currency) {
        if (!Number.isSafeInteger(micros) || micros < 0) {
            throw new TypeError("Realized cost must be a non-negative safe integer of micros");
        }
        if (!(currency instanceof Currency)) {
            throw new TypeError("Realized cost must name its currency");
        }
        this.micros = micros;
        this.currency = currency;
        Object.freeze(this);
    }

    public equals(other: RealizedCost): boolean {
        return this.micros === other.micros && this.currency.equals(other.currency);
    }

    public toData(): JsonValue {
        return { currency: this.currency.value, micros: this.micros };
    }

    public static fromData(value: JsonValue): RealizedCost {
        const object = requireObject(value, "Realized cost");
        requireExactFields(object, ["currency", "micros"], [], "Realized cost");
        return new RealizedCost(
            requireInteger(object["micros"], "Realized cost micros"),
            new Currency(requireString(object["currency"], "Realized cost currency"))
        );
    }
}
