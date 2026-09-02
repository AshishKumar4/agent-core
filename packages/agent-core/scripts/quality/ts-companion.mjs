// The companion loader for the proof repair protocol's TypeScript modules.
//
// Those modules import each other with `.js` specifiers — the form TypeScript's own
// `moduleResolution: "Bundler"` accepts — while their sources ship as `.ts`. A bundler
// and the test runner resolve that pair natively; plain Node does not. This loader is the
// one place that mapping happens for the gates that execute outside a bundler: it
// rewrites a relative `.js` specifier to its `.ts` twin, and only when that twin exists,
// so every genuine `.mjs` import (the quality helpers these modules also use) is
// untouched. It is registered by the gate entry before the first protocol import, and
// nothing else imports it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
    if (
        specifier.startsWith(".") &&
        specifier.endsWith(".js") &&
        context.parentURL !== undefined &&
        context.parentURL.startsWith("file:")
    ) {
        const candidate = new URL(specifier, context.parentURL).href.replace(/\.js$/, ".ts");
        if (existsSync(fileURLToPath(candidate))) {
            return next(candidate, context);
        }
    }
    return next(specifier, context);
}
