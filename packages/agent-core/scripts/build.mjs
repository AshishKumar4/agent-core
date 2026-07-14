import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
    access,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

const entries = Object.fromEntries(
    await Promise.all(
        Object.values(packageJson.exports).map(async (targets) => {
            const name = targets.import.replace(/^\.\/dist\//, "").replace(/\.js$/, "");
            const source = resolve(packageRoot, "src", `${name}.ts`);
            await access(source);
            return [name, source];
        })
    )
);

await build({
    configFile: false,
    root: packageRoot,
    build: {
        emptyOutDir: true,
        lib: {
            entry: entries,
            formats: ["es"]
        },
        minify: false,
        outDir: resolve(packageRoot, "dist"),
        rollupOptions: {
            external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
            output: {
                chunkFileNames: "chunks/[name]-[hash].js",
                entryFileNames: "[name].js"
            }
        },
        sourcemap: true,
        target: "es2022"
    }
});

const declarationRoot = await mkdtemp(resolve(tmpdir(), "agent-core-declarations-"));
try {
    emitDeclarations(declarationRoot);
    await rewriteDeclarationSpecifiers(declarationRoot);
    const closure = await declarationClosure(declarationRoot);
    for (const declarationFile of closure) {
        const destination = resolve(
            packageRoot,
            "dist",
            relative(declarationRoot, declarationFile)
        );
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(declarationFile, destination);
    }
} finally {
    await rm(declarationRoot, { recursive: true, force: true });
}

function emitDeclarations(outDir) {
    const tsc = resolve(packageRoot, "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(
        process.execPath,
        [tsc, "-p", "./tsconfig.build.json", "--outDir", outDir],
        {
            cwd: packageRoot,
            encoding: "utf8"
        }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
}

async function rewriteDeclarationSpecifiers(root) {
    for (const declarationFile of await filesWithSuffix(root, ".d.ts")) {
        const source = await readFile(declarationFile, "utf8");
        const parsed = ts.createSourceFile(declarationFile, source, ts.ScriptTarget.Latest, true);
        const replacements = [];
        visit(parsed, (node) => {
            if (
                (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                node.moduleSpecifier !== undefined &&
                ts.isStringLiteral(node.moduleSpecifier)
            ) {
                addReplacement(node.moduleSpecifier);
            } else if (
                ts.isImportTypeNode(node) &&
                ts.isLiteralTypeNode(node.argument) &&
                ts.isStringLiteral(node.argument.literal)
            ) {
                addReplacement(node.argument.literal);
            }
        });
        let rewritten = source;
        for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
            rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
        }
        await writeFile(declarationFile, rewritten, "utf8");

        function addReplacement(literal) {
            const specifier = literal.text;
            if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
            if (specifier.endsWith(".js")) return;
            const target = resolve(dirname(declarationFile), specifier);
            const replacement = existsSync(`${target}.d.ts`)
                ? `${specifier}.js`
                : existsSync(resolve(target, "index.d.ts"))
                  ? `${specifier}/index.js`
                  : undefined;
            if (replacement === undefined) {
                throw new TypeError(
                    `Cannot resolve declaration specifier ${specifier} from ${declarationFile}`
                );
            }
            replacements.push({
                start: literal.getStart(parsed) + 1,
                end: literal.getEnd() - 1,
                value: replacement
            });
        }
    }
}

async function declarationClosure(root) {
    const pending = Object.values(packageJson.exports).map((target) =>
        resolve(root, target.types.replace(/^\.\/dist\//, ""))
    );
    const closure = new Set();
    while (pending.length > 0) {
        const declarationFile = pending.pop();
        if (closure.has(declarationFile)) continue;
        await access(declarationFile);
        closure.add(declarationFile);
        const source = await readFile(declarationFile, "utf8");
        const parsed = ts.createSourceFile(declarationFile, source, ts.ScriptTarget.Latest, true);
        visit(parsed, (node) => {
            const literal =
                ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
                    ? node.moduleSpecifier
                    : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
                      ? node.argument.literal
                      : undefined;
            if (literal === undefined || !ts.isStringLiteral(literal)) return;
            if (!literal.text.startsWith("./") && !literal.text.startsWith("../")) return;
            const target = resolve(
                dirname(declarationFile),
                literal.text.replace(/\.js$/, ".d.ts")
            );
            if (!isWithin(target, root))
                throw new TypeError(`Declaration import escapes build root: ${literal.text}`);
            pending.push(target);
        });
    }
    return [...closure].sort();
}

async function filesWithSuffix(root, suffix) {
    const entries = await readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...(await filesWithSuffix(path, suffix)));
        else if (entry.name.endsWith(suffix)) files.push(path);
    }
    return files;
}

function visit(node, inspect) {
    inspect(node);
    node.forEachChild((child) => visit(child, inspect));
}

function isWithin(path, root) {
    const offset = relative(root, path);
    return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== "..");
}
