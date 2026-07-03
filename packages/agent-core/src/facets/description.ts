import type { FacetVersion } from "./id";

export class AuthoritySummary {
    private constructor(public readonly text: string) {
    }

    public static none(): AuthoritySummary {
        return new AuthoritySummary("No external authority.");
    }

    public static scoped(text: string): AuthoritySummary {
        return new AuthoritySummary(text);
    }
}

export class FacetDescription {
    public constructor(
        public readonly title: string,
        public readonly summary: string,
        public readonly version: FacetVersion,
        public readonly authority: AuthoritySummary
    ) {
    }
}
