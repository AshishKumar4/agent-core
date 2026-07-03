import { beforeEach, describe, expect, test } from "vitest";
import { AsyncFileSystem } from "../../src/facets/filesystem/async";
import { MemoryFileSystem } from "../../src/facets/filesystem/memory/memory";
import { createShell, type Shell } from "../../src/facets/shell/index";
import { testOperationContext } from "../helpers/context";

const context = testOperationContext("shell");

let shell: Shell;

beforeEach(async () => {
    shell = createShell(
        new AsyncFileSystem(new MemoryFileSystem()),
        context,
        { env: { WORKSPACE_ID: "workspace-1" } }
    );
    expect((await shell.exec("mkdir -p docs/src")).exitCode).toBe(0);
    expect((await shell.exec("printf 'alpha\\nbeta TODO\\ngamma\\n' > docs/readme.md")).exitCode).toBe(0);
    expect((await shell.exec("printf 'export const value = 1;\\n' > docs/src/main.ts")).exitCode).toBe(0);
});

describe("shell filesystem commands", () => {
    test("reads, lists, walks, searches, and reports filesystem entries", async () => {
        expect((await shell.exec("cat docs/readme.md")).stdout).toBe("alpha\nbeta TODO\ngamma\n");
        expect((await shell.exec("head -1 docs/readme.md")).stdout).toBe("alpha\n");
        expect((await shell.exec("tail -1 docs/readme.md")).stdout).toBe("gamma\n");
        expect((await shell.exec("ls docs")).stdout).toContain("readme.md");
        expect((await shell.exec("tree docs")).stdout).toContain("main.ts");
        expect((await shell.exec("find docs -name '*.ts' -type f")).stdout).toContain("docs/src/main.ts");
        expect((await shell.exec("grep -rn TODO docs")).stdout).toContain("docs/readme.md:2:beta TODO");
        expect((await shell.exec("stat docs/readme.md")).stdout).toContain("Type: file");
        expect((await shell.exec("wc -l docs/readme.md")).stdout).toContain("3 docs/readme.md");
    });

    test("creates, edits, copies, moves, appends, and removes entries", async () => {
        expect((await shell.exec("touch docs/empty.txt")).exitCode).toBe(0);
        expect((await shell.exec("sed -i 's/TODO/DONE/' docs/readme.md")).exitCode).toBe(0);
        expect((await shell.exec("cp docs/readme.md docs/copy.md")).exitCode).toBe(0);
        expect((await shell.exec("mv docs/copy.md docs/moved.md")).exitCode).toBe(0);
        expect((await shell.exec("echo appended >> docs/moved.md")).exitCode).toBe(0);
        expect((await shell.exec("echo piped | tee docs/tee.txt")).exitCode).toBe(0);
        expect((await shell.exec("rm docs/empty.txt")).exitCode).toBe(0);

        expect((await shell.exec("cat docs/readme.md")).stdout).toContain("DONE");
        expect((await shell.exec("tail -1 docs/moved.md")).stdout).toBe("appended\n");
        expect((await shell.exec("cat docs/tee.txt")).stdout).toBe("piped\n");
        expect((await shell.exec("cat docs/empty.txt")).stderr).toContain("No such file or directory");
    });

    test("supports recursive copy and removal", async () => {
        expect((await shell.exec("cp -r docs docs-copy")).exitCode).toBe(0);
        expect((await shell.exec("cat docs-copy/src/main.ts")).stdout).toContain("export const value");
        expect((await shell.exec("rm -r docs-copy")).exitCode).toBe(0);
        expect((await shell.exec("stat docs-copy")).stderr).toContain("No such file or directory");
    });

    test("preserves pipelines, redirects, substitutions, globs, and environment expansion", async () => {
        expect((await shell.exec("cat docs/readme.md | grep beta | wc -l")).stdout.trim()).toBe("1");
        expect((await shell.exec("echo $WORKSPACE_ID")).stdout.trim()).toBe("workspace-1");
        expect((await shell.exec("cat $(find docs -name 'readme.md')")).stdout).toContain("alpha");
        expect((await shell.exec("wc -l docs/*.md")).stdout).toContain("docs/readme.md");
        expect((await shell.exec("cat missing 2> docs/error.log")).stderr).toBe("");
        expect((await shell.exec("cat docs/error.log")).stdout).toContain("No such file or directory");
    });

    test("runs xargs through the shared dispatcher", async () => {
        expect((await shell.exec("printf 'docs/readme.md\n' | xargs cat")).stdout).toBe("alpha\nbeta TODO\ngamma\n");
        expect((await shell.exec("printf 'one two three' | xargs -n 1 echo")).stdout).toBe("one\ntwo\nthree\n");
    });
});
