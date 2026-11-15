/**
 * Komutlar uçtan uca, sahte fetch ile (gerçek ağ ve anahtar zinciri yok): çıktı zarfı ve karartma, çıkış kodları, ajan
 * kipi ve `--yes`, hesapsız yayın (anahtar yüklemeden önce saklanır, çıktıda görünmez), takım yayını ve bağlantı,
 * bekleme ve zaman aşımı, giriş, sahiplenme, `perafly.jsonc` doğrulaması, komut ↔ OpenAPI eşlemesi.
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { setKeyringLoaderForTests } from "../src/auth/store.js";
import { COMMAND_OPERATIONS, UNMAPPED_OPERATIONS } from "../src/commands/operations-map.js";
import { parsePeraflyConfig, stripJsonc } from "../src/config/jsonc.js";
import openapi from "../src/api/openapi.json" with { type: "json" };

const API = "https://api.perafly.test";
const PKEY = `pfc_${"P1q2R3s4".repeat(4)}`;
const KEY = `pfa_${"A1b2C3d4".repeat(4)}`;
const PRJ = "prj_abcdefghjkmnpqrstvwxyz01";
const VER = "ver_abcdefghjkmnpqrstvwxyz01";
const OPR = "opr_abcdefghjkmnpqrstvwxyz01";

class Sink extends Writable {
    text = "";
    isTTY = false;
    override _write(chunk: any, _enc: string, cb: () => void) {
        this.text += chunk.toString();
        cb();
    }
}

interface Call { method: string; path: string; auth: string | null; body: any; at: number }
type Handler = (c: Call) => { status: number; json?: unknown } | undefined;

let home: string;
let dir: string;
const savedHome = process.env.PERAFLY_HOME;
let calls: Call[];
let tick = 0;

const fakeFetch = (handler: Handler) => (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const headers = init.headers ?? {};
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call: Call = { method: init.method ?? "GET", path: url.pathname + url.search, auth: headers.Authorization ?? null, body, at: tick++ };
    calls.push(call);
    const r = handler(call);
    if (!r) return new Response(JSON.stringify({ type: "about:blank", title: "Not found", status: 404, code: "not_found" }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status, headers: { "Content-Type": r.status >= 400 ? "application/problem+json" : "application/json", "X-Request-Id": "req_test" } });
}) as typeof fetch;

const cli = async (argv: string[], handler: Handler, env: Record<string, string> = {}) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const stdin = Object.assign(new Sink(), { isTTY: false }) as any;
    const code = await run(argv, { env: { PERAFLY_HOME: home, PERAFLY_API_URL: API, PERAFLY_CREDENTIAL_STORE: "plaintext", ...env }, fetch: fakeFetch(handler), sleep: async () => undefined, stdout, stderr, stdin });
    const parse = (text: string) => {
        try {
            return JSON.parse(text.trim().split("\n").pop()!);
        } catch {
            return null;
        }
    };
    expect(process.env.PERAFLY_HOME).toBe(home);
    return { code, stdout: stdout.text, stderr: stderr.text, json: parse(stdout.text), err: parse(stderr.text) };
};

const project = (over: Record<string, unknown> = {}) => ({ id: PRJ, name: "brave-otter-1234", title: null, teamId: null, urls: { live: "https://brave-otter-1234.perafly.app" }, liveVersion: null, latestVersion: null, publishRule: "auto", versionCount: 1, anonymous: { expiresAt: "2026-11-15T10:00:00Z", claimDeadline: "2026-11-22T10:00:00Z", expired: false }, takenDown: false, ...over });
const version = (over: Record<string, unknown> = {}) => ({ id: VER, projectId: PRJ, number: 1, state: "ready", target: "live", url: "https://brave-otter-1234--v1.perafly.app", live: true, ...over });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pf-home-"));
    // Kimlik deposu ve yapılandırma süreç ortamından okunur: gerçek ~/.perafly'a asla yazılmasın
    process.env.PERAFLY_HOME = home;
    dir = await mkdtemp(join(tmpdir(), "pf-site-"));
    await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
    await writeFile(join(dir, "style.css"), "h1{}");
    await writeFile(join(dir, ".env"), "SECRET=1");
    calls = [];
    tick = 0;
    setKeyringLoaderForTests(async () => null);
});
afterEach(async () => {
    if (savedHome === undefined) delete process.env.PERAFLY_HOME;
    else process.env.PERAFLY_HOME = savedHome;
    setKeyringLoaderForTests(null);
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
});

describe("hesapsız yayın", () => {
    test("anahtar yüklemeden önce state.json'a yazılır; --json çıktısında anahtar ve sahiplenme bağlantısı yok", async () => {
        let stateAtUpload: string | null = null;
        const r = await cli(["publish", ".", "--cwd", dir, "--json"], (c) => {
            if (c.method === "POST" && c.path === "/v1/publish") {
                expect(c.auth).toBeNull();
                expect(c.body.files.map((f: any) => f.path).sort()).toEqual(["index.html", "style.css"]);
                expect(c.body.source).toBe("cli");
                return { status: 201, json: { project: project(), version: version({ state: "uploading", number: null, live: false }), uploads: [{ sha256: c.body.files[0].sha256, size: c.body.files[0].size, url: `${API}/v1/uploads/tok.sig`, method: "PUT" }], finalizeUrl: `/v1/versions/${VER}/finalize`, projectKey: PKEY, claimUrl: `https://perafly.com/claim#${PRJ}.${PKEY}`, expiresAt: "2026-11-15T10:00:00Z", claimDeadline: "2026-11-22T10:00:00Z" } };
            }
            if (c.method === "PUT" && c.path.startsWith("/v1/uploads/")) {
                stateAtUpload = "pending";
                return { status: 204 };
            }
            if (c.method === "POST" && c.path.startsWith(`/v1/versions/${VER}/finalize`)) {
                expect(c.auth).toBe(`Bearer ${PKEY}`);
                return { status: 200, json: { project: project({ liveVersion: { id: VER, number: 1 } }), version: version() } };
            }
            return undefined;
        });
        expect(r.code).toBe(0);
        expect(stateAtUpload).toBe("pending");
        const state = JSON.parse(await readFile(join(dir, ".perafly", "state.json"), "utf8"));
        expect(state.anonymous.projectKey).toBe(PKEY);
        expect((await stat(join(dir, ".perafly", "state.json"))).mode & 0o777).toBe(0o600);
        expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".perafly/state.json");
        expect(r.stdout).not.toContain(PKEY);
        expect(r.stdout).not.toContain("/claim#");
        expect(r.json.data.claim).toEqual({ expiresAt: "2026-11-15T10:00:00Z", claimDeadline: "2026-11-22T10:00:00Z", command: "perafly projects claim" });
        expect(r.json.data.files).toMatchObject({ total: 2, ignored: 1 });
        // sonraki yayın aynı projeye proje anahtarıyla gider
        calls = [];
        const again = await cli(["publish", ".", "--cwd", dir, "--json"], (c) => {
            if (c.method === "POST" && c.path === "/v1/publish") {
                expect(c.auth).toBe(`Bearer ${PKEY}`);
                expect(c.body.project).toBe(PRJ);
                return { status: 200, json: { noop: true, project: project(), version: version(), uploads: [] } };
            }
            return undefined;
        });
        expect(again.code).toBe(0);
        expect(again.json.data.noop).toBe(true);
    });

    test("insan çıktısı sahiplenme bağlantısını gösterir (bilerek); stderr'de anahtar yok", async () => {
        const r = await cli(["publish", dir, "--cwd", dir], (c) => {
            if (c.path === "/v1/publish") return { status: 201, json: { project: project(), version: version({ state: "uploading" }), uploads: [], projectKey: PKEY, claimUrl: `https://perafly.com/claim#${PRJ}.${PKEY}`, expiresAt: "x", claimDeadline: "y" } };
            if (c.path.startsWith("/v1/versions/")) return { status: 200, json: { project: project(), version: version() } };
            return undefined;
        });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("Published: https://brave-otter-1234.perafly.app");
        expect(r.stdout).toContain(`Claim URL    https://perafly.com/claim#${PRJ}.${PKEY}`);
        expect(r.stderr).not.toContain(PKEY);
    });

    test("hesapsız yayında yasak dosya yerelde durur (ağa gidilmez); önizleme ve ad hesap ister", async () => {
        await writeFile(join(dir, "server.php"), "<?php");
        const r = await cli(["publish", dir, "--cwd", dir, "--json"], () => undefined);
        expect(r.code).toBe(2);
        expect(r.err.error.code).toBe("path_blocked");
        expect(calls).toHaveLength(0);
        const preview = await cli(["publish", dir, "--cwd", dir, "--json", "--target", "preview"], () => undefined);
        expect(preview.err.error.code).toBe("validation_error");
        const named = await cli(["publish", dir, "--cwd", dir, "--json", "--name", "my-site"], () => undefined);
        expect(named.err.error.code).toBe("validation_error");
    });
});

describe("takım yayını", () => {
    test("PERAFLY_TOKEN ile yeni proje; 202 → işlem yoklanır; project.json yazılır", async () => {
        const team = project({ teamId: "team1", anonymous: null, name: "my-site" });
        const r = await cli(["publish", dir, "--cwd", dir, "--json", "--name", "my-site", "-m", "first"], (c) => {
            if (c.path === "/v1/publish") {
                expect(c.auth).toBe(`Bearer ${KEY}`);
                expect(c.body).toMatchObject({ name: "my-site", note: "first", target: "live", mode: "snapshot" });
                return { status: 201, json: { project: team, version: version({ state: "uploading" }), uploads: [] } };
            }
            if (c.path.startsWith(`/v1/versions/${VER}/finalize`)) return { status: 202, json: { project: team, version: version({ state: "building", live: false }), operation: { id: OPR, status: "running" } } };
            if (c.path === `/v1/operations/${OPR}`) return { status: 200, json: { id: OPR, status: calls.filter((x) => x.path === c.path).length > 1 ? "succeeded" : "running" } };
            if (c.path === `/v1/projects/${PRJ}/versions/${VER}`) return { status: 200, json: version() };
            if (c.path === `/v1/projects/${PRJ}`) return { status: 200, json: team };
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.json.data.version.state).toBe("ready");
        expect(calls.filter((c) => c.path === `/v1/operations/${OPR}`)).toHaveLength(2);
        expect(JSON.parse(await readFile(join(dir, ".perafly", "project.json"), "utf8"))).toMatchObject({ projectId: PRJ, teamId: "team1", apiUrl: API });
        expect(calls.find((c) => c.path === "/v1/publish")!.method).toBe("POST");
    });

    test("bekleme süresi aşılırsa çıkış 50 ve işlem kimliği recovery'de", async () => {
        const r = await cli(["publish", dir, "--cwd", dir, "--json", "--wait-timeout", "1"], (c) => {
            if (c.path === "/v1/publish") return { status: 201, json: { project: project({ anonymous: null }), version: version({ state: "uploading" }), uploads: [] } };
            if (c.path.startsWith("/v1/versions/")) return { status: 202, json: { project: project(), version: version({ state: "building" }), operation: { id: OPR, status: "running" } } };
            if (c.path === `/v1/operations/${OPR}`) {
                const until = Date.now() + 1100;
                while (Date.now() < until) { /* yoklama süresini aşmak için bekle */ }
                return { status: 200, json: { id: OPR, status: "running" } };
            }
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(50);
        expect(r.err.error).toMatchObject({ code: "wait_timeout", recovery: `perafly operations wait ${OPR}` });
    });

    test("sunucu hatası RFC 9457'den taşınır: kod, istek kimliği, çıkış kodu", async () => {
        const r = await cli(["publish", dir, "--cwd", dir, "--json"], (c) => (c.path === "/v1/publish" ? { status: 403, json: { type: "https://perafly.com/problems/forbidden", title: "Not allowed", status: 403, code: "forbidden", detail: "No permission", requestId: "req_x" } } : undefined), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(10);
        expect(r.err.error).toMatchObject({ code: "forbidden", status: 403, requestId: "req_x", message: "No permission" });
        expect(r.stdout).toBe("");
    });
});

