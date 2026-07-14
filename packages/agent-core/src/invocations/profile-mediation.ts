import { AgentCoreError } from "../errors";
import type { ProtectedOperationRequest, ProtectedOperationResult } from "../facets";
import { OperationRequestKey } from "../operations";
import type { InvocationId } from "../interaction-references";
import type { CanonicalBatchInvoker } from "./canonical-batch";
import { AttemptReceipt, PreEffectReceipt, type Receipt } from "./receipt";

export interface ProfileMediationIdentityPort {
    invocation(request: ProtectedOperationRequest): InvocationId;
}

export class InvocationProtectedOperationPort {
    public constructor(
        private readonly identities: ProfileMediationIdentityPort,
        private readonly invocations: CanonicalBatchInvoker<ProtectedOperationRequest>
    ) {}

    public async invoke(
        request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<Receipt>> {
        const invocation = this.identities.invocation(request);
        const result = await this.invocations.invoke({
            invocation,
            request: {
                requestKey: new OperationRequestKey(`profile:${invocation.value}`),
                facet: request.facet,
                descriptor: request.operation.descriptor,
                shape: { kind: "single" },
                inputs: [request.input],
                authorization: request,
                interceptions: [[]],
                execute: (_itemIndex, context) => request.operation.execute(context, request.input)
            }
        });
        const item = result.items[0];
        if (result.items.length !== 1 || item === undefined || item.itemIndex !== 0) {
            throw invalid("Profile mediation returned a substituted canonical item result");
        }
        if (request.resultMode === "receipt") {
            return Object.freeze({ kind: "receipt", receipt: item.receipt });
        }
        if (item.kind === "succeeded") {
            return Object.freeze({ kind: "output", output: item.output, receipt: item.receipt });
        }
        throw terminal(item.receipt);
    }
}

function terminal(receipt: Receipt): AgentCoreError {
    if (receipt instanceof PreEffectReceipt) {
        return new AgentCoreError("authority.denied", receipt.reason);
    }
    if (receipt instanceof AttemptReceipt && receipt.outcome === "indeterminate") {
        return invalid("Profile Operation outcome is indeterminate");
    }
    return invalid("Profile Operation did not produce a successful output");
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
