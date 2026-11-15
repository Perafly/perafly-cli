import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { deleteCredential, loadCredential, matchesApiUrl, normalizeApiUrl, saveCredential, setKeyringLoaderForTests, type StoredCredential } from "../src/auth/store.js";
import { assertNoSecretInArgv, resolveApiKey } from "../src/auth/token.js";
import { startDeviceLogin, waitForDeviceToken } from "../src/auth/device.js";
import { redact, redactDeep, REDACTED } from "../src/auth/redact.js";
import { ensureGitignored, readState, resolveProjectKey, saveAnonymousProject, statePath } from "../src/publish/state.js";

const KEY = `pfa_${"A1b2C3d4".repeat(4)}`;
const PKEY = `pfc_${"Z9y8X7w6".repeat(4)}`;
const API = "https://api.perafly.com";
let home: string;
const saved = { ...process.env };

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pf-home-"));
    process.env.PERAFLY_HOME = home;
    delete process.env.PERAFLY_TOKEN;
    delete process.env.PERAFLY_CLAIM_TOKEN;
    delete process.env.PERAFLY_CREDENTIAL_STORE;
    setKeyringLoaderForTests(async () => null);
});
afterEach(async () => {
    process.env = { ...saved };
    setKeyringLoaderForTests(null);
    await rm(home, { recursive: true, force: true });
});

const cred = (over: Partial<StoredCredential> = {}): StoredCredential => ({ token: KEY, apiUrl: API, access: "full", createdAt: new Date().toISOString(), ...over });

describe("API adresi", () => {
    test("normalleşir; yalnız https (yerelde http); kimlik taşıyan adres reddedilir", () => {
        expect(normalizeApiUrl("https://API.Perafly.com/")).toBe(API);
        expect(normalizeApiUrl("http://localhost:5599")).toBe("http://localhost:5599");
        expect(() => normalizeApiUrl("http://api.perafly.com")).toThrow();
        expect(() => normalizeApiUrl("https://user:pw@api.perafly.com")).toThrow();
        expect(() => normalizeApiUrl("file:///etc/passwd")).toThrow();
        expect(matchesApiUrl({ apiUrl: API }, "https://api.perafly.com/")).toBe(true);
        expect(matchesApiUrl({ apiUrl: API }, "https://evil.example")).toBe(false);
    });
});

describe("kimlik deposu", () => {
    test("anahtar zinciri yoksa düz dosya: klasör 0700, dosya 0600; okunur ve silinir", async () => {
        expect(await saveCredential("default", cred())).toBe("plaintext");
        const file = join(home, "credentials", "default.json");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(join(home, "credentials"))).mode & 0o777).toBe(0o700);
        expect((await loadCredential("default"))?.credential.token).toBe(KEY);
        expect(await deleteCredential("default")).toBe(true);
        expect(await loadCredential("default")).toBeNull();
    });

    test("geniş izinli dosya daraltılır", async () => {
        await saveCredential("default", cred());
        const file = join(home, "credentials", "default.json");
        await chmod(file, 0o644);
        await loadCredential("default");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    });

    test("anahtar zinciri varsa oraya yazılır, düz dosya kalmaz; zorlanan zincir yoksa credential_keyring_unavailable", async () => {
        const vault = new Map<string, string>();
        setKeyringLoaderForTests(async () => ({
            Entry: class {
                constructor(private s: string, private u: string) {}
                setPassword(p: string) { vault.set(`${this.s}/${this.u}`, p); }
                getPassword() { return vault.get(`${this.s}/${this.u}`) ?? null; }
                deletePassword() { return vault.delete(`${this.s}/${this.u}`); }
            } as any
        }));
        await saveCredential("work", cred());
        expect(await stat(join(home, "credentials", "work.json")).catch(() => null)).toBeNull();
        expect((await loadCredential("work"))?.backend).toBe("keyring");
        setKeyringLoaderForTests(async () => null);
        process.env.PERAFLY_CREDENTIAL_STORE = "keyring";
        await expect(saveCredential("work", cred())).rejects.toMatchObject({ code: "credential_keyring_unavailable", exitCode: 10 });
    });

    test("geçersiz profil adı ve anahtar olmayan değer kaydedilmez", async () => {
        await expect(saveCredential("../x", cred())).rejects.toMatchObject({ code: "validation_error" });
        await expect(saveCredential("default", cred({ token: PKEY }))).rejects.toMatchObject({ code: "validation_error" });
    });
});