describe("onaylar ve ajan kipi", () => {
    test("ajan kipi --json'u açar ama --yes yerine geçmez: rollback confirmation_required (çıkış 2)", async () => {
        await mkdir(join(dir, ".perafly"));
        await writeFile(join(dir, ".perafly", "project.json"), JSON.stringify({ projectId: PRJ, apiUrl: API }));
        const r = await cli(["rollback", "v1", "--cwd", dir], () => ({ status: 200, json: {} }), { PERAFLY_TOKEN: KEY, PERAFLY_AGENT: "1" });
        expect(r.code).toBe(2);
        expect(r.err.error.code).toBe("confirmation_required");
        expect(calls).toHaveLength(0);
        const ok = await cli(["rollback", "v1", "--cwd", dir, "--yes"], (c) => (c.path.endsWith("/promote") ? { status: 200, json: { project: project(), version: version() } } : undefined), { PERAFLY_TOKEN: KEY, PERAFLY_AGENT: "1" });
        expect(ok.code).toBe(0);
        expect(ok.json.data.live).toBe(true);
    });

    test("anahtar argümanda verilirse komut çalışmaz", async () => {
        const r = await cli(["publish", "--json", "--project", KEY], () => undefined);
        expect(r.code).toBe(2);
        expect(r.err.error.code).toBe("validation_error");
        expect(r.stderr).not.toContain(KEY);
        expect(calls).toHaveLength(0);
    });

    test("kimlik yoksa auth_required (çıkış 10) ve recovery", async () => {
        const r = await cli(["projects", "ls", "--json"], () => undefined);
        expect(r.code).toBe(10);
        expect(r.err.error).toMatchObject({ code: "auth_required", recovery: "perafly login" });
    });
});

