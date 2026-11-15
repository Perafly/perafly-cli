/**
 * Faz 11.5: tek dosya ikilinin açılışı (src/binary.ts). Node SEA'da `process.argv[1]` ham `argv[0]`'dır; Git kimlik
 * yardımcısına çalışma klasörüne göre çözülen yalın ad (`<klasör>/perafly`) gitmemeli. Sahte `realpath` ile, gerçek dosya
 * sistemi olmadan.
 */
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { binaryEntryPath, type EntryPathInput } from "../src/binary.js";
import { helperCommand } from "../src/git/repo.js";

const EXE = "/opt/homebrew/Cellar/perafly/0.8.0/bin/perafly";

/** `links`: yol → gerçek yol (bağ ya da dosyanın kendisi); listede olmayan yol yoktur */
const input = (over: Partial<EntryPathInput>, links: Record<string, string> = {}): EntryPathInput => ({
    argv1: "perafly",
    execPath: EXE,
    pathEnv: "/usr/bin:/opt/homebrew/bin",
    platform: "darwin",
    cwd: "/work/repo",
    realpath: (p) => links[p] ?? (p === EXE ? EXE : null),
    ...over
});

describe("binaryEntryPath", () => {
    test("bare name from PATH resolves to the PATH entry that leads to this binary (stable across brew upgrades)", () => {
        const links = { "/opt/homebrew/bin/perafly": EXE, "/opt/homebrew/bin/pf": EXE };
        expect(binaryEntryPath(input({}, links))).toBe("/opt/homebrew/bin/perafly");
        expect(binaryEntryPath(input({ argv1: "pf" }, links))).toBe("/opt/homebrew/bin/pf");
    });

    test("a bare name is never resolved against the working folder", () => {
        // Depoda `perafly` adlı (ikiliye bile giden) bir dosya olsa da PATH'te değilse kullanılmaz
        const links = { "/work/repo/perafly": EXE };
        expect(binaryEntryPath(input({}, links))).toBe(EXE);
        // Göreli PATH girdisi (`.`) atlanır
        expect(binaryEntryPath(input({ pathEnv: ".:/usr/bin" }, links))).toBe(EXE);
    });

    test("a PATH entry that leads to another program is skipped", () => {
        const links = { "/usr/bin/perafly": "/usr/bin/perafly", "/opt/homebrew/bin/perafly": EXE };
        expect(binaryEntryPath(input({}, links))).toBe("/opt/homebrew/bin/perafly");
    });

    test("a typed path is made absolute when it is this binary", () => {
        const links = { "/work/repo/dist-bin/perafly-darwin-arm64": EXE };
        expect(binaryEntryPath(input({ argv1: "./dist-bin/perafly-darwin-arm64" }, links))).toBe("/work/repo/dist-bin/perafly-darwin-arm64");
        // Başka bir dosyayı gösteren argv[0] (`exec -a`) kullanılmaz
        expect(binaryEntryPath(input({ argv1: "./other" }))).toBe(EXE);
    });

    test("empty argv falls back to the binary itself", () => {
        expect(binaryEntryPath(input({ argv1: undefined }))).toBe(EXE);
        expect(binaryEntryPath(input({ argv1: "perafly", pathEnv: undefined }))).toBe(EXE);
    });

    test("Windows: PATH lookup adds .exe and uses ; as the separator", () => {
        const exe = "C:\\Users\\a\\.perafly\\bin\\perafly.exe";
        const links: Record<string, string> = { [exe]: exe };
        const got = binaryEntryPath({ argv1: "perafly", execPath: exe, pathEnv: "C:\\Windows;C:\\Users\\a\\.perafly\\bin", platform: "win32", cwd: "C:\\work", realpath: (p) => links[p] ?? null });
        expect(got).toBe(exe);
    });

    test("the Git credential helper gets an absolute path, not <cwd>/perafly", () => {
        const links: Record<string, string> = { "/home/a/.perafly/bin/perafly": "/home/a/.perafly/bin/perafly" };
        const argv1 = binaryEntryPath({ argv1: "perafly", execPath: "/home/a/.perafly/bin/perafly", pathEnv: "/usr/bin:/home/a/.perafly/bin", platform: "linux", cwd: "/work/repo", realpath: (p) => links[p] ?? null });
        expect(helperCommand({ argv1 })).toBe("!/home/a/.perafly/bin/perafly git credential");
        // Düzeltilmeden ham argv[0] verilseydi yardımcı çalışma klasöründeki dosyayı çalıştırırdı
        expect(helperCommand({ argv1: "perafly" })).toContain(resolve("perafly"));
    });
});
