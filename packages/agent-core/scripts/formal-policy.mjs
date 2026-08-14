export const allowedBuiltInAxioms = Object.freeze(["Classical.choice", "Quot.sound", "propext"]);

const designationPattern = /^\s*#print\s+axioms\s+(\S+)\s*$/u;

export function extractAxiomDesignations(source) {
    const designations = [];
    for (const line of source.split(/\r?\n/u)) {
        const match = designationPattern.exec(line);
        if (match === null) continue;
        const name = match[1];
        if (!/^AgentCore(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(name)) {
            throw new TypeError(`invalid Axioms.lean designation ${name}`);
        }
        designations.push({
            kind: name.startsWith("AgentCore.Examples.") ? "witness" : "claim",
            name
        });
    }
    if (designations.length === 0) {
        throw new TypeError("Axioms.lean contains no #print axioms designations");
    }
    const names = designations.map(({ name }) => name);
    if (new Set(names).size !== names.length) {
        throw new TypeError("Axioms.lean contains duplicate #print axioms designations");
    }
    return designations;
}