describe("giriş ve sahiplenme", () => {
    test("cihazla giriş: kod stderr'de, anahtar hiçbir çıktıda yok, düz dosyaya 0600 yazılır", async () => {
        let polls = 0;
        const r = await cli(["login", "--json", "--access", "agent"], (c) => {
            if (c.path === "/v1/auth/device") {
                expect(c.body.access).toBe("agent");
                return { status: 201, json: { deviceCode: "dev-code-0123456789abcdefghij", userCode: "BCDF-GHJK", verificationUri: "https://perafly.com/authorize", verificationUriComplete: "https://perafly.com/authorize?code=BCDF-GHJK", expiresIn: 600, interval: 5 } };
            }
            if (c.path === "/v1/auth/device/token") {
                if (polls++ === 0) return { status: 400, json: { code: "authorization_pending" } };
                return { status: 200, json: { token: KEY, expiresAt: "2026-12-14T00:00:00Z", access: "agent", team: { id: "t1", name: "Acme" }, user: { id: "u1", name: "Ada", email: "ada@example.com" } } };
            }
            return undefined;
        });
        expect(r.code).toBe(0);
        expect(r.stderr).toContain("BCDF-GHJK");
        expect(r.stdout + r.stderr).not.toContain(KEY);
        expect(r.json.data).toMatchObject({ profile: "default", store: "plaintext", access: "agent", team: { name: "Acme" } });
        const file = join(home, "credentials", "default.json");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(file, "utf8")).token).toBe(KEY);
        // kayıtlı giriş yalnız aynı API adresinde kullanılır
        const other = await cli(["whoami", "--json"], () => undefined, { PERAFLY_API_URL: "https://elsewhere.test" });
        expect(other.code).toBe(10);
    });

    test("sahiplenme: proje anahtarı silinir, ajan anahtarı klasörde saklanır, project.json yazılır; anahtar çıktıda yok", async () => {
        await mkdir(join(dir, ".perafly"));
        await writeFile(join(dir, ".perafly", "state.json"), JSON.stringify({ version: 1, anonymous: { projectId: PRJ, projectName: "brave-otter-1234", projectKey: PKEY, apiUrl: API, liveUrl: null, expiresAt: null, claimDeadline: null, createdAt: "x" } }));
        const agentKey = `pfa_${"Z".repeat(32)}`;
        const r = await cli(["projects", "claim", "--keep-publishing", "--cwd", dir, "--json"], (c) => {
            if (c.path === `/v1/projects/${PRJ}/claim`) {
                expect(c.auth).toBe(`Bearer ${KEY}`);
                expect(c.body).toEqual({ projectKey: PKEY, keepPublishing: true });
                return { status: 200, json: { project: project({ teamId: "t1", anonymous: null }), agentKey } };
            }
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain(agentKey);
        const state = JSON.parse(await readFile(join(dir, ".perafly", "state.json"), "utf8"));
        expect(state.anonymous).toBeUndefined();
        expect(state.projectApiKey.token).toBe(agentKey);
        expect(JSON.parse(await readFile(join(dir, ".perafly", "project.json"), "utf8"))).toMatchObject({ projectId: PRJ, teamId: "t1" });
    });
});