describe("belirteç seçimi", () => {
    test("PERAFLY_TOKEN önce gelir; proje anahtarı orada reddedilir", async () => {
        await saveCredential("default", cred({ token: `pfa_${"Q".repeat(32)}` }));
        expect((await resolveApiKey({ profile: "default", apiUrl: API, env: { PERAFLY_TOKEN: KEY } }))?.source).toBe("env");
        await expect(resolveApiKey({ profile: "default", apiUrl: API, env: { PERAFLY_TOKEN: PKEY } })).rejects.toMatchObject({ code: "auth_required" });
    });
    test("kayıtlı giriş yalnız verildiği API adresinde kullanılır; süresi dolmuşsa credential_expired", async () => {
        await saveCredential("default", cred());
        expect((await resolveApiKey({ profile: "default", apiUrl: API, env: {} }))?.token).toBe(KEY);
        expect(await resolveApiKey({ profile: "default", apiUrl: "https://staging.perafly.com", env: {} })).toBeNull();
        await saveCredential("default", cred({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
        await expect(resolveApiKey({ profile: "default", apiUrl: API, env: {} })).rejects.toMatchObject({ code: "credential_expired", exitCode: 10 });
    });
    test("argümanda anahtar ya da devir bağlantısı varsa komut düşer", () => {
        expect(() => assertNoSecretInArgv(["publish", "--token", KEY])).toThrow(/never passed as arguments/);
        expect(() => assertNoSecretInArgv(["login", "--handoff", `https://perafly.com/h#pfh_${"a".repeat(24)}`])).toThrowError(expect.objectContaining({ code: "handoff_link_in_argv" }));
        expect(() => assertNoSecretInArgv(["publish", "./dist", "-m", "pfa_ is a prefix"])).not.toThrow();
    });
});

describe("hesapsız proje durumu", () => {
    test("state.json 0600, .gitignore'a eklenir (bir kez); anahtar aynı API adresinde çözülür; ortam değişkeni önce gelir", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pf-proj-"));
        try {
            await writeFile(join(dir, ".gitignore"), "node_modules/");
            await saveAnonymousProject(dir, { projectId: "prj_x", projectName: "brave-otter", projectKey: PKEY, apiUrl: API, liveUrl: null, expiresAt: null, claimDeadline: null });
            expect((await stat(statePath(dir))).mode & 0o777).toBe(0o600);
            const gi = await readFile(join(dir, ".gitignore"), "utf8");
            expect(gi).toBe("node_modules/\n# Perafly: local state holds the project key; never commit it\n.perafly/state.json\n");
            expect(await ensureGitignored(dir)).toBe(false);
            expect((await resolveProjectKey({ dir, apiUrl: API, env: {} }))?.token).toBe(PKEY);
            expect(await resolveProjectKey({ dir, apiUrl: "https://other.example", env: {} })).toBeNull();
            const other = `pfc_${"M".repeat(32)}`;
            expect((await resolveProjectKey({ dir, apiUrl: API, env: { PERAFLY_CLAIM_TOKEN: other } }))?.source).toBe("env");
            await expect(resolveProjectKey({ dir, apiUrl: API, env: { PERAFLY_CLAIM_TOKEN: KEY } })).rejects.toMatchObject({ code: "auth_required" });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    test("bozuk state.json açık hata verir; anahtarı geçersiz kayıt yok sayılır", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pf-proj-"));
        try {
            await mkdir(join(dir, ".perafly"));
            await writeFile(statePath(dir), "{nope");
            await expect(readState(dir)).rejects.toMatchObject({ code: "validation_error" });
            await writeFile(statePath(dir), JSON.stringify({ anonymous: { projectId: "prj_x", projectKey: "pfc_short", apiUrl: API } }));
            expect((await readState(dir)).anonymous).toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("cihazla giriş", () => {
    const start = { deviceCode: "dev-code-secret-0123456789abcdef", userCode: "BCDF-GHJK", verificationUri: "https://perafly.com/authorize", verificationUriComplete: "https://perafly.com/authorize?code=BCDF-GHJK", expiresIn: 600, interval: 5 };
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });

    test("başlatma: güvensiz doğrulama adresi reddedilir", async () => {
        const ok = await startDeviceLogin(API, { access: "agent" }, { fetch: async () => reply(201, start) });
        expect(ok.userCode).toBe("BCDF-GHJK");
        await expect(startDeviceLogin(API, {}, { fetch: async () => reply(201, { ...start, verificationUri: "javascript:alert(1)" }) })).rejects.toMatchObject({ code: "invalid_response" });
        await expect(startDeviceLogin(API, {}, { fetch: async () => reply(201, { ...start, verificationUri: "http://perafly.com/authorize" }) })).rejects.toMatchObject({ code: "invalid_response" });
        await expect(startDeviceLogin(API, { access: "root" as any }, { fetch: async () => reply(201, start) })).rejects.toMatchObject({ code: "validation_error" });
    });

    test("bekleme: pending → slow_down (aralık +5) → anahtar", async () => {
        const answers = [reply(400, { code: "authorization_pending" }), reply(400, { code: "slow_down" }), reply(200, { token: KEY, expiresAt: "2026-12-14T00:00:00Z", access: "full", team: { id: "t1", name: "Acme" }, user: { id: "u1", name: "Ada" } })];
        const sleeps: number[] = [];
        const out = await waitForDeviceToken(API, start, { fetch: async () => answers.shift()!, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
        expect(out.token).toBe(KEY);
        expect(out.team?.name).toBe("Acme");
        expect(sleeps).toEqual([5000, 5000, 10000]);
    });

    test("ret ve süre dolumu çıkış 10; hata iletisi cihaz kodunu taşımaz", async () => {
        await expect(waitForDeviceToken(API, start, { fetch: async () => reply(400, { code: "access_denied" }), sleep: async () => undefined, now: () => 0 })).rejects.toMatchObject({ code: "access_denied", exitCode: 10 });
        let t = 0;
        const err = await waitForDeviceToken(API, { ...start, expiresIn: 60 }, { fetch: async () => reply(400, { code: "authorization_pending" }), sleep: async () => { t += 30_000; }, now: () => t }).catch((e) => e);
        expect(err.code).toBe("expired_token");
        expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(start.deviceCode);
    });
});

describe("karartma", () => {
    test("anahtarlar, imzalı yükleme adresi, sahiplenme parçası ve cihaz kodu", () => {
        const text = `key ${KEY} pk ${PKEY} https://api.perafly.com/v1/uploads/abc.def?x=1 https://perafly.com/claim#prj_1.${PKEY} {"deviceCode":"secret-code"}`;
        const out = redact(text);
        expect(out).not.toContain(KEY);
        expect(out).not.toContain(PKEY);
        expect(out).not.toContain("abc.def");
        expect(out).not.toContain("secret-code");
        expect(out).toContain("https://api.perafly.com/v1/uploads/[redacted]");
    });
    test("nesnede sır alanları karartılır; canlı adres kalır", () => {
        const out = redactDeep({ token: KEY, projectKey: PKEY, claimUrl: "https://perafly.com/claim#x", project: { urls: { live: "https://a.perafly.app" } }, uploads: [{ url: "https://api.perafly.com/v1/uploads/t" }] });
        expect(out).toEqual({ token: REDACTED, projectKey: REDACTED, claimUrl: REDACTED, project: { urls: { live: "https://a.perafly.app" } }, uploads: [{ url: REDACTED }] });
    });
});

describe("klasörün ajan anahtarı", () => {
    test("sahiplenme sonucu proje anahtarını siler, ajan anahtarını saklar; kişinin girişi önce gelir", async () => {
        const { saveClaimResult } = await import("../src/publish/state.js");
        const dir = await mkdtemp(join(tmpdir(), "pf-proj-"));
        try {
            await saveAnonymousProject(dir, { projectId: "prj_x", projectName: null, projectKey: PKEY, apiUrl: API, liveUrl: null, expiresAt: null, claimDeadline: null });
            const agentKey = `pfa_${"K".repeat(32)}`;
            await saveClaimResult(dir, { projectId: "prj_x", apiUrl: API, agentKey });
            const state = await readState(dir);
            expect(state.anonymous).toBeUndefined();
            expect((await resolveApiKey({ profile: "default", apiUrl: API, env: {}, dir }))).toMatchObject({ token: agentKey, source: "folder" });
            await saveCredential("default", cred());
            expect((await resolveApiKey({ profile: "default", apiUrl: API, env: {}, dir }))?.token).toBe(KEY);
            expect(await resolveApiKey({ profile: "other", apiUrl: "https://elsewhere.example", env: {}, dir })).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
