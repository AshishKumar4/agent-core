// @ts-nocheck
export function compareText(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