describe("perafly.jsonc", () => {
    test("yorumlar ve sondaki virgül kabul edilir; dizedeki // ve ,} korunur", () => {
        expect(JSON.parse(stripJsonc('{ "a": "x//y,}", // c\n /* b */ "b": [1, 2,], }'))).toEqual({ a: "x//y,}", b: [1, 2] });
    });
    test("şemaya aykırı alan validation_error ve RFC 6901 pointer", () => {
        expect(() => parsePeraflyConfig('{ "project": "x" }')).toThrowError(expect.objectContaining({ code: "validation_error", pointer: "/project" }));
        expect(() => parsePeraflyConfig('{ "redirects": [{ "source": "/a" }] }')).toThrowError(expect.objectContaining({ pointer: "/redirects/0/destination" }));
        expect(() => parsePeraflyConfig('{ "crons": [{ "path": "/x", "schedule": "* *" }] }')).toThrowError(expect.objectContaining({ pointer: "/crons/0/schedule" }));
        expect(parsePeraflyConfig('{ "$schema": "https://perafly.com/schemas/perafly.json", "access": "private" }').access).toBe("private");
    });
    test("yayından önce doğrulanır: bozuk dosyada ağa gidilmez", async () => {
        await writeFile(join(dir, "perafly.jsonc"), '{ "name": "x" }');
        const r = await cli(["publish", dir, "--cwd", dir, "--json"], () => undefined);
        expect(r.code).toBe(2);
        expect(r.err.error.pointer).toBe("/name");
        expect(calls).toHaveLength(0);
    });
});

describe("komut ↔ OpenAPI", () => {
    test("her işlem bir komuta eşlenir ya da gerekçesiyle komutsuzdur; eşlenen işlemler sözleşmede var", () => {
        const ops = new Set<string>();
        for (const item of Object.values((openapi as any).paths)) for (const op of Object.values(item as any)) if ((op as any)?.operationId) ops.add((op as any).operationId);
        const mapped = new Set(Object.values(COMMAND_OPERATIONS).flat());
        for (const op of ops) expect([op, mapped.has(op) || op in UNMAPPED_OPERATIONS]).toEqual([op, true]);
        for (const op of mapped) expect([op, ops.has(op)]).toEqual([op, true]);
    });
});

