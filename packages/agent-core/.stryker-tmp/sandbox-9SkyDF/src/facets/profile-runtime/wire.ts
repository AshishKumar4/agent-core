// @ts-nocheck
import type { FacetData } from "../data";
import { canonicalFacetData } from "../data";
import { DetailedProfileError } from "./error";

export class ProfileWireCodec<Value> {
    public constructor(
        private readonly encodeValue: (value: Value) => FacetData,
        private readonly decodeValue: (data: FacetData) => Value
    ) {
        if (new.target === ProfileWireCodec) Object.freeze(this);
    }

    public encode(value: Value): FacetData {
        return canonicalFacetData(this.encodeValue(value));
    }

    public decode(data: FacetData): Value {
        return this.decodeValue(canonicalFacetData(data));
    }
}

export class VersionedProfileWireCodec<Value> extends ProfileWireCodec<Value> {
    public constructor(
        encodeValue: (value: Value) => FacetData,
        decodeValue: (data: FacetData) => Value,
        public readonly major = 1,
        public readonly minor = 0
    ) {
        super(encodeValue, decodeValue);
        if (
            !Number.isSafeInteger(major) ||
            major < 1 ||
            !Number.isSafeInteger(minor) ||
            minor < 0
        ) {
            throw new TypeError("Profile wire codec version is invalid");
        }
        Object.freeze(this);
    }

    public decodeVersion(
        version: { readonly major: number; readonly minor: number },
        data: FacetData
    ): Value {
        if (version.major !== this.major) {
            throw new DetailedProfileError(
                "codec.unknown-major",
                "wire.input",
                `Unsupported profile input codec major ${version.major}`
            );
        }
        if (!Number.isSafeInteger(version.minor) || version.minor < 0) {
            throw new DetailedProfileError(
                "codec.invalid",
                "wire.input",
                "Profile input codec minor is invalid"
            );
        }
        return this.decode(data);
    }
}

export function profileWireCodec<Value>(
    encode: (value: Value) => FacetData,
    decode: (data: FacetData) => Value
): ProfileWireCodec<Value> {
    return new ProfileWireCodec(encode, decode);
}

export function versionedProfileWireCodec<Value>(
    encode: (value: Value) => FacetData,
    decode: (data: FacetData) => Value
): VersionedProfileWireCodec<Value> {
    return new VersionedProfileWireCodec(encode, decode);
}

export function facetDataWireCodec<Value extends FacetData>(): ProfileWireCodec<Value> {
    return profileWireCodec(
        (value) => value,
        (data) => data as Value
    );
}

export const voidProfileWireCodec = profileWireCodec<void>(
    () => null,
    (data) => {
        if (data !== null) {
            throw new DetailedProfileError(
                "operation.invalid-input",
                "wire.input",
                "Void profile wire value must be null"
            );
        }
    }
);
