/**
 * Faz 4: onay bekleme, sürdürme, devir bağlantısı, API anahtarları, yerel MCP (dosya erişimi, araçlar, sonuçta sır
 * yok), köprünün adres kuralı, ajan istemcisi kurulumu ve beceri. Gerçek ağ ve gerçek ev klasörü yok.
 */
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { setKeyringLoaderForTests } from "../src/auth/store.js";
import { resolveInsideRoot } from "../src/mcp/files.js";
import { allowedMcpEndpoint, defaultMcpEndpoint } from "../src/mcp/proxy.js";
import { createLocalHandlers } from "../src/mcp/server.js";
import { install, serverSpec } from "../src/mcp/install.js";
import { HIDDEN_OPERATIONS, OPERATION_PERMISSION, operationSpecs } from "../src/mcp/tools.js";
import openapi from "../src/api/openapi.json" with { type: "json" };

const API = "https://api.perafly.test";
const KEY = `pfa_${"A1b2C3d4".repeat(4)}`;
const PKEY = `pfc_${"P1q2R3s4".repeat(4)}`;
const PRJ = "prj_abcdefghjkmnpqrstvwxyz01";
const VER = "ver_abcdefghjkmnpqrstvwxyz01";
const EXE = "exe_abcdefghjkmnpqrstvwxyz01";

class Sink extends Writable {
    text = "";
    isTTY = false;
    override _write(chunk: any, _e: string, cb: () => void) {
        this.text += chunk.toString();
        cb();
    }
}
interface Call { method: string; path: string; auth: string | null; body: any }
type Handler = (c: Call) => { status: number; json?: unknown } | undefined;

let home: string;
let dir: string;
let calls: Call[];
const savedHome = process.env.PERAFLY_HOME;

const fakeFetch = (handler: Handler) => (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call = { method: init.method ?? "GET", path: url.pathname + url.search, auth: init.headers?.Authorization ?? null, body };
    calls.push(call);
    const r = handler(call);
    if (!r) return new Response(JSON.stringify({ status: 404, code: "not_found", title: "Not found" }), { status: 404 });
    return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status });
}) as typeof fetch;

const cli = async (argv: string[], handler: Handler, env: Record<string, string> = {}, stdinText?: string) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const stdin = Object.assign(Readable.from(stdinText !== undefined ? [Buffer.from(stdinText)] : []), { isTTY: false }) as any;
    const code = await run(argv, { env: { PERAFLY_HOME: home, PERAFLY_API_URL: API, PERAFLY_CREDENTIAL_STORE: "plaintext", ...env }, fetch: fakeFetch(handler), sleep: async () => undefined, stdout, stderr, stdin });
    const parse = (t: string) => {
        try {
            return JSON.parse(t.trim().split("\n").pop()!);
        } catch {
            return null;
        }
    };
    return { code, stdout: stdout.text, stderr: stderr.text, json: parse(stdout.text), err: parse(stderr.text) };
};

const project = (over: Record<string, unknown> = {}) => ({ id: PRJ, name: "acme", teamId: "t1", urls: { live: "https://acme.perafly.app" }, anonymous: null, ...over });
const version = (over: Record<string, unknown> = {}) => ({ id: VER, number: 2, state: "ready", target: "live", url: "https://acme--v2.perafly.app", live: false, approval: null, ...over });
const pendingApproval = { status: "pending", executionId: EXE, expiresAt: "2026-11-14T12:00:00Z", approvalUrl: "https://perafly.com/app/t1/approvals/exe" };

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pf-home-"));
    process.env.PERAFLY_HOME = home;
    dir = await mkdtemp(join(tmpdir(), "pf-site-"));
    await writeFile(join(dir, "index.html"), "<h1>v2</h1>");
    await mkdir(join(dir, ".perafly"));
    await writeFile(join(dir, ".perafly", "project.json"), JSON.stringify({ projectId: PRJ, apiUrl: API }));
    calls = [];
    setKeyringLoaderForTests(async () => null);
});
afterEach(async () => {
    if (savedHome === undefined) delete process.env.PERAFLY_HOME;
    else process.env.PERAFLY_HOME = savedHome;
    setKeyringLoaderForTests(null);
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
});