describe("usage (Faz 5)", () => {
    const USAGE = {
        plan: { code: "individual", name: "Individual" },
        period: { start: "2026-11-03T00:00:00.000Z", end: "2026-12-03T00:00:00.000Z" },
        usage: { lines: [{ meter: "build_seconds", unit: "second", quantity: 600, amountCents: 10 }, { meter: "bandwidth_bytes", unit: "byte", quantity: 3 * 1024 ** 3, amountCents: 45 }], totalCents: 55, includedCents: 500, overageCents: 0, billedOverageCents: 0 },
        spendLimit: { cents: 1800, isDefault: true, minCents: 900, maxCents: 1000000 },
        state: { blocked: true, reason: "spend_limit_reached", ratio: 1, alertsSent: [50, 75, 100] },
        credits: { balanceCents: 1500, planCents: 500, packCents: 1000 }
    };
    test("dönem özeti, ölçer satırları ve durdurma; --json sunucunun biçimi; yalnız okur", async () => {
        const human = await cli(["usage"], (c) => (c.method === "GET" && c.path === "/v1/usage" ? { status: 200, json: USAGE } : undefined), { PERAFLY_TOKEN: KEY });
        expect(human.code).toBe(0);
        expect(human.stdout).toContain("Individual (individual)");
        expect(human.stdout).toContain("$0.55 of $5.00 included");
        expect(human.stdout).toContain("$18.00 (default)");
        expect(human.stdout).toContain("10.0 min");
        expect(human.stdout).toContain("3.00 GB");
        expect(human.stdout).toContain("New builds are paused (spend limit reached)");
        expect(human.stdout).not.toContain(KEY);
        const json = await cli(["usage", "--json"], (c) => (c.path === "/v1/usage" ? { status: 200, json: USAGE } : undefined), { PERAFLY_TOKEN: KEY });
        expect(json.json.data).toEqual(USAGE);
        expect(calls.every((c) => c.method === "GET")).toBe(true);
    });
    test("izin yoksa 403 problem; giriş yoksa auth hatası", async () => {
        const denied = await cli(["usage", "--json"], () => ({ status: 403, json: { type: "https://perafly.com/problems/forbidden", title: "Not allowed", status: 403, code: "forbidden", requestId: "req_x" } }), { PERAFLY_TOKEN: KEY });
        expect(denied.code).not.toBe(0);
        expect(denied.err.error.code).toBe("forbidden");
        const anon = await cli(["usage", "--json"], () => undefined);
        expect(anon.code).toBe(10);
    });
});

