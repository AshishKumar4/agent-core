import { describe, expect, test } from "vitest";
import { profileLabels, specAtoms } from "../../scripts/quality/spec.mjs";

const normativeMap = {
    authoritativeOutsideSection13: []
};

describe("SPEC Markdown model", () => {
    test("ignores atomic labels in fenced examples and comments", () => {
        const source = `
<!-- **C13-AUTH-COMMENT** is not normative. -->

\`\`\`md
**C13-AUTH-EXAMPLE** is not normative.
\`\`\`

## 13. Conformance

- **C13-AUTH-REAL** The real requirement.

\`\`\`md
- **C13-AUTH-FENCED** A non-normative example.
\`\`\`

## 14. The formal model
`;

        expect(specAtoms(source, normativeMap).map((atom) => atom.id)).toEqual(["C13-AUTH-REAL"]);
    });

    test("discovers only structural profile labels", () => {
        const source = `
## 11. Profiles

- **P11-BASE-REAL** The real base profile rule.

\`\`\`md
- **P11-BASE-FENCED** A non-normative example.
\`\`\`

<!-- - **P11-BASE-COMMENT** A non-normative comment. -->

## 12. Assembly sketches
`;

        expect(profileLabels(source)).toEqual(["P11-BASE-REAL"]);
    });
});
