// @ts-nocheck
import { AgentCoreError, type AgentCoreErrorCode } from "../../errors";

export class DetailedProfileError<DetailCode extends string = string> extends AgentCoreError {
    public readonly detail: Readonly<{ code: DetailCode }>;

    public constructor(
        code: AgentCoreErrorCode,
        public readonly detailCode: DetailCode,
        message: string
    ) {
        super(code, message);
        this.name = "DetailedProfileError";
        this.detail = Object.freeze({ code: detailCode });
    }
}
