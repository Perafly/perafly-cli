/**
 * Faz 11.5: yayın betiklerinin saf parçaları (scripts/lib/release.mjs): platform adı eşleme, ikili adı, SHA256SUMS
 * yazma ve okuma, Homebrew formülü doldurma; yapılandırmanın tek kaynağı (packaging/release.json) ile kurulum
 * betikleri ve yayın iş akışının eşliği; install.sh'nin yerel bir HTTP sunucusuna karşı özet doğrulaması (sahte ikili).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
    FORMULA_TARGETS,
    TARGETS,
    binaryName,
    downloadBase,
    fillFormula,
    formatSha256Sums,
    isBinaryAsset,
    parseSha256Sums,
    tapShortName,
    targetFor,
    validateReleaseConfig
} from "../scripts/lib/release.mjs";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string) => readFile(join(ROOT, path), "utf8");
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("platform names", () => {
    test("process.platform and process.arch map to release targets", () => {
        expect(targetFor("darwin", "arm64")).toBe("darwin-arm64");
        expect(targetFor("darwin", "x64")).toBe("darwin-x64");
        expect(targetFor("linux", "x64")).toBe("linux-x64");
        expect(targetFor("linux", "arm64")).toBe("linux-arm64");
        expect(targetFor("win32", "x64")).toBe("windows-x64");
    });

    test("unpublished platforms are refused", () => {
        for (const [platform, arch] of [["win32", "arm64"], ["linux", "ia32"], ["freebsd", "x64"], ["linux", "riscv64"], ["sunos", "arm64"]] as const) {
            expect(() => targetFor(platform, arch)).toThrow(/Unsupported platform/);
        }
    });

    test("binary file names; only Windows has .exe", () => {
        expect(binaryName("darwin-arm64")).toBe("perafly-darwin-arm64");
        expect(binaryName("linux-x64")).toBe("perafly-linux-x64");
        expect(binaryName("windows-x64")).toBe("perafly-windows-x64.exe");
        expect(() => binaryName("windows-arm64")).toThrow();
        expect(TARGETS.map(binaryName).every(isBinaryAsset)).toBe(true);
        expect(isBinaryAsset("SHA256SUMS")).toBe(false);
        expect(isBinaryAsset("perafly-darwin-arm64.exe")).toBe(false);
        expect(isBinaryAsset("perafly.rb")).toBe(false);
    });
});

describe("SHA256SUMS", () => {
    const A = hex("a");
    const B = hex("b");

    test("written in GNU sha256sum format, sorted by name, with a trailing newline", () => {
        const text = formatSha256Sums([
            { name: "perafly-linux-x64", sha256: B },
            { name: "perafly-darwin-arm64", sha256: A.toUpperCase() }
        ]);
        expect(text).toBe(`${A}  perafly-darwin-arm64\n${B}  perafly-linux-x64\n`);
        expect(parseSha256Sums(text)).toEqual(new Map([["perafly-darwin-arm64", A], ["perafly-linux-x64", B]]));
        expect(formatSha256Sums([])).toBe("");
    });

    test("reads text and binary mode lines, CRLF, blank lines and upper-case digests", () => {
        const sums = parseSha256Sums(`${A.toUpperCase()}  perafly-darwin-arm64\r\n\r\n${B} *perafly-windows-x64.exe\n`);
        expect(sums.get("perafly-darwin-arm64")).toBe(A);
        expect(sums.get("perafly-windows-x64.exe")).toBe(B);
        expect(sums.size).toBe(2);
    });

    test("malformed, duplicate and path-carrying lines fail instead of being skipped", () => {
        expect(() => parseSha256Sums(`${A} perafly-linux-x64\n`)).toThrow(/line 1 is malformed/);
        expect(() => parseSha256Sums(`${A.slice(1)}  perafly-linux-x64\n`)).toThrow(/malformed/);
        expect(() => parseSha256Sums(`${A}  perafly-linux-x64\n${B}  perafly-linux-x64\n`)).toThrow(/twice/);
        expect(() => parseSha256Sums(`${A}  ../perafly-linux-x64\n`)).toThrow(/invalid file name/);
        expect(() => parseSha256Sums(`${A}  dist/perafly-linux-x64\n`)).toThrow(/invalid file name/);
        expect(() => formatSha256Sums([{ name: "x", sha256: "nothex" }])).toThrow(/Not a SHA-256/);
        expect(() => formatSha256Sums([{ name: "x", sha256: A }, { name: "x", sha256: B }])).toThrow(/Duplicate/);
    });
});

describe("release configuration", () => {
    test("packaging/release.json is the single source; install scripts carry the same default repository", async () => {
        const config = validateReleaseConfig(JSON.parse(await read("packaging/release.json")));
        expect(tapShortName(config.tap)).toMatch(/^[^/]+\/[^/]+$/);
        expect((await read("packaging/install.sh")).match(/^DEFAULT_REPOSITORY="([^"]+)"$/m)?.[1]).toBe(config.repository);
        expect((await read("packaging/install.ps1")).match(/^\$DefaultRepository = '([^']+)'$/m)?.[1]).toBe(config.repository);
    });

    test("invalid configuration is refused", () => {
        expect(() => validateReleaseConfig({ repository: "perafly", tap: "perafly/homebrew-tap" })).toThrow(/repository/);
        expect(() => validateReleaseConfig({ repository: "perafly/perafly-cli", tap: "perafly/tap" })).toThrow(/tap/);
        expect(() => validateReleaseConfig(null)).toThrow();
        expect(tapShortName("perafly/homebrew-tap")).toBe("perafly/tap");
    });

    test("the release workflow builds exactly the published targets", async () => {
        const workflow = await read(".github/workflows/release.yml");
        const targets = [...workflow.matchAll(/^\s+- target: (\S+)$/gm)].map((m) => m[1]);
        expect([...targets].sort()).toEqual([...TARGETS].sort());
        // Eylemler sürümüyle sabitlenir (tam SHA)
        for (const m of workflow.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
        // npm yayını yalnız etikette ve kaynak doğrulamasıyla
        expect(workflow).toMatch(/npm publish --provenance/);
    });
});

describe("Homebrew formula", () => {
    const sums = new Map(TARGETS.map((t) => [binaryName(t), hex(t)]));

    test("the template is filled with version, download address and the four macOS/Linux digests", async () => {
        const formula = fillFormula(await read("packaging/homebrew/perafly.rb"), { version: "1.2.3", repository: "perafly/perafly-cli", sums });
        expect(formula).not.toMatch(/\{\{/);
        expect(formula).toContain('version "1.2.3"');
        for (const t of FORMULA_TARGETS) {
            expect(formula).toContain(`url "${downloadBase("perafly/perafly-cli", "1.2.3")}/${binaryName(t)}"`);
            expect(formula).toContain(`sha256 "${hex(t)}"`);
        }
        expect(formula).not.toContain("windows");
        expect(formula).toMatch(/on_macos do[\s\S]*on_arm do[\s\S]*on_intel do[\s\S]*on_linux do[\s\S]*on_arm do[\s\S]*on_intel do/);
        expect(formula).toMatch(/test do\n\s+assert_equal version\.to_s, shell_output\("#\{bin\}\/perafly --version"\)\.strip/);
        expect(downloadBase("perafly/perafly-cli", "1.2.3")).toBe("https://github.com/perafly/perafly-cli/releases/download/v1.2.3");
    });

    test("a missing digest, a bad version or an unknown placeholder fails", async () => {
        const template = await read("packaging/homebrew/perafly.rb");
        const partial = new Map(sums);
        partial.delete("perafly-linux-arm64");
        expect(() => fillFormula(template, { version: "1.2.3", repository: "perafly/perafly-cli", sums: partial })).toThrow(/perafly-linux-arm64/);
        expect(() => fillFormula(template, { version: "v1.2", repository: "perafly/perafly-cli", sums })).toThrow(/version/);
        expect(() => fillFormula(template, { version: "1.2.3", repository: "not a repo", sums })).toThrow(/repository/);
        expect(() => fillFormula("{{NOPE}}", { version: "1.2.3", repository: "perafly/perafly-cli", sums })).toThrow(/NOPE/);
    });
});

describe.skipIf(process.platform === "win32")("install.sh against a local server", () => {
    const VERSION = "1.2.3";
    // Sahte ikili: yalnız sürümünü yazar
    const FAKE = `#!/bin/sh\necho ${VERSION}\n`;
    let server: Server;
    let base = "";
    let sumsBody = "";
    let tmp = "";

    beforeAll(async () => {
        tmp = await mkdtemp(join(tmpdir(), "perafly-install-"));
        server = createServer((req, res) => {
            const name = (req.url ?? "").slice(1);
            if (name === "SHA256SUMS") return void res.end(sumsBody);
            if (isBinaryAsset(name)) return void res.end(FAKE);
            res.statusCode = 404;
            res.end();
        });
        await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    });

    afterAll(async () => {
        await new Promise((ok) => server.close(ok));
        await rm(tmp, { recursive: true, force: true });
    });

    const install = (dir: string, env: Record<string, string> = {}) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((ok) => {
            execFile("sh", [join(ROOT, "packaging", "install.sh")], {
                env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, TMPDIR: tmp, SHELL: "/bin/zsh", PERAFLY_DOWNLOAD_BASE: base, PERAFLY_INSTALL_DIR: dir, ...env },
                timeout: 30_000
            }, (error, stdout, stderr) => ok({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
        });

    test("installs when the digest matches, adds the pf alias and prints PATH help", async () => {
        sumsBody = formatSha256Sums(TARGETS.map((t) => ({ name: binaryName(t), sha256: hex(FAKE) })));
        const dir = join(tmp, "ok", "bin");
        const r = await install(dir, { PERAFLY_VERSION: `v${VERSION}` });
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("Checksum verified");
        expect(r.stdout).toContain(`Installed perafly ${VERSION}`);
        expect(r.stdout).toContain(`export PATH="${dir}:$PATH"`);
        expect(await readFile(join(dir, "perafly"), "utf8")).toBe(FAKE);
        expect((await stat(join(dir, "perafly"))).mode & 0o777).toBe(0o755);
        expect((await readdir(dir)).sort()).toEqual(["perafly", "pf"]);
    });

    test("refuses a wrong digest and installs nothing", async () => {
        sumsBody = formatSha256Sums(TARGETS.map((t) => ({ name: binaryName(t), sha256: hex("something else") })));
        const dir = join(tmp, "bad", "bin");
        const r = await install(dir);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/checksum mismatch .* Nothing was installed/);
        await expect(stat(dir)).rejects.toThrow();
    });

    test("refuses when SHA256SUMS has no entry for this platform", async () => {
        sumsBody = `${hex(FAKE)}  perafly-other\n`;
        const r = await install(join(tmp, "missing", "bin"));
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/no single entry/);
    });

    test("refuses a binary whose version differs from PERAFLY_VERSION", async () => {
        sumsBody = formatSha256Sums(TARGETS.map((t) => ({ name: binaryName(t), sha256: hex(FAKE) })));
        const dir = join(tmp, "version", "bin");
        const r = await install(dir, { PERAFLY_VERSION: "9.9.9" });
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/version 1\.2\.3, expected 9\.9\.9/);
        expect(await readdir(dir)).toEqual([]);
    });

    test("plain http is refused unless it is localhost; no sudo, no token", async () => {
        const r = await install(join(tmp, "http", "bin"), { PERAFLY_DOWNLOAD_BASE: "http://example.com/perafly" });
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/must use https/);
        const script = await read("packaging/install.sh");
        expect(script).not.toMatch(/(^|[;&|(]\s*)sudo\s/m);
        expect(script).not.toMatch(/TOKEN|PERAFLY_HOME|credentials/);
    });
});
