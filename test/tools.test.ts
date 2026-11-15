/**
 * Faz 11 yardımcıları, sahte fetch ile (gerçek ağ ve anahtar zinciri yok): `api` (yol doğrulaması, gövde, DELETE onayı,
 * karartma), `doctor` (anahtar hiçbir çıktıda yok; FAIL çıkış 1), `inspect`, `docs`, `publish --access`, `agent
 * --session/--detach/--new`, yerel MCP'de `lookupUrl` ve `searchDocs`.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { saveCredential, setKeyringLoaderForTests } from "../src/auth/store.js";
import { apiMethod, apiPath } from "../src/commands/api.js";
import { systemLang } from "../src/commands/docs.js";
import { OPERATION_PERMISSION, operationSpecs } from "../src/mcp/tools.js";

const API = "https://api.perafly.test";
const KEY = `pfa_${"A1b2C3d4".repeat(4)}`;
const OTHER_KEY = `pfa_${"Z9y8X7w6".repeat(4)}`;
const PRJ = "prj_abcdefghjkmnpqrstvwxyz01";
const VER = "ver_abcdefghjkmnpqrstvwxyz01";
const AGS = "ags_abcdefghjkmnpqrstvwxyz01";

class Sink extends Writable {
    text = "";
    isTTY = false;
    override _write(chunk: any, _enc: string, cb: () => void) {
        this.text += chunk.toString();
        cb();
    }
}

interface Call { method: string; path: string; auth: string | null; body: any }
type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };
type Handler = (c: Call) => Reply | undefined;

let home: string;
let dir: string;
const savedHome = process.env.PERAFLY_HOME;
let calls: Call[];

const fakeFetch = (handler: Handler) => (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const headers = init.headers ?? {};
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call: Call = { method: init.method ?? "GET", path: url.pathname + url.search, auth: headers.Authorization ?? null, body };
    calls.push(call);
    const r = handler(call);
    if (!r) return new Response(JSON.stringify({ type: "about:blank", title: "Not found", status: 404, code: "not_found", detail: "Not found" }), { status: 404, headers: { "Content-Type": "application/problem+json", "X-Request-Id": "req_test" } });
    const payload = r.status === 204 ? null : r.text ?? JSON.stringify(r.json ?? {});
    return new Response(payload, { status: r.status, headers: { "Content-Type": r.status >= 400 ? "application/problem+json" : "application/json", "X-Request-Id": "req_test", ...(r.headers ?? {}) } });
}) as typeof fetch;

const failingFetch = (async (input: any, init: any = {}) => {
    calls.push({ method: init.method ?? "GET", path: new URL(String(input)).pathname, auth: init.headers?.Authorization ?? null, body: null });
    throw new TypeError("fetch failed");
}) as typeof fetch;

const cli = async (argv: string[], handler: Handler, env: Record<string, string> = {}, stdinText?: string, fetchImpl?: typeof fetch) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const stdin = (stdinText !== undefined ? Object.assign(Readable.from([Buffer.from(stdinText)]), { isTTY: false }) : Object.assign(new Sink(), { isTTY: false })) as any;
    const f = fetchImpl ?? fakeFetch(handler);
    const code = await run(argv, { env: { PERAFLY_HOME: home, PERAFLY_API_URL: API, PERAFLY_CREDENTIAL_STORE: "plaintext", HOME: home, PATH: "", ...env }, fetch: f, sleep: async () => undefined, stdout, stderr, stdin });
    const parse = (text: string) => {
        try {
            return JSON.parse(text.trim().split("\n").pop()!);
        } catch {
            return null;
        }
    };
    return { code, stdout: stdout.text, stderr: stderr.text, json: parse(stdout.text), err: parse(stderr.text) };
};

const project = (over: Record<string, unknown> = {}) => ({ id: PRJ, name: "my-site", title: null, teamId: "tm_1", urls: { live: "https://my-site.perafly.app" }, liveVersion: { id: VER, number: 5 }, latestVersion: null, publishRule: "auto", versionCount: 5, anonymous: null, takenDown: false, ...over });
const link = async (projectId = PRJ) => {
    await mkdir(join(dir, ".perafly"), { recursive: true });
    await writeFile(join(dir, ".perafly", "project.json"), JSON.stringify({ projectId, projectName: "my-site", teamId: "tm_1", apiUrl: API }));
};

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pf-home-"));
    process.env.PERAFLY_HOME = home;
    dir = await mkdtemp(join(tmpdir(), "pf-site-"));
    await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
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

describe("api: yol doğrulaması", () => {
    test("/v1 öneki eklenir; sorgu korunur", () => {
        expect(apiPath("/v1/projects")).toBe("/v1/projects");
        expect(apiPath("/projects")).toBe("/v1/projects");
        expect(apiPath("projects?q=site&limit=2")).toBe("/v1/projects?q=site&limit=2");
        expect(apiPath("/v1")).toBe("/v1");
        expect(apiPath("/v1x")).toBe("/v1/v1x");
        expect(apiPath("/me", API)).toBe("/v1/me");
        expect(apiPath("/me", "http://localhost:3000/base")).toBe("/v1/me");
    });
    test("mutlak adres, başka ana bilgisayar ve yoldan kaçış reddedilir", () => {
        for (const bad of [
            "https://evil.example/v1/me", `${API}/v1/me`, "http://localhost/v1/me", "//evil.example/v1/me", "evil.example:443/v1/me",
            "/\\evil.example/v1/me", "\\\\evil.example", "/v1/../admin", "/v1/%2e%2e/admin", "/v1/./me", "/v1/me#x", "/v1/a b", "", "  ", "javascript:alert(1)", "mailto:a@b.c"
        ]) {
            expect(() => apiPath(bad, API), bad).toThrow(expect.objectContaining({ code: "validation_error", exitCode: 2 }));
        }
    });
    test("yöntem", () => {
        expect(apiMethod("get")).toBe("GET");
        expect(apiMethod("Delete")).toBe("DELETE");
        expect(() => apiMethod("TRACE")).toThrow(expect.objectContaining({ code: "validation_error" }));
    });
});

describe("api: istek ve çıktı", () => {
    test("kimlik ve /v1 öneki; gövde güzel biçimli, --json tek satır; sır alanı karartılır", async () => {
        const handler: Handler = (c) => (c.path === "/v1/projects?q=site" ? { status: 200, json: { data: [{ id: PRJ, name: "my-site" }], nextCursor: null, token: OTHER_KEY } } : undefined);
        const human = await cli(["api", "GET", "/projects?q=site"], handler, { PERAFLY_TOKEN: KEY });
        expect(human.code).toBe(0);
        expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/projects?q=site", auth: `Bearer ${KEY}` });
        expect(human.stdout).toContain('\n  "data": [');
        expect(human.stdout).toContain(PRJ);
        const json = await cli(["api", "get", "/v1/projects?q=site", "--json"], handler, { PERAFLY_TOKEN: KEY });
        expect(json.stdout.trim().split("\n")).toHaveLength(1);
        expect(json.json.data[0].id).toBe(PRJ);
        expect(json.json.token).toBe("[redacted]");
        for (const r of [human, json]) expect(r.stdout + r.stderr).not.toMatch(/pfa_[A-Za-z0-9]{32}/);
    });
    test("mutlak adres ve GET gövdesi ağa gitmez", async () => {
        expect((await cli(["api", "GET", "https://evil.example/v1/me"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect((await cli(["api", "GET", "//evil.example/me"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect((await cli(["api", "GET", "/me", "--data", "{}"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect((await cli(["api", "POST", "/projects", "--data", "{oops"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect(calls).toHaveLength(0);
    });
    test("gövde: satır içi, @dosya, stdin; .perafly/ içindeki dosya gönderilmez", async () => {
        const ok: Handler = (c) => (c.method === "PATCH" || c.method === "POST" ? { status: 200, json: project() } : undefined);
        expect((await cli(["api", "PATCH", "/projects/my-site", "--data", '{"title":"My site"}'], ok, { PERAFLY_TOKEN: KEY })).code).toBe(0);
        expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/v1/projects/my-site", body: { title: "My site" } });
        await writeFile(join(dir, "body.json"), '{"name":"from-file"}');
        expect((await cli(["api", "POST", "/projects", "--data", "@body.json", "--cwd", dir], ok, { PERAFLY_TOKEN: KEY })).code).toBe(0);
        expect(calls.at(-1)!.body).toEqual({ name: "from-file" });
        expect((await cli(["api", "POST", "/projects", "--data", "-"], ok, { PERAFLY_TOKEN: KEY }, '{"name":"from-stdin"}')).code).toBe(0);
        expect(calls.at(-1)!.body).toEqual({ name: "from-stdin" });
        await link();
        const n = calls.length;
        const blocked = await cli(["api", "POST", "/projects", "--data", "@.perafly/project.json", "--cwd", dir, "--json"], ok, { PERAFLY_TOKEN: KEY });
        expect([blocked.code, blocked.err.error.code]).toEqual([2, "validation_error"]);
        expect(calls).toHaveLength(n);
    });
    test("2xx dışı: stdout boş, hata nesnesi stderr'de, çıkış kodu durumdan; ek problem alanları details'te", async () => {
        const r = await cli(["api", "POST", "/projects", "--data", '{"name":"x"}', "--json"], () => ({ status: 400, json: { type: "about:blank", title: "Invalid", status: 400, code: "validation_error", detail: "name is invalid", errors: [{ field: "name", code: "too_short" }] } }), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.err.error).toMatchObject({ code: "validation_error", status: 400, requestId: "req_test", details: { errors: [{ field: "name", code: "too_short" }] } });
        const missing = await cli(["api", "GET", "/projects/nope"], () => undefined, { PERAFLY_TOKEN: KEY });
        expect(missing.code).toBe(20);
        expect(missing.stdout).toBe("");
        expect(missing.stderr).toContain("Not found");
    });
    test("DELETE etkileşimsiz kipte --yes ister (ajan kipi onay değildir); --yes ile gider", async () => {
        const del: Handler = (c) => (c.method === "DELETE" ? { status: 204 } : undefined);
        const agent = await cli(["api", "DELETE", "/projects/my-site/versions/v1"], del, { PERAFLY_TOKEN: KEY, PERAFLY_AGENT: "1" });
        expect([agent.code, agent.err.error.code]).toEqual([2, "confirmation_required"]);
        expect(calls).toHaveLength(0);
        const yes = await cli(["api", "DELETE", "/projects/my-site/versions/v1", "--yes"], del, { PERAFLY_TOKEN: KEY });
        expect(yes.code).toBe(0);
        expect(calls[0]).toMatchObject({ method: "DELETE", path: "/v1/projects/my-site/versions/v1" });
    });
    test("--include: durum ve başlıklar stderr'e, belirteç ve çerez karartılır", async () => {
        const r = await cli(["api", "GET", "/me", "--include"], () => ({ status: 200, json: { ok: true }, headers: { "X-Debug": `key=${OTHER_KEY}`, "Set-Cookie": "sid=abc123" } }), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.stderr).toContain("HTTP 200");
        expect(r.stderr).toContain("x-debug: key=[redacted]");
        expect(r.stderr).toContain("set-cookie: [redacted]");
        expect(r.stdout + r.stderr).not.toContain(OTHER_KEY);
        expect(r.stdout + r.stderr).not.toContain("abc123");
    });
    test("kimlik yoksa kimliksiz gider", async () => {
        const r = await cli(["api", "GET", "/plans"], (c) => (c.path === "/v1/plans" ? { status: 200, json: { data: [] } } : undefined));
        expect(r.code).toBe(0);
        expect(calls[0]!.auth).toBeNull();
    });
});

describe("doctor", () => {
    const me = { kind: "apiKey", team: { id: "tm_1", name: "Acme" }, key: { id: "key_1", name: "cli", prefix: KEY.slice(0, 8), kind: "cli", access: "full" }, user: { id: "u1", name: "Ada", email: "ada@example.com" }, project: null, role: "owner", permissions: ["projects.read"] };
    const healthy: Handler = (c) => {
        if (c.path === "/v1/plans") return { status: 200, json: { data: [{ code: "free" }] } };
        if (c.path === "/v1/me") return { status: 200, json: me };
        if (c.path === `/v1/projects/${PRJ}`) return { status: 200, json: project() };
        return undefined;
    };
    const allText = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

    test("PERAFLY_TOKEN: geçerli; anahtar hiçbir çıktıda yok; plans kimliksiz, me kimlikli", async () => {
        await link();
        const human = await cli(["doctor", "--cwd", dir], healthy, { PERAFLY_TOKEN: KEY });
        expect(human.code).toBe(0);
        expect(human.stdout).toMatch(/OK\s+Node\.js/);
        expect(human.stdout).toContain(`${API} reachable`);
        expect(human.stdout).toContain("PERAFLY_TOKEN (environment variable)");
        expect(human.stdout).toContain("valid: Ada <ada@example.com>, team Acme, full access");
        expect(human.stdout).toContain("my-site");
        expect(human.stdout).toContain("All checks passed.");
        expect(calls.find((c) => c.path === "/v1/plans")!.auth).toBeNull();
        expect(calls.find((c) => c.path === "/v1/me")!.auth).toBe(`Bearer ${KEY}`);
        const json = await cli(["doctor", "--cwd", dir, "--json"], healthy, { PERAFLY_TOKEN: KEY });
        expect(json.code).toBe(0);
        expect(json.json.data.ok).toBe(true);
        expect(json.json.data.checks.map((c: any) => c.id)).toEqual(["node", "cli", "api", "profile", "store", "signin", "project", "config", "git", "agents"]);
        for (const r of [human, json]) {
            expect(allText(r)).not.toContain(KEY);
            expect(allText(r)).not.toContain(KEY.slice(4));
        }
    });

    test("kayıtlı düz dosya: tür ve izin; geniş izin uyarı olur ve daraltılır; anahtar yine görünmez", async () => {
        await saveCredential("default", { token: KEY, apiUrl: API, access: "full", team: { id: "tm_1", name: "Acme" }, user: { id: "u1", name: "Ada" }, createdAt: "2026-11-01T00:00:00Z" });
        const file = join(home, "credentials", "default.json");
        const ok = await cli(["doctor", "--cwd", dir, "--json"], healthy);
        const store = ok.json.data.checks.find((c: any) => c.id === "store");
        expect(store.status).toBe("ok");
        expect(store.message).toContain("(0600)");
        if (process.platform !== "win32") {
            await chmod(file, 0o644);
            const wide = await cli(["doctor", "--cwd", dir], healthy);
            expect(wide.code).toBe(0);
            expect(wide.stdout).toMatch(/WARN\s+Credential store/);
            expect(wide.stdout).toContain("was readable by others (0644)");
            expect(allText(wide)).not.toContain(KEY);
        }
        expect(allText(ok)).not.toContain(KEY);
    });

    test("API'ye ulaşılamazsa FAIL ve çıkış 1 (doctor_check_failed); rapor yine yazılır, anahtar yok", async () => {
        const r = await cli(["doctor", "--cwd", dir, "--json"], () => undefined, { PERAFLY_TOKEN: KEY }, undefined, failingFetch);
        expect(r.code).toBe(1);
        expect(r.json.data.ok).toBe(false);
        expect(r.json.data.checks.find((c: any) => c.id === "api").status).toBe("fail");
        expect(r.json.data.checks.find((c: any) => c.id === "signin").status).toBe("warn");
        expect(r.err.error.code).toBe("doctor_check_failed");
        expect(allText(r)).not.toContain(KEY);
        // /v1/me ağ düşükken denenmez
        expect(calls.every((c) => c.path === "/v1/plans")).toBe(true);
    });

    test("reddedilen anahtar, bozuk perafly.jsonc ve görünmeyen bağlı proje FAIL", async () => {
        await link();
        await writeFile(join(dir, "perafly.jsonc"), '{ "nope": 1 }');
        const r = await cli(["doctor", "--cwd", dir], (c) => (c.path === "/v1/plans" ? { status: 200, json: { data: [] } } : c.path === "/v1/me" ? { status: 401, json: { status: 401, code: "unauthorized", title: "Unauthorized" } } : undefined), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(1);
        expect(r.stdout).toMatch(/FAIL\s+Sign-in/);
        expect(r.stdout).toMatch(/FAIL\s+perafly\.jsonc/);
        expect(r.stdout).toContain("→ perafly login");
        expect(allText(r)).not.toContain(KEY);
        const gone = await cli(["doctor", "--cwd", dir, "--json"], (c) => (c.path === `/v1/projects/${PRJ}` ? undefined : healthy(c)), { PERAFLY_TOKEN: KEY });
        expect(gone.json.data.checks.find((c: any) => c.id === "project").status).toBe("fail");
    });

    test("bozuk .perafly/project.json: rapor yazılır, Settings FAIL", async () => {
        await mkdir(join(dir, ".perafly"), { recursive: true });
        await writeFile(join(dir, ".perafly", "project.json"), "{ bad");
        const r = await cli(["doctor", "--cwd", dir, "--json"], healthy, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(1);
        expect(r.json.data.checks.map((c: any) => [c.id, c.status])).toEqual([["node", "ok"], ["cli", "ok"], ["settings", "fail"]]);
        expect(calls).toHaveLength(0);
    });

    test("giriş yoksa uyarı (çıkış 0); ajan istemcisi kurulu ama Perafly yoksa uyarı", async () => {
        await mkdir(join(home, ".cursor"), { recursive: true });
        const r = await cli(["doctor", "--cwd", dir, "--json"], healthy);
        expect(r.code).toBe(0);
        const by = Object.fromEntries(r.json.data.checks.map((c: any) => [c.id, c]));
        expect(by.signin.status).toBe("warn");
        expect(by.agents).toMatchObject({ status: "warn", hint: "perafly setup agent" });
        await writeFile(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { perafly: { command: "perafly", args: ["mcp"] } } }));
        const set = await cli(["doctor", "--cwd", dir, "--json"], healthy);
        const agents = set.json.data.checks.find((c: any) => c.id === "agents");
        // PATH boş: istemci `perafly mcp`'yi başlatamaz
        expect(agents.status).toBe("warn");
        expect(agents.message).toContain("cursor: MCP (user)");
        expect(agents.message).toContain("not on PATH");
    });
});

describe("inspect", () => {
    const lookup = { kind: "version", project: project(), version: { id: VER, number: 3, state: "ready", live: false, url: "https://my-site--v3.perafly.app" }, branch: null };
    test("adresten proje ve sürüm; --json sunucunun biçimi", async () => {
        const handler: Handler = (c) => (c.path.startsWith("/v1/lookup?") ? { status: 200, json: lookup } : undefined);
        const human = await cli(["inspect", "https://my-site--v3.perafly.app"], handler, { PERAFLY_TOKEN: KEY });
        expect(human.code).toBe(0);
        expect(calls[0]!.path).toBe(`/v1/lookup?url=${encodeURIComponent("https://my-site--v3.perafly.app")}`);
        expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
        expect(human.stdout).toMatch(/Kind\s+version URL/);
        expect(human.stdout).toMatch(/Project\s+my-site \(prj_/);
        expect(human.stdout).toMatch(/Live\s+v5\s+https:\/\/my-site\.perafly\.app/);
        expect(human.stdout).toMatch(/Version\s+v3 \(ready\)\s+https:\/\/my-site--v3\.perafly\.app/);
        const json = await cli(["inspect", "my-site--v3.perafly.app", "--json"], handler, { PERAFLY_TOKEN: KEY });
        expect(json.json.data).toEqual(lookup);
    });
    test("404 → bu kimliğin göreceği proje değil (çıkış 20); giriş yoksa ağa gitmez", async () => {
        const r = await cli(["inspect", "other.perafly.app", "--json"], () => undefined, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(20);
        expect(r.err.error.code).toBe("not_found");
        expect(r.err.error.message).toBe("other.perafly.app is not a Perafly project (or version) this sign-in can see.");
        calls = [];
        const anon = await cli(["inspect", "x.perafly.app"], () => undefined);
        expect(anon.code).toBe(10);
        expect(calls).toHaveLength(0);
    });
});

describe("docs", () => {
    const results = { data: [{ title: "Custom domains", context: "Guides", url: "https://perafly.com/tr/docs/domains", snippet: "Connect a domain and set the DNS record." }, { title: "access_change_forbidden", context: "Errors", url: "https://perafly.com/tr/docs/errors#access_change_forbidden", snippet: "The team keeps new sites private." }] };
    test("kimlik gönderilmez; dil ve sınır sorguda; başlık, bağlam, adres, alıntı", async () => {
        const handler: Handler = (c) => (c.path.startsWith("/v1/docs/search?") ? { status: 200, json: results } : undefined);
        const human = await cli(["docs", "custom", "domain", "--lang", "tr", "--limit", "3"], handler, { PERAFLY_TOKEN: KEY });
        expect(human.code).toBe(0);
        expect(calls[0]!.auth).toBeNull();
        const q = new URL(`https://x${calls[0]!.path}`).searchParams;
        expect([q.get("q"), q.get("lang"), q.get("limit")]).toEqual(["custom domain", "tr", "3"]);
        expect(human.stdout).toContain("1. Custom domains  (Guides)");
        expect(human.stdout).toContain("   https://perafly.com/tr/docs/domains");
        expect(human.stdout).toContain("   Connect a domain and set the DNS record.");
        expect(human.stdout).toContain("2. access_change_forbidden  (Errors)");
        const json = await cli(["docs", "domains", "--json"], handler, { LANG: "en_US.UTF-8" });
        expect(json.json.data).toEqual(results.data);
        expect(new URL(`https://x${calls.at(-1)!.path}`).searchParams.get("lang")).toBe("en");
    });
    test("503 anlaşılır ileti; geçersiz sınır ve boş sorgu ağa gitmez", async () => {
        const down = await cli(["docs", "domains", "--json"], () => ({ status: 503, json: { status: 503, code: "docs_unavailable", title: "Docs search is unavailable" } }));
        expect(down.code).toBe(1);
        expect(down.err.error.code).toBe("docs_unavailable");
        expect(down.err.error.message).toContain("unavailable right now");
        expect(down.err.error.message).toContain("https://perafly.com/docs");
        calls = [];
        expect((await cli(["docs", "x", "--limit", "50"], () => undefined)).code).toBe(2);
        expect((await cli(["docs", " "], () => undefined)).code).toBe(2);
        expect(calls).toHaveLength(0);
    });
    test("sistem dili", () => {
        expect(systemLang({ LANG: "tr_TR.UTF-8" })).toBe("tr");
        expect(systemLang({ LC_ALL: "en_GB.UTF-8", LANG: "tr_TR.UTF-8" })).toBe("en");
        expect(systemLang({ LANGUAGE: "tr:en" })).toBe("tr");
        expect(systemLang({ LANG: "C" })).toBe("en");
        expect(systemLang({ LANG: "trk" })).toBe("en");
    });
});

describe("publish --access", () => {
    test("bağlı klasörde ve --project ile istemcide reddedilir (ağa gidilmez)", async () => {
        await link();
        const linked = await cli(["publish", ".", "--cwd", dir, "--access", "public", "--json"], () => undefined, { PERAFLY_TOKEN: KEY });
        expect([linked.code, linked.err.error.code]).toEqual([2, "validation_error"]);
        expect(linked.err.error.message).toContain("only when publishing creates a new project");
        await rm(join(dir, ".perafly"), { recursive: true, force: true });
        const flag = await cli(["publish", ".", "--cwd", dir, "--project", "my-site", "--access", "private"], () => undefined, { PERAFLY_TOKEN: KEY });
        expect(flag.code).toBe(2);
        expect(flag.stderr).toContain("only when publishing creates a new project");
        const anon = await cli(["publish", ".", "--cwd", dir, "--access", "private"], () => undefined);
        expect(anon.code).toBe(2);
        expect(anon.stderr).toContain("needs a sign-in");
        expect((await cli(["publish", ".", "--cwd", dir, "--access", "secret"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect(calls).toHaveLength(0);
    });
    test("yeni projede gövdeye girer; 403 access_change_forbidden yol gösterir (çıkış 10)", async () => {
        const forbidden = await cli(["publish", ".", "--cwd", dir, "--access", "public", "--json"], (c) => {
            if (c.method === "POST" && c.path === "/v1/publish") {
                expect(c.body.access).toBe("public");
                expect(c.body.project).toBeUndefined();
                return { status: 403, json: { type: "https://perafly.com/docs/errors/access_change_forbidden", title: "This credential can't make the site public", status: 403, code: "access_change_forbidden", detail: "The team keeps new sites private." } };
            }
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(forbidden.code).toBe(10);
        expect(forbidden.err.error.code).toBe("access_change_forbidden");
        expect(forbidden.err.error.message).toContain("Publish it private");
        expect(forbidden.err.error.message).toContain("change its access in Perafly");
        expect(forbidden.err.error.recovery).toBe("perafly publish --access private");
        const dry = await cli(["publish", ".", "--cwd", dir, "--access", "private", "--dry-run", "--json"], () => undefined, { PERAFLY_TOKEN: KEY });
        expect(dry.code).toBe(0);
    });
});

describe("agent --session, --detach, --new", () => {
    const session = (over: Record<string, unknown> = {}) => ({ id: AGS, title: "Bakery", status: "idle", project: { id: PRJ, name: "sunny-bakery" }, budget: { cents: 500, chargedCents: 120 }, pending: [], previews: [], ...over });
    test("--detach: yeni oturum açılır, kimlik yazılır, izlenmez (--no-wait ile aynı)", async () => {
        const r = await cli(["agent", "A", "bakery", "site", "--detach"], (c) => (c.method === "POST" && c.path === "/v1/agent/sessions" ? { status: 201, json: session({ status: "running" }) } : undefined), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(AGS);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/agent/sessions"]);
        expect(calls[0]!.body).toEqual({ prompt: "A bakery site" });
        calls = [];
        await cli(["agent", "A site", "--new", "--no-wait", "--project", "my-site"], () => ({ status: 201, json: session({ status: "running" }) }), { PERAFLY_TOKEN: KEY });
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/agent/sessions"]);
        // `--project` genel bayrakla çakışır; yine de oturumun projesi olur
        expect(calls[0]!.body).toEqual({ prompt: "A site", project: "my-site" });
    });
    test("--session: ileti var olan oturuma gider; --detach ile izlenmez, yoksa izlenir; iletisiz izler", async () => {
        const detached = await cli(["agent", "--session", AGS, "Make", "the", "header", "blue", "--detach", "--json"], (c) => (c.method === "POST" ? { status: 200, json: session({ status: "running" }) } : undefined), { PERAFLY_TOKEN: KEY });
        expect(detached.code).toBe(0);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /v1/agent/sessions/${AGS}/messages`]);
        expect(calls[0]!.body).toEqual({ text: "Make the header blue" });
        expect(detached.json.data.id).toBe(AGS);
        calls = [];
        let polls = 0;
        const followed = await cli(["agent", "Add", "prices", "--session", AGS], (c) => {
            if (c.path.includes("/events")) return { status: 200, json: { data: [], nextAfter: 7 } };
            if (c.method === "POST") return { status: 200, json: session({ status: "running" }) };
            return { status: 200, json: ++polls < 2 ? session({ status: "running" }) : session() };
        }, { PERAFLY_TOKEN: KEY });
        expect(followed.code).toBe(0);
        expect(calls.find((c) => c.method === "POST")!.body).toEqual({ text: "Add prices" });
        expect(calls.some((c) => c.path === `/v1/agent/sessions/${AGS}/events?after=7&limit=200`)).toBe(true);
        calls = [];
        await cli(["agent", "--session", AGS], (c) => (c.path.includes("/events") ? { status: 200, json: { data: [], nextAfter: 0 } } : { status: 200, json: session() }), { PERAFLY_TOKEN: KEY });
        expect(calls.every((c) => c.method === "GET")).toBe(true);
        expect(calls.some((c) => c.path === `/v1/agent/sessions/${AGS}`)).toBe(true);
    });
    test("tarif stdin'den (-)", async () => {
        await cli(["agent", "-", "--detach"], () => ({ status: 201, json: session({ status: "running" }) }), { PERAFLY_TOKEN: KEY }, "A one-page site\n");
        expect(calls[0]!.body).toEqual({ prompt: "A one-page site" });
    });
    test("çelişen bayraklar ve geçersiz oturum ağa gitmez", async () => {
        for (const argv of [
            ["agent", "--session", AGS, "--new", "x"],
            ["agent", "--session", AGS, "--budget", "5", "x"],
            ["agent", "--session", AGS, "--project", "my-site", "x"],
            ["agent", "--session", "ags_bad", "x"],
            ["agent", "--session", AGS, "--detach"]
        ]) {
            expect([argv.join(" "), (await cli(argv, () => undefined, { PERAFLY_TOKEN: KEY })).code]).toEqual([argv.join(" "), 2]);
        }
        expect(calls).toHaveLength(0);
    });
});

describe("yerel MCP: lookupUrl ve searchDocs", () => {
    test("barındırılan MCP ile aynı izinler; sorgu parametreleri araç girdisi", () => {
        expect(OPERATION_PERMISSION.lookupUrl).toBe("projects.read");
        expect(OPERATION_PERMISSION.searchDocs).toBeNull();
        expect(OPERATION_PERMISSION.listPlans).toBeNull();
        const specs = Object.fromEntries(operationSpecs().map((s) => [s.operationId, s]));
        expect(specs.lookupUrl).toMatchObject({ method: "GET", path: "/v1/lookup", queryParams: ["url"], schema: { required: ["url"] } });
        expect(specs.searchDocs).toMatchObject({ method: "GET", path: "/v1/docs/search", queryParams: ["q", "lang", "limit"], schema: { required: ["q"] } });
    });
});
