import { isJsonObject, isNonEmptyString } from "./project.mjs";

const recordFields = [
    "codec",
    "durability",
    "kind",
    "ownerActor",
    "source",
    "store",
    "symbol",
    "tests"
];

export function validateRecordOwnership(records) {
    if (!Array.isArray(records)) throw new TypeError("Record ownership registry must be an array");
    const kinds = new Set();
    const symbols = new Set();

    for (const record of records) {
        validateRecord(record, kinds, symbols);
    }
}

function validateRecord(record, kinds, symbols) {
    if (!isJsonObject(record) || !sameFields(record, recordFields)) {
        throw new TypeError(
            `Durable record ${isJsonObject(record) ? (record.symbol ?? "<unknown>") : "<unknown>"} has missing or unknown fields`
        );
    }
    if (
        ![record.symbol, record.kind, record.source, record.codec].every(isNonEmptyString) ||
        kinds.has(record.kind) ||
        symbols.has(record.symbol)
    ) {
        throw new TypeError(
            `Durable record ownership is duplicated or malformed for ${record.kind}`
        );
    }
    if (
        !Array.isArray(record.tests) ||
        record.tests.length === 0 ||
        new Set(record.tests).size !== record.tests.length ||
        record.tests.some(
            (selector) => !isNonEmptyString(selector) || !selector.includes(`[${record.kind}]`)
        )
    ) {
        throw new TypeError(`Record ${record.kind} requires unique kind-bearing ownership tests`);
    }
    if (record.durability === "durable") {
        if (!isNonEmptyString(record.ownerActor) || !isNonEmptyString(record.store)) {
            throw new TypeError(`Durable record ${record.kind} requires one Actor and store`);
        }
    } else if (
        record.durability !== "value" ||
        record.ownerActor !== null ||
        record.store !== null
    ) {
        throw new TypeError(`Value record ${record.kind} must not claim durable ownership`);
    }
    kinds.add(record.kind);
    symbols.add(record.symbol);
}

function sameFields(record, fields) {
    const actual = Object.keys(record).sort();
    return (
        actual.length === fields.length && actual.every((field, index) => field === fields[index])
    );
}
