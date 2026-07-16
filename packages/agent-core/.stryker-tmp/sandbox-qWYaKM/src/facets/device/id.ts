// @ts-nocheck
import { TextId } from "../../core";

export class DeviceId extends TextId {
    public constructor(value: string) {
        super(value, "Device ID");
        if (value.trim() !== value) throw new TypeError("Device ID must be canonical");
    }
}

export class DeviceCommandId extends TextId {
    public constructor(value: string) {
        super(value, "Device command ID");
        if (value.trim() !== value) throw new TypeError("Device command ID must be canonical");
    }
}