describe("onay bekleyen yayın ve öne alma", () => {
    const publishHandler = (execStatuses: string[]): Handler => (c) => {
        if (c.path === "/v1/publish") return { status: 201, json: { project: project(), version: version({ state: "uploading" }), uploads: [] } };
        if (c.path.startsWith(`/v1/versions/${VER}/finalize`)) return { status: 200, json: { project: project(), version: version({ approval: pendingApproval }) } };
        if (c.path === `/v1/executions/${EXE}`) return { status: 200, json: { id: EXE, kind: "publish", status: execStatuses.shift() ?? "succeeded" } };
        if (c.path === `/v1/executions/${EXE}/resume`) return { status: 200, json: { execution: { id: EXE, status: "succeeded" }, project: project(), version: version({ live: true, approval: { ...pendingApproval, status: "succeeded" } }) } };
        return undefined;
    };

    test("yayın: sürüm hazır, onay beklenir; onaylanınca canlı; bekleme yönergesi stderr'de", async () => {
        const r = await cli(["publish", ".", "--cwd", dir, "--json"], publishHandler(["pending", "pending", "succeeded"]), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.json.data.live).toBe(true);
        expect(r.stderr).toContain("Waiting for a teammate to approve at https://perafly.com/app/t1/approvals/exe");
        expect(calls.filter((c) => c.path === `/v1/executions/${EXE}`)).toHaveLength(3);
    });

    test("--no-wait: approval_required, çıkış 2, recovery operations resume", async () => {
        const r = await cli(["publish", ".", "--cwd", dir, "--json", "--no-wait"], (c) => {
            if (c.path === "/v1/publish") return { status: 201, json: { project: project(), version: version({ state: "uploading" }), uploads: [] } };
            if (c.path.startsWith(`/v1/versions/${VER}/finalize`)) return { status: 200, json: { project: project(), version: version({ approval: pendingApproval }) } };
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(2);
        expect(r.err.error).toMatchObject({ code: "approval_required", recovery: `perafly operations resume ${EXE}` });
        expect(r.err.error.details.execution.id).toBe(EXE);
    });

    test("öne alma: 403 approval_required → bekler; reddedilirse approval_declined çıkış 10; ikinci istek açılmaz", async () => {
        const r = await cli(["promote", "v1", "--cwd", dir, "--json"], (c) => {
            if (c.path.endsWith("/promote")) return { status: 403, json: { status: 403, code: "approval_required", title: "Approval required", execution: { id: EXE, status: "pending", approvalUrl: "u", expiresAt: "x" } } };
            if (c.path === `/v1/executions/${EXE}`) return { status: 200, json: { id: EXE, status: "denied", reason: "Not now" } };
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(10);
        expect(r.err.error.code).toBe("approval_declined");
        expect(calls.filter((c) => c.path.endsWith("/promote"))).toHaveLength(1);
    });

    test("operations resume: karar bekler, sonucu yazar", async () => {
        let resumes = 0;
        const r = await cli(["operations", "resume", EXE, "--json"], (c) => {
            if (c.path === `/v1/executions/${EXE}/resume`) {
                if (resumes++ === 0) return { status: 409, json: { status: 409, code: "approval_pending", execution: { id: EXE, status: "pending" } } };
                return { status: 200, json: { execution: { id: EXE, kind: "promote", status: "succeeded" }, project: project(), version: version({ number: 1, live: true }) } };
            }
            if (c.path === `/v1/executions/${EXE}`) return { status: 200, json: { id: EXE, status: "succeeded" } };
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.json.data.execution.status).toBe("succeeded");
    });
});

describe("devir bağlantısı ve API anahtarları", () => {
    test("login --handoff: bağlantı stdin'den; anahtar klasöre 0600, klasör bağlanır, çıktıda anahtar yok", async () => {
        const handoffKey = `pfa_${"H".repeat(32)}`;
        const link = `https://perafly.com/handoff#pfh_${"x1Y2".repeat(8)}`;
        const r = await cli(["login", "--handoff", "--cwd", dir, "--json"], (c) => {
            if (c.path === "/v1/auth/handoff") {
                expect(c.body.token).toBe(link.split("#")[1]);
                expect(c.auth).toBeNull();
                return { status: 200, json: { token: handoffKey, access: "agent", expiresAt: "2026-12-14", project: { id: PRJ, name: "acme" }, team: { id: "t1", name: "Acme" }, user: { id: "u1", name: "Ada" } } };
            }
            return undefined;
        }, {}, `${link}\n`);
        expect(r.code).toBe(0);
        expect(r.stdout + r.stderr).not.toContain(handoffKey);
        const state = JSON.parse(await readFile(join(dir, ".perafly", "state.json"), "utf8"));
        expect(state.projectApiKey).toMatchObject({ token: handoffKey, projectId: PRJ });
        expect((await stat(join(dir, ".perafly", "state.json"))).mode & 0o777).toBe(0o600);
        // Profil girişi yok: klasörün anahtarı kullanılır
        const who = await cli(["whoami", "--cwd", dir, "--json"], (c) => (c.path === "/v1/me" ? { status: 200, json: { kind: "apiKey", key: { kind: "project" } } } : undefined));
        expect(who.json.data.source).toBe("folder");
        expect(calls.at(-1)!.auth).toBe(`Bearer ${handoffKey}`);
    });

    test("api-keys create: etkileşimsiz kipte --out ister; --out dosyası 0600, sır çıktıda yok", async () => {
        const secret = `pfa_${"S".repeat(32)}`;
        const handler: Handler = (c) => (c.path === "/v1/api-keys" && c.method === "POST" ? { status: 201, json: { key: { id: "key_abcdefghjkmnpqrstvwxyz01", name: "CI", prefix: secret.slice(0, 12) }, secret } } : undefined);
        const noOut = await cli(["api-keys", "create", "CI", "--json"], handler, { PERAFLY_TOKEN: KEY });
        expect(noOut.code).toBe(2);
        expect(calls).toHaveLength(0);
        const r = await cli(["api-keys", "create", "CI", "--out", "ci.key", "--cwd", dir, "--json"], handler, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain(secret);
        expect((await readFile(join(dir, "ci.key"), "utf8")).trim()).toBe(secret);
        expect((await stat(join(dir, "ci.key"))).mode & 0o777).toBe(0o600);
    });
});

describe("yerel MCP: dosya erişimi", () => {
    test("kökün içi kabul; dışarısı, `..`, sembolik bağ reddedilir", async () => {
        const root = dir;
        await mkdir(join(root, "dist"));
        expect(await resolveInsideRoot(root, "dist")).toMatch(/dist$/);
        expect(await resolveInsideRoot(root, undefined)).toBeTruthy();
        const outside = await mkdtemp(join(tmpdir(), "pf-out-"));
        try {
            await symlink(outside, join(root, "link"));
            await expect(resolveInsideRoot(root, "link")).rejects.toMatchObject({ code: "path_outside_workspace" });
            await expect(resolveInsideRoot(root, "../")).rejects.toMatchObject({ code: "path_outside_workspace" });
            await expect(resolveInsideRoot(root, outside)).rejects.toMatchObject({ code: "path_outside_workspace" });
            await expect(resolveInsideRoot(root, "/etc")).rejects.toMatchObject({ code: "path_outside_workspace" });
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

describe("yerel MCP: araçlar", () => {
    test("her OpenAPI işlemi ya araçtır ya gizli; izne göre listelenir", async () => {
        const ops: string[] = [];
        for (const item of Object.values((openapi as any).paths)) for (const op of Object.values(item as any)) if ((op as any)?.operationId) ops.push((op as any).operationId);
        for (const op of ops) expect([op, op in OPERATION_PERMISSION || HIDDEN_OPERATIONS.has(op)]).toEqual([op, true]);
        expect(operationSpecs().map((s) => s.operationId)).not.toContain("createApiKey");
        process.env.PERAFLY_HOME = home;
        const h = createLocalHandlers({ root: dir, flags: { apiUrl: API }, deps: { env: { PERAFLY_HOME: home, PERAFLY_TOKEN: KEY, PERAFLY_CREDENTIAL_STORE: "plaintext" }, fetch: fakeFetch((c) => (c.path === "/v1/me" ? { status: 200, json: { permissions: ["projects.read", "projects.write", "publish.write", "versions.promote"] } } : undefined)) } });
        const names = (await h.listTools()).map((t: any) => t.name);
        expect(names).toEqual(expect.arrayContaining(["publish", "listProjects", "promoteProjectVersion", "operation_status", "resume_execution"]));
        expect(names).not.toContain("deleteProject");
    });

    test("publish aracı: kök dışı yol reddedilir; onay bekleyen yayın approval_required döner (beklemez); sonuçta anahtar yok", async () => {
        const h = createLocalHandlers({
            root: dir, flags: { apiUrl: API },
            deps: {
                env: { PERAFLY_HOME: home, PERAFLY_TOKEN: KEY, PERAFLY_CREDENTIAL_STORE: "plaintext" }, sleep: async () => undefined,
                fetch: fakeFetch((c) => {
                    if (c.path === "/v1/publish") return { status: 201, json: { project: project(), version: version({ state: "uploading" }), uploads: [] } };
                    if (c.path.startsWith(`/v1/versions/${VER}/finalize`)) return { status: 200, json: { project: project(), version: version({ approval: pendingApproval }) } };
                    return undefined;
                })
            }
        });
        const outside = await h.callTool("publish", { path: "../" });
        expect(outside.isError).toBe(true);
        expect((outside.structuredContent as any).error.code).toBe("path_outside_workspace");
        const r = await h.callTool("publish", { path: "." });
        expect(r.isError).toBe(true);
        expect((r.structuredContent as any).error).toMatchObject({ code: "approval_required", details: { execution: { id: EXE } } });
        expect(calls.some((c) => c.path.startsWith("/v1/executions/"))).toBe(false);
        expect(JSON.stringify(r)).not.toContain(KEY);
    });

    test("hesapsız yayın aracı: proje anahtarı ve sahiplenme bağlantısı sonuca girmez", async () => {
        await rm(join(dir, ".perafly", "project.json"));
        const h = createLocalHandlers({
            root: dir, flags: { apiUrl: API },
            deps: {
                env: { PERAFLY_HOME: home, PERAFLY_CREDENTIAL_STORE: "plaintext" }, sleep: async () => undefined,
                fetch: fakeFetch((c) => {
                    if (c.path === "/v1/publish") return { status: 201, json: { project: project({ teamId: null, anonymous: { expiresAt: "e", claimDeadline: "d" } }), version: version({ state: "uploading" }), uploads: [], projectKey: PKEY, claimUrl: `https://perafly.com/claim#${PRJ}.${PKEY}`, expiresAt: "e", claimDeadline: "d" } };
                    if (c.path.startsWith(`/v1/versions/${VER}/finalize`)) return { status: 200, json: { project: project(), version: version({ live: true }) } };
                    return undefined;
                })
            }
        });
        expect((await h.listTools()).map((t: any) => t.name)).toEqual(["publish"]);
        const r = await h.callTool("publish", {});
        expect(r.isError).toBeFalsy();
        expect(JSON.stringify(r)).not.toContain(PKEY);
        expect(JSON.stringify(r)).not.toContain("/claim#");
        expect((r.structuredContent as any).next).toContain("perafly projects claim");
        expect(JSON.parse(await readFile(join(dir, ".perafly", "state.json"), "utf8")).anonymous.projectKey).toBe(PKEY);
    });
});

describe("köprü", () => {
    test("anahtar yalnız aynı API'nin MCP adresine, üretim MCP alan adına ya da yerel döngüye gider", () => {
        expect(defaultMcpEndpoint("https://api.perafly.com")).toBe("https://mcp.perafly.com");
        expect(defaultMcpEndpoint("http://127.0.0.1:5599")).toBe("http://127.0.0.1:5599/mcp");
        expect(allowedMcpEndpoint("https://api.perafly.com", "https://mcp.perafly.com")).toBe(true);
        expect(allowedMcpEndpoint("https://api.perafly.com", "https://api.perafly.com/mcp")).toBe(true);
        expect(allowedMcpEndpoint("https://staging.perafly.com", "https://staging.perafly.com/mcp")).toBe(true);
        expect(allowedMcpEndpoint("https://api.perafly.com", "http://localhost:5599/mcp")).toBe(true);
        expect(allowedMcpEndpoint("https://api.perafly.com", "https://evil.example/mcp")).toBe(false);
        expect(allowedMcpEndpoint("https://api.perafly.com", "http://mcp.perafly.com")).toBe(false);
        expect(allowedMcpEndpoint("https://staging.perafly.com", "https://mcp.perafly.com")).toBe(false);
        expect(allowedMcpEndpoint("https://api.perafly.com", "https://user:pw@mcp.perafly.com")).toBe(false);
    });
});

describe("ajan istemcisi kurulumu", () => {
    test("Cursor ve Codex yapılandırması birleştirilir, ikinci çalıştırmada değişmez; Claude Code `claude mcp add` ve beceri", async () => {
        await mkdir(join(home, ".cursor"), { recursive: true });
        await writeFile(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
        await mkdir(join(home, ".codex"), { recursive: true });
        await writeFile(join(home, ".codex", "config.toml"), 'model = "o4"\n');
        const claudeCalls: string[][] = [];
        const runClaude = async (args: string[]) => {
            claudeCalls.push(args);
            return { code: args[1] === "get" ? 1 : 0, stdout: "" };
        };
        const opts = { agents: ["claude-code", "cursor", "codex"] as const, connection: "local" as const, scope: "user" as const, cwd: dir, mcpUrl: "https://mcp.perafly.com", home, runClaude };
        const steps = await install({ ...opts, agents: [...opts.agents] });
        expect(steps.filter((s) => s.item === "mcp").map((s) => s.action)).toEqual(["written", "written", "written"]);
        expect(claudeCalls.find((a) => a[1] === "add")).toEqual(["mcp", "add", "--scope", "user", "perafly", "--", "perafly", "mcp"]);
        const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
        expect(cursor.mcpServers).toEqual({ other: { command: "x" }, perafly: { command: "perafly", args: ["mcp"] } });
        const toml = await readFile(join(home, ".codex", "config.toml"), "utf8");
        expect(toml).toContain('model = "o4"');
        expect(toml).toContain('[mcp_servers.perafly]\ncommand = "perafly"\nargs = ["mcp"]');
        const skill = await readFile(join(home, ".claude", "skills", "perafly", "SKILL.md"), "utf8");
        expect(skill).toContain("name: perafly");
        const again = await install({ ...opts, agents: ["cursor", "codex"], skipSkill: true });
        expect(again.map((s) => s.action)).toEqual(["unchanged", "unchanged"]);
        // Değiştirilmiş becerinin üzerine --force olmadan yazılmaz
        await writeFile(join(home, ".claude", "skills", "perafly", "SKILL.md"), "mine");
        const protectedRun = await install({ ...opts, agents: ["claude-code"], skipMcp: true });
        expect(protectedRun[0]!.action).toBe("skipped");
        expect(serverSpec("oauth", "https://mcp.perafly.com")).toEqual({ url: "https://mcp.perafly.com" });
        expect(serverSpec("remote", "x")).toEqual({ command: "perafly", args: ["mcp", "proxy"] });
    });

    test("Claude Code eklentisindeki beceri paketin becerisiyle aynı", async () => {
        const root = join(__dirname, "..");
        expect(await readFile(join(root, "plugins", "claude-code", "skills", "perafly", "SKILL.md"), "utf8")).toBe(await readFile(join(root, "skills", "perafly", "SKILL.md"), "utf8"));
    });
});
