import { TextId } from "../core";

export class PackageId extends TextId {
    public constructor(value: string) {
        super(value, "Package ID");
        if (value.length === 0 || value !== value.trim()) {
            throw new TypeError("Package ID must be a nonblank canonical string");
        }
        Object.freeze(this);
    }
}
