import {
    DeviceError,
    DeviceId,
    LIVE_DEVICE_OPERATIONS,
    type DeviceAgentBinding,
    type DeviceConsentBackend,
    type FacetRef,
    type ProtectedOperationRequest
} from "../facets";
import type {
    CanonicalBatchFinalAdmissionContext,
    CanonicalBatchFinalAdmissionPort,
    CanonicalBatchFinalAdmissionResult,
    CanonicalBatchInvocationRequest
} from "../invocations";

export class DeviceConsentFinalAdmissionPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> implements CanonicalBatchFinalAdmissionPort<
    Transaction,
    ProtectedOperationRequest,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> {
    public constructor(
        private readonly target: FacetRef,
        private readonly agent: DeviceAgentBinding,
        private readonly consent: DeviceConsentBackend<Transaction>
    ) {}

    public admit(
        transaction: Transaction,
        request: CanonicalBatchInvocationRequest<ProtectedOperationRequest>,
        _context: CanonicalBatchFinalAdmissionContext<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >
    ): CanonicalBatchFinalAdmissionResult {
        if (!request.request.facet.equals(this.target)) {
            return denied("Device consent admission targeted a different Facet");
        }
        const operation = request.request.descriptor.name.value;
        if (operation === "readCached" && request.request.descriptor.impact === "observe") {
            return { kind: "admitted" };
        }
        if (
            request.request.descriptor.impact !== "externalSend" ||
            !LIVE_DEVICE_OPERATIONS.includes(operation as never)
        ) {
            return denied("Device consent admission rejected an unknown live Operation");
        }
        const input = request.request.inputs[0];
        if (
            request.request.inputs.length !== 1 ||
            input === null ||
            Array.isArray(input) ||
            typeof input !== "object" ||
            typeof (input as Record<string, unknown>)["deviceId"] !== "string"
        ) {
            return denied("Device consent admission requires one exact Device input");
        }
        try {
            return {
                kind: "admitted",
                evidence: this.consent.admit(
                    transaction,
                    new DeviceId((input as Record<string, string>)["deviceId"]!),
                    this.agent.agent()
                )
            };
        } catch (error) {
            if (error instanceof DeviceError) return denied(error.message);
            throw error;
        }
    }
}

function denied(reason: string): CanonicalBatchFinalAdmissionResult {
    return { kind: "denied", reason };
}
