/**
 * UTF-16's surrogate range, as Unicode and ECMA-262 define it: a lone code unit in
 * D800-DFFF encodes half a supplementary code point and is not a scalar value, so a string
 * holding one has no UTF-8 encoding. Named because the four boundaries are the definition
 * of the range and nothing about this codebase; a bare hex literal in a comparison states
 * neither which half it bounds nor where the number comes from.
 */
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

export function isWellFormedUnicode(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST) {
            if (index + 1 >= value.length) return false;
            const next = value.charCodeAt(index + 1);
            if (next < LOW_SURROGATE_FIRST || next > LOW_SURROGATE_LAST) return false;
            index += 1;
        } else if (code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST) {
            return false;
        }
    }
    return true;
}
