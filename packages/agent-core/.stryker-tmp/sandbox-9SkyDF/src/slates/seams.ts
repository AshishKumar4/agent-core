// @ts-nocheck
import { InvocationId } from "../interaction-references";
import type { ReceiptId } from "../invocation-references";
import type {
    SlateInvocationRequest,
    SlateMutationRequest,
    SlatePreviewLinkIntent
} from "./intent";

export abstract class SlateMutationSeam {
    public abstract mutate<Result>(
        request: SlateMutationRequest,
        mutation: () => Result
    ): Promise<Result>;
}

export type SlateInvocationResult<Result> =
    | {
          readonly outcome: "succeeded";
          readonly receiptId: ReceiptId;
          readonly value: Result;
      }
    | {
          readonly outcome: "failed" | "indeterminate";
          readonly receiptId: ReceiptId;
      };

export class SlateEffectContext {
    public constructor(
        public readonly invocationId: InvocationId,
        public readonly itemIndex: number,
        public readonly attemptOrdinal: number,
        public readonly idempotencyKey: string
    ) {
        if (!(invocationId instanceof InvocationId)) {
            throw new TypeError("Slate effect Invocation ID is invalid");
        }
        if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) {
            throw new TypeError("Slate effect item index must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 0) {
            throw new TypeError("Slate effect attempt ordinal must be a non-negative safe integer");
        }
        if (
            typeof idempotencyKey !== "string" ||
            idempotencyKey.trim().length === 0 ||
            idempotencyKey !== idempotencyKey.trim()
        ) {
            throw new TypeError("Slate effect idempotency key must be canonical");
        }
        Object.freeze(this);
    }

    public sameItem(other: SlateEffectContext): boolean {
        return (
            this.invocationId.equals(other.invocationId) &&
            this.itemIndex === other.itemIndex &&
            this.idempotencyKey === other.idempotencyKey
        );
    }
}

export abstract class SlateInvocationSeam {
    public abstract prepare(request: SlateInvocationRequest): Promise<InvocationId>;

    public abstract invoke<Result>(
        request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>>;

    public abstract reconcile<Result>(
        request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>>;
}

export abstract class SlatePreviewValidationSeam {
    public abstract validate(request: SlatePreviewLinkIntent): Promise<void>;
}