describe("agent (Faz 6)", () => {
    const AGS = "ags_abcdefghjkmnpqrstvwxyz01";
    const session = (over: Record<string, unknown> = {}) => ({ id: AGS, title: "Bakery", status: "idle", stopReason: "end_turn", project: { id: PRJ, name: "sunny-bakery" }, budget: { cents: 500, spentCents: 120, chargedCents: 120 }, outcome: null, pending: [], previews: [{ versionId: VER, number: 1, url: "https://sunny-bakery--v1.perafly.app", createdAt: "x" }], createdBy: { id: "u", name: "Ada" }, createdAt: "x", updatedAt: "x", ...over });
    test("tarif: oturum açılır, olaylar izlenir, ajan durunca önizleme ve canlıya alma yolu yazılır; anahtar çıktıda yok", async () => {
        let polls = 0;
        const r = await cli(["agent", "A", "bakery", "site", "--budget", "5"], (c) => {
            if (c.method === "POST" && c.path === "/v1/agent/sessions") return { status: 201, json: session({ status: "running", previews: [] }) };
            if (c.path.startsWith(`/v1/agent/sessions/${AGS}/events`)) {
                const after = new URL(`https://x${c.path}`).searchParams.get("after");
                return { status: 200, json: after === "0" ? { data: [{ seq: 1, type: "user.message", text: "A bakery site" }, { seq: 2, type: "agent.message", text: "Building", agent: null }, { seq: 3, type: "preview", version: { id: VER, number: 1, url: "https://sunny-bakery--v1.perafly.app" }, project: { id: PRJ, name: "sunny-bakery" } }], nextAfter: 3 } : { data: [], nextAfter: 3 } };
            }
            if (c.path === `/v1/agent/sessions/${AGS}`) return { status: 200, json: ++polls < 2 ? session({ status: "running" }) : session() };
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(calls[0]!.body).toEqual({ prompt: "A bakery site", budgetCents: 500 });
        expect(r.stderr).toContain("Preview ready: https://sunny-bakery--v1.perafly.app");
        expect(r.stdout).toContain("perafly promote <version> --project sunny-bakery");
        expect(r.stdout + r.stderr).not.toContain(KEY);
    });
    test("bekleyen onay ve bütçe duraklaması yol gösterir; geçersiz oturum kimliği ve bütçe ağa gitmez", async () => {
        const waiting = await cli(["agent", "attach", AGS], (c) => (c.path.includes("/events") ? { status: 200, json: { data: [], nextAfter: 0 } } : { status: 200, json: session({ status: "waiting", pending: [{ id: "sevt_9", tool: "bash", summary: "rm -rf dist" }] }) }), { PERAFLY_TOKEN: KEY });
        expect(waiting.stdout).toContain(`perafly agent allow ${AGS} sevt_9`);
        const paused = await cli(["agent", "attach", AGS], (c) => (c.path.includes("/events") ? { status: 200, json: { data: [], nextAfter: 0 } } : { status: 200, json: session({ status: "paused" }) }), { PERAFLY_TOKEN: KEY });
        expect(paused.stdout).toContain(`perafly agent budget ${AGS}`);
        calls = [];
        expect((await cli(["agent", "attach", "ags_bad"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect((await cli(["agent", "x", "--budget", "-1"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect(calls).toHaveLength(0);
    });
    test("ajan profili 403 problem olarak çıkar; bütçe ve onay uçları doğru gövdeyle", async () => {
        const denied = await cli(["agent", "x", "--json"], () => ({ status: 403, json: { type: "https://perafly.com/problems/forbidden", title: "Not allowed", status: 403, code: "forbidden", requestId: "req_x" } }), { PERAFLY_TOKEN: KEY });
        expect(denied.err.error.code).toBe("forbidden");
        await cli(["agent", "budget", AGS, "9"], () => ({ status: 200, json: session({ status: "running" }) }), { PERAFLY_TOKEN: KEY });
        expect([calls.at(-1)!.path, calls.at(-1)!.body]).toEqual([`/v1/agent/sessions/${AGS}/budget`, { budgetCents: 900 }]);
        await cli(["agent", "deny", AGS, "sevt_9", "--message", "Keep it"], () => ({ status: 200, json: session() }), { PERAFLY_TOKEN: KEY });
        expect([calls.at(-1)!.path, calls.at(-1)!.body]).toEqual([`/v1/agent/sessions/${AGS}/confirmations/sevt_9`, { allow: false, message: "Keep it" }]);
    });
});

describe("logs, metrics, top (Faz 7)", () => {
    const entry = (cursor: string, over: Record<string, unknown> = {}) => ({
        cursor, at: "2026-11-14T10:02:03.120Z", stream: "access", level: "info", source: "static", message: "GET / 200",
        version: { id: VER, number: 3 }, request: { id: "r", method: "GET", path: "/", status: 200, durationMs: 12, bytes: 5120, cache: "HIT", region: "fra1" }, ...over
    });
    test("logs: son satırlar eskiden yeniye; süzgeçler sorguya gider; --since süreye çevrilir; saklama notu", async () => {
        const r = await cli(["logs", "access,runtime", "--project", "acme", "--level", "warn", "--search", "api", "--since", "2h"], (c) => {
            if (c.path.startsWith("/v1/projects/acme/logs")) {
                return { status: 200, json: { data: [entry("b", { level: "error", message: "GET /api 500" }), entry("a")], before: null, after: "b", retentionDays: 7, truncated: true } };
            }
            return undefined;
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        const q = new URL(`${API}${calls[0]!.path}`).searchParams;
        expect([q.get("stream"), q.get("level"), q.get("q"), q.get("limit")]).toEqual(["access,runtime", "warn", "api", "100"]);
        expect(Date.now() - new Date(q.get("since")!).getTime()).toBeGreaterThan(2 * 3_600_000 - 60_000);
        const lines = r.stdout.trim().split("\n");
        expect(lines[0]).toContain("GET / 200");
        expect(lines[1]).toContain("ERROR");
        expect(lines[1]).toContain("GET /api 500");
        expect(r.stdout).toContain("12 ms · 5.0 KB");
        expect(r.stdout).toContain("7-day log retention");
        expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    });
    test("logs --follow: imleçten yeni satırlar; --json her satır ayrı JSON (NDJSON); süre dolunca biter", async () => {
        let polls = 0;
        const r = await cli(["logs", "--project", "acme", "-f", "--follow-timeout", "4", "--json"], (c) => {
            const after = new URL(`${API}${c.path}`).searchParams.get("after");
            if (!after) return { status: 200, json: { data: [entry("a")], before: null, after: "a", retentionDays: 1, truncated: false } };
            polls++;
            return { status: 200, json: after === "a" ? { data: [entry("c", { message: "GET /new 200" })], before: null, after: "c" } : { data: [], before: null, after } };
        }, { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(polls).toBe(2);
        const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.map((x) => x.data.cursor)).toEqual(["a", "c"]);
        expect(new URL(`${API}${calls[2]!.path}`).searchParams.get("after")).toBe("c");
    });
    test("logs: geçersiz tür ve süre ağa gitmez; giriş yoksa auth hatası; `logs build` barındırıcı logudur", async () => {
        expect((await cli(["logs", "--project", "acme", "--since", "yesterday-ish"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect((await cli(["logs", "errors", "--project", "acme"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect(calls).toHaveLength(0);
        expect((await cli(["logs", "--project", "acme"], () => undefined)).code).toBe(10);
        await cli(["logs", "build", "--project", "acme", "--version", "v2"], () => ({ status: 200, json: { version: version({ number: 2 }), lines: [], done: true } }), { PERAFLY_TOKEN: KEY });
        expect(calls.at(-1)!.path).toBe("/v1/projects/acme/logs/build?version=v2");
    });
    test("metrics: trafik, durumlar, en çok açılan yollar; kod çalıştırmayan proje söylenir; ölçülmeyen değer —", async () => {
        const M = {
            range: "24h", measured: { traffic: true, runtime: false, workspace: false },
            traffic: { requests: 1200, pageViews: 800, visitors: 230, bytes: 5 * 1024 * 1024, status: { "2xx": 1100, "3xx": 50, "4xx": 40, "5xx": 10 }, errorRate: 0.0083, cacheHitRate: 0.61, series: [], topPaths: [{ path: "/", requests: 500, pageViews: 480 }, { path: null, requests: 3, pageViews: 0 }], topReferrers: [{ host: "news.ycombinator.com", pageViews: 40 }] },
            runtime: { runsCode: false }, usage: { buildSeconds: 42 }, workspace: null
        };
        const r = await cli(["metrics", "--project", "acme"], (c) => (c.path === "/v1/projects/acme/metrics?range=24h" ? { status: 200, json: M } : undefined), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("1,200 requests · 800 page views · 230 visitors · 5.0 MB");
        expect(r.stdout).toContain("error rate 0.8%");
        expect(r.stdout).toContain("This project runs no code");
        expect(r.stdout).toContain("(not found)");
        expect(r.stdout).toContain("news.ycombinator.com");
        const fn = await cli(["metrics", "--project", "acme", "--range", "1h"], () => ({ status: 200, json: { ...M, range: "1h", measured: { traffic: false }, runtime: { runsCode: true, invocations: 3, errors: 1, errorRate: 0.3333, durationMs: { p50: 50, p95: 640, max: 1500 }, cpuMs: 683, memory: { maxMb: 96, avgMb: 88, limitMb: 1024 } } } }), { PERAFLY_TOKEN: KEY });
        expect(fn.stdout).toContain("Not measured");
        expect(fn.stdout).toContain("p50 50 ms · p95 640 ms · max 1.5 s");
        expect(fn.stdout).toContain("96 MB peak · 88 MB average · 1024 MB allocated");
        expect((await cli(["metrics", "--project", "acme", "--range", "2y"], () => undefined, { PERAFLY_TOKEN: KEY })).code).toBe(2);
    });
    test("top: sıralama tablosu; --watch --count ile yenilenir ve biter", async () => {
        const RANK = { range: "1h", data: [{ project: { id: PRJ, name: "acme" }, live: true, requests: 70, errors: 21, errorRate: 0.3, bytes: 64000, visitors: 3, invocations: 63, buildSeconds: 2 }] };
        const r = await cli(["top"], (c) => (c.path === "/v1/metrics/projects?range=1h" ? { status: 200, json: RANK } : undefined), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/acme\s+70\s+21\s+30%\s+62\.5 KB\s+3\s+63\s+2 s/);
        const w = await cli(["top", "--watch", "--count", "2", "--json"], () => ({ status: 200, json: RANK }), { PERAFLY_TOKEN: KEY });
        expect(w.code).toBe(0);
        expect(w.stdout.trim().split("\n")).toHaveLength(2);
    });
});

describe("share ve domains (Faz 8)", () => {
    const ACCESS = { mode: "private", link: { active: true, prefix: "pfl_AbCd", createdAt: "x", createdBy: "u" }, password: { set: false, setAt: null }, people: [{ id: "shr_abcdefghjkmnpqrstvwxyz01", email: "ada@example.com", userId: null, createdAt: "x", createdBy: "u" }], requests: [{ id: "acr_x", email: "bob@example.com", name: "Bob", message: "", status: "pending", createdAt: "x" }] };
    const LINK = `https://acme.perafly.app/__perafly/s/pfl_${"Q1w2E3r4".repeat(4)}`;
    test("durum: mod, bağlantı, parola, kişiler, bekleyen istek", async () => {
        const r = await cli(["share", "--project", "acme"], (c) => (c.path === "/v1/projects/acme/access" ? { status: 200, json: ACCESS } : undefined), { PERAFLY_TOKEN: KEY });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("Private: team, shared people, link or password");
        expect(r.stdout).toContain("On (pfl_AbCd…)");
        expect(r.stdout).toContain("ada@example.com");
        expect(r.stdout).toContain("1 access request waiting");
    });
    test("herkese açmak onay ister (ajan kipi --yes sayılmaz); özele almak istemez", async () => {
        const noYes = await cli(["share", "public", "--project", "acme", "--json"], () => ({ status: 200, json: ACCESS }), { PERAFLY_TOKEN: KEY, PERAFLY_AGENT: "1" });
        expect(noYes.code).toBe(2);
        expect(calls).toHaveLength(0);
        const yes = await cli(["share", "public", "--project", "acme", "--yes"], () => ({ status: 200, json: { ...ACCESS, mode: "public" } }), { PERAFLY_TOKEN: KEY });
        expect(yes.code).toBe(0);
        expect([calls.at(-1)!.method, calls.at(-1)!.path, calls.at(-1)!.body]).toEqual(["PUT", "/v1/projects/acme/access", { mode: "public" }]);
        await cli(["share", "private", "--project", "acme"], () => ({ status: 200, json: ACCESS }), { PERAFLY_TOKEN: KEY });
        expect(calls.at(-1)!.body).toEqual({ mode: "private" });
    });
    test("bağlantı insan çıktısında bir kez görünür, --json'da karartılır; kapatma", async () => {
        const human = await cli(["share", "link", "--project", "acme"], () => ({ status: 201, json: { url: LINK, access: ACCESS } }), { PERAFLY_TOKEN: KEY });
        expect(human.stdout).toContain(LINK);
        const json = await cli(["share", "link", "--project", "acme", "--json"], () => ({ status: 201, json: { url: LINK, access: ACCESS } }), { PERAFLY_TOKEN: KEY });
        expect(json.stdout).not.toContain("pfl_Q1w2");
        expect(json.json.data.url).not.toContain("pfl_Q1w2");
        await cli(["share", "link", "--revoke", "--project", "acme"], () => ({ status: 200, json: ACCESS }), { PERAFLY_TOKEN: KEY });
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", "/v1/projects/acme/access/link"]);
    });
    test("parola stdin'den; kişi ekleme ve e-postayla kaldırma", async () => {
        const stdout = new Sink();
        const { Readable } = await import("node:stream");
        const input = Object.assign(Readable.from(["correct horse\n"]), { isTTY: false });
        const code = await run(["share", "password", "--project", "acme"], { env: { PERAFLY_HOME: home, PERAFLY_API_URL: API, PERAFLY_CREDENTIAL_STORE: "plaintext", PERAFLY_TOKEN: KEY }, fetch: fakeFetch(() => ({ status: 200, json: ACCESS })), sleep: async () => undefined, stdout, stderr: new Sink(), stdin: input as any });
        expect(code).toBe(0);
        expect([calls.at(-1)!.method, calls.at(-1)!.path, calls.at(-1)!.body]).toEqual(["PUT", "/v1/projects/acme/access/password", { password: "correct horse" }]);
        expect(stdout.text).not.toContain("correct horse");
        await cli(["share", "add", "Ada@Example.com", "--project", "acme"], () => ({ status: 201, json: ACCESS }), { PERAFLY_TOKEN: KEY });
        expect(calls.at(-1)!.body).toEqual({ email: "Ada@Example.com" });
        await cli(["share", "rm", "ada@example.com", "--project", "acme"], (c) => (c.method === "GET" ? { status: 200, json: ACCESS } : { status: 200, json: { ...ACCESS, people: [] } }), { PERAFLY_TOKEN: KEY });
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", "/v1/projects/acme/access/people/shr_abcdefghjkmnpqrstvwxyz01"]);
        const missing = await cli(["share", "rm", "nobody@example.com", "--project", "acme"], () => ({ status: 200, json: ACCESS }), { PERAFLY_TOKEN: KEY });
        expect(missing.code).toBe(20);
    });
    test("alan adı: ekleyince kurulacak DNS kaydı; liste; silme onay ister", async () => {
        const D = { id: "dom_x", name: "www.acme.com", status: "pending", verification: [], dns: { configured: false, records: [{ type: "CNAME", name: "www", value: "cname.vercel-dns.com" }] }, createdAt: "x", checkedAt: "x", activeSince: null };
        const add = await cli(["domains", "add", "www.acme.com", "--project", "acme"], () => ({ status: 201, json: D }), { PERAFLY_TOKEN: KEY });
        expect(add.code).toBe(0);
        expect(add.stdout).toMatch(/CNAME\s+www\s+cname\.vercel-dns\.com/);
        expect(add.stdout).toContain("perafly domains check www.acme.com");
        const ls = await cli(["domains", "ls", "--project", "acme"], () => ({ status: 200, json: { data: [{ ...D, status: "active" }] } }), { PERAFLY_TOKEN: KEY });
        expect(ls.stdout).toMatch(/www\.acme\.com\s+Active/);
        calls = [];
        expect((await cli(["domains", "rm", "www.acme.com", "--project", "acme"], () => ({ status: 204 }), { PERAFLY_TOKEN: KEY })).code).toBe(2);
        expect(calls).toHaveLength(0);
        await cli(["domains", "rm", "www.acme.com", "--project", "acme", "--yes"], () => ({ status: 204 }), { PERAFLY_TOKEN: KEY });
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", "/v1/projects/acme/domains/www.acme.com"]);
    });
});
