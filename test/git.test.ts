/**
 * Faz 10: Git ve CI, sahte fetch ile (gerçek ağ ve anahtar zinciri yok; `git remote` gerçek git ile geçici depoda):
 * kimlik yardımcısı protokolü (yalnız Perafly adresine, tam iki satır, anahtarsız sessiz, anahtar stderr'de yok),
 * uzak adres ve yardımcının yalnız o adres için kurulması (`origin`'e dokunulmaz), CI algılama ve bayraklar, yayının
 * `git` alanı ve sunucunun verdiği dal adresi (tahmin yok), çatal onayı (ajan kipinde yalnız açık `--yes`), durum
 * çıktısı, yerel MCP sınıflandırması, dal adı kurallarının backend ile eşliği.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { saveCredential, setKeyringLoaderForTests } from "../src/auth/store.js";
import { createLocalHandlers } from "../src/mcp/server.js";
import { HIDDEN_OPERATIONS, OPERATION_PERMISSION, operationSpecs } from "../src/mcp/tools.js";
import { detectCi, resolvePublishGit } from "../src/git/ci.js";
import { credentialTargets, parseCredentialInput } from "../src/git/credential.js";
import { helperCommand } from "../src/git/repo.js";
import { isCommitSha, isValidBranch } from "../src/git/rules.js";

const API = "https://api.perafly.test";
const KEY = `pfa_${"A1b2C3d4".repeat(4)}`;
const KEY2 = `pfa_${"Z9y8X7w6".repeat(4)}`;
const PRJ = "prj_abcdefghjkmnpqrstvwxyz01";
const VER = "ver_abcdefghjkmnpqrstvwxyz01";
const PUSH = "https://git.perafly.test/acme-site.git";
const SHA = "9f2c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b";

class Sink extends Writable {
    text = "";
    isTTY = false;
    override _write(chunk: any, _e: string, cb: () => void) {
        this.text += chunk.toString();
        cb();
    }
}

interface Call { method: string; path: string; query: URLSearchParams; auth: string | null; body: any }
type Reply = { status: number; json?: unknown } | undefined;
type Handler = (c: Call) => Reply;

let home: string;
let dir: string;
let calls: Call[];
const savedHome = process.env.PERAFLY_HOME;

const fakeFetch = (handler: Handler) => (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init.method ?? "GET", path: url.pathname + url.search, query: url.searchParams, auth: headers.Authorization ?? null, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
    calls.push(call);
    const r = handler(call);
    if (!r) return new Response(JSON.stringify({ status: 404, code: "not_found", title: "Not found" }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    if (r.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: { "Content-Type": r.status >= 400 ? "application/problem+json" : "application/json" } });
}) as typeof fetch;

const cli = async (argv: string[], handler: Handler, env: Record<string, string> = {}, stdinText?: string) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const stdin = Object.assign(Readable.from(stdinText !== undefined ? [Buffer.from(stdinText)] : []), { isTTY: false }) as any;
    const code = await run(argv, { env: { PERAFLY_HOME: home, PERAFLY_API_URL: API, PERAFLY_CREDENTIAL_STORE: "plaintext", PERAFLY_TOKEN: KEY, ...env }, fetch: fakeFetch(handler), sleep: async () => undefined, stdout, stderr, stdin });
    const parse = (t: string) => {
        try {
            return JSON.parse(t.trim().split("\n").pop()!);
        } catch {
            return null;
        }
    };
    return { code, stdout: stdout.text, stderr: stderr.text, json: parse(stdout.text), err: parse(stderr.text) };
};

const gitRaw = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
const git = (args: string[], cwd: string) => gitRaw(args, cwd).trim();
/** Değer listesi: boş değer de bir satırdır (trim edilmez) */
const gitValues = (args: string[], cwd: string) => gitRaw(args, cwd).replace(/\n$/, "").split("\n");
const gitOr = (args: string[], cwd: string) => {
    try {
        return git(args, cwd);
    } catch {
        return null;
    }
};
const initRepo = async () => {
    const repo = await mkdtemp(join(tmpdir(), "pf-repo-"));
    git(["init", "-q"], repo);
    git(["remote", "add", "origin", "https://github.com/acme/site.git"], repo);
    return repo;
};

const GIT = (over: Record<string, unknown> = {}) => ({
    github: { installation: { id: 4823, account: "acme" }, repository: { id: 97321, fullName: "acme/site", url: "https://github.com/acme/site" } },
    productionBranch: "main", autoDeployProduction: true, autoDeployPreviews: true, push: { url: PUSH }, connectedAt: "2026-11-14T10:00:00Z", connectedBy: { name: "Ada Lovelace" },
    ...over
});
const BUILD = (over: Record<string, unknown> = {}) => ({
    id: "gbd_1", status: "succeeded", trigger: "push", branch: "feature/login", commit: { sha: SHA, message: "Add login form", author: "Ada Lovelace" },
    pullRequest: null, fork: false, target: "preview", version: { id: VER, number: 12, url: "https://acme-site--v12.perafly.app" },
    branchUrl: "https://acme-site--br-feature-login.perafly.app", skipped: [], error: null, createdAt: "2026-11-14T10:00:00Z", startedAt: null, finishedAt: null,
    ...over
});

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pf-home-"));
    process.env.PERAFLY_HOME = home;
    dir = await mkdtemp(join(tmpdir(), "pf-git-"));
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

describe("git credential: Git'in kimlik yardımcısı", () => {
    const ask = (input: string, env: Record<string, string> = {}, argv = ["git", "credential", "get"]) => cli(argv, () => undefined, env, input);

    test("get: yalnız API'nin ve git. kardeşinin https adresine tam iki satır yazar; başka adrese hiçbir şey", async () => {
        for (const host of ["api.perafly.test", "git.perafly.test"]) {
            const r = await ask(`protocol=https\nhost=${host}\npath=acme-site.git\nwwwauth[]=Basic realm="Perafly"\n\n`);
            expect(r.code).toBe(0);
            expect(r.stdout).toBe(`username=perafly\npassword=${KEY}\n`);
            expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(2);
            expect(r.stderr).not.toContain(KEY);
        }
        for (const input of ["protocol=https\nhost=github.com\n", "protocol=http\nhost=api.perafly.test\n", "protocol=https\nhost=git.perafly.test.evil.com\n", "protocol=https\nhost=evil-git.perafly.test\n", "protocol=https\n", "host=git.perafly.test\n", ""]) {
            const r = await ask(input);
            expect([input, r.code, r.stdout]).toEqual([input, 0, ""]);
        }
        expect(calls).toHaveLength(0);
    });

    test("anahtar yoksa çıktı yok ve çıkış 0 (Git sıradaki yolu dener); kayıtlı giriş kullanılır; bozuk anahtar sessiz düşer", async () => {
        const none = await ask("protocol=https\nhost=git.perafly.test\n", { PERAFLY_TOKEN: "" });
        expect([none.code, none.stdout]).toEqual([0, ""]);
        expect(none.stderr).toContain("not signed in");
        await saveCredential("default", { token: KEY2, apiUrl: API, createdAt: "2026-11-14T10:00:00Z" });
        const saved = await ask("protocol=https\nhost=git.perafly.test\n", { PERAFLY_TOKEN: "" });
        expect(saved.stdout).toBe(`username=perafly\npassword=${KEY2}\n`);
        const bad = await ask("protocol=https\nhost=git.perafly.test\n", { PERAFLY_TOKEN: "not-a-key" });
        expect([bad.code, bad.stdout]).toEqual([0, ""]);
        // Başka API'ye verilmiş giriş bu adres için kullanılmaz
        const other = await ask("protocol=https\nhost=git.other.test\n", { PERAFLY_TOKEN: "" }, ["--api-url", "https://api.other.test", "git", "credential", "get"]);
        expect([other.code, other.stdout]).toEqual([0, ""]);
    });

    test("PERAFLY_DEBUG ile de anahtar stderr'e yazılmaz; store ve erase hiçbir şey yapmaz", async () => {
        const r = await ask("protocol=https\nhost=git.perafly.test\n", { PERAFLY_DEBUG: "1" });
        expect(r.stdout).toBe(`username=perafly\npassword=${KEY}\n`);
        expect(r.stderr).toContain("[perafly] git credential get: answered");
        expect(r.stderr).not.toContain(KEY);
        const miss = await ask("protocol=https\nhost=github.com\n", { PERAFLY_DEBUG: "1" });
        expect(miss.stdout).toBe("");
        for (const op of ["store", "erase", "bogus"]) {
            const s = await ask(`protocol=https\nhost=git.perafly.test\nusername=perafly\npassword=${KEY}\n`, { PERAFLY_DEBUG: "1" }, ["git", "credential", op]);
            expect([op, s.code, s.stdout]).toEqual([op, 0, ""]);
            expect(s.stderr).not.toContain(KEY);
        }
    });

    test("sabitlenmiş --api-url: yerel API'de itme adresi API'nin kendisidir (http yalnız orada)", async () => {
        const r = await ask("protocol=http\nhost=localhost:5599\npath=git/acme-site.git\n", {}, ["--api-url", "http://localhost:5599", "git", "credential", "get"]);
        expect(r.stdout).toBe(`username=perafly\npassword=${KEY}\n`);
        expect(credentialTargets("https://api.perafly.com")).toEqual([{ protocol: "https", host: "api.perafly.com" }, { protocol: "https", host: "git.perafly.com" }]);
        expect(credentialTargets("http://localhost:5599")).toEqual([{ protocol: "http", host: "localhost:5599" }]);
        expect(parseCredentialInput("protocol=https\nhost=a\n\nhost=b\n")).toEqual({ protocol: "https", host: "a" });
    });
});

describe("git remote: uzak adres ve yalnız o adres için kimlik yardımcısı", () => {
    let repo: string;
    beforeEach(async () => {
        repo = await initRepo();
    });
    afterEach(async () => {
        await rm(repo, { recursive: true, force: true });
    });
    const helperKey = "credential.https://git.perafly.test.helper";

    test("uzak adres kimlik taşımaz, origin değişmez, yardımcı yalnız itme adresinin kökü için ve depo yapılandırmasında", async () => {
        const r = await cli(["git", "remote", "--project", "acme-site", "--cwd", repo, "--json"], (c) => (c.path === "/v1/projects/acme-site/git" ? { status: 200, json: GIT() } : undefined));
        expect(r.code).toBe(0);
        expect(r.json).toEqual({ data: { remote: "perafly", url: PUSH } });
        expect(git(["remote", "get-url", "perafly"], repo)).toBe(PUSH);
        expect(git(["remote", "get-url", "origin"], repo)).toBe("https://github.com/acme/site.git");
        const helpers = gitValues(["config", "--local", "--get-all", helperKey], repo);
        expect(helpers).toHaveLength(2);
        expect(helpers[0]).toBe("");
        expect(helpers[1]).toMatch(/^!\S.* --api-url https:\/\/api\.perafly\.test git credential$/);
        // Yalnız bu adres: genel yardımcı yazılmaz, başka credential anahtarı yok
        expect(gitOr(["config", "--local", "--get-all", "credential.helper"], repo)).toBeNull();
        expect(git(["config", "--local", "--get-regexp", "^credential\\."], repo).split("\n").every((l) => l.startsWith(`${helperKey} `) || l === helperKey)).toBe(true);
        const config = await readFile(join(repo, ".git", "config"), "utf8");
        expect(config).not.toContain(KEY);
        expect(config).not.toMatch(/https:\/\/[^/\s]*@/);

        // Yeniden çalıştırmak aynı iki satırı bırakır; insan çıktısı itme komutunu söyler
        const again = await cli(["git", "remote", "--project", "acme-site", "--cwd", repo], (c) => (c.path === "/v1/projects/acme-site/git" ? { status: 200, json: GIT({ productionBranch: "trunk" }) } : undefined));
        expect(again.code).toBe(0);
        expect(again.stdout).toContain("git push perafly HEAD:trunk");
        expect(again.stdout).toContain("Kept remote perafly");
        expect(gitValues(["config", "--local", "--get-all", helperKey], repo)).toHaveLength(2);
        expect(again.stdout + again.stderr).not.toContain(KEY);
    });

    test("--name origin reddedilir; depo değilse açık hata; ikisi de ağa gitmez", async () => {
        const o = await cli(["git", "remote", "--name", "origin", "--project", "acme-site", "--cwd", repo, "--json"], () => ({ status: 200, json: GIT() }));
        expect(o.code).toBe(2);
        expect(o.err.error.code).toBe("validation_error");
        expect(git(["remote", "get-url", "origin"], repo)).toBe("https://github.com/acme/site.git");
        const notRepo = await cli(["git", "remote", "--project", "acme-site", "--cwd", dir, "--json"], () => ({ status: 200, json: GIT() }));
        expect(notRepo.code).toBe(2);
        expect(notRepo.err.error.code).toBe("not_a_git_repository");
        expect(calls).toHaveLength(0);
    });

    test("başka adla eklenir; itme adresi kimlik ya da http taşıyorsa yazılmaz", async () => {
        const named = await cli(["git", "remote", "--name", "deploy", "--project", "acme-site", "--cwd", repo, "--json"], () => ({ status: 200, json: GIT() }));
        expect(named.code).toBe(0);
        expect(git(["remote", "get-url", "deploy"], repo)).toBe(PUSH);
        for (const url of [`https://user:${KEY}@git.perafly.test/acme-site.git`, "http://git.perafly.test/acme-site.git"]) {
            const bad = await cli(["git", "remote", "--name", "bad", "--project", "acme-site", "--cwd", repo, "--json"], () => ({ status: 200, json: GIT({ push: { url } }) }));
            expect(bad.code).toBe(1);
            expect(bad.err.error.code).toBe("invalid_response");
            expect(gitOr(["remote", "get-url", "bad"], repo)).toBeNull();
            expect(bad.stdout + bad.stderr).not.toContain(KEY);
        }
    });

    test("yardımcı satırı: kurulu ikili mutlak yoluyla, npx önbelleği ve bilinmeyen yol PATH'teki perafly; varsayılan API sabitlenmez", () => {
        expect(helperCommand({ argv1: "/usr/local/bin/perafly" })).toBe("!/usr/local/bin/perafly git credential");
        expect(helperCommand({ argv1: "/Users/a b/.npm/bin/pf" })).toBe("!'/Users/a b/.npm/bin/pf' git credential");
        expect(helperCommand({ argv1: "/opt/perafly/dist/cli.js", execPath: "/usr/bin/node" })).toBe("!/usr/bin/node /opt/perafly/dist/cli.js git credential");
        expect(helperCommand({ argv1: "/Users/a/.npm/_npx/123/node_modules/.bin/perafly" })).toBe("!perafly git credential");
        expect(helperCommand({ argv1: "/x/vitest.mjs", apiUrl: "http://localhost:5599", profile: "work" })).toBe("!perafly --api-url http://localhost:5599 --profile work git credential");
    });
});

describe("CI algılama ve bayraklar", () => {
    test("her sağlayıcı: dal, işleme, ileti ve yazar (e-posta gönderilmez); etiket derlemesi dal değildir", () => {
        expect(detectCi({ GITHUB_ACTIONS: "true", GITHUB_REF_NAME: "main", GITHUB_SHA: SHA })).toMatchObject({ provider: "github", branch: "main", commit: SHA });
        expect(detectCi({ GITHUB_ACTIONS: "true", GITHUB_HEAD_REF: "feature/x", GITHUB_REF_NAME: "12/merge", GITHUB_SHA: SHA })?.branch).toBe("feature/x");
        expect(resolvePublishGit({ env: { GITHUB_ACTIONS: "true", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.0", GITHUB_SHA: SHA } })).toBeNull();
        expect(resolvePublishGit({ env: { GITLAB_CI: "true", CI_COMMIT_REF_NAME: "feature/y", CI_COMMIT_SHA: SHA, CI_COMMIT_MESSAGE: "Add login\n\nLonger body", CI_COMMIT_AUTHOR: "Ada Lovelace <ada@example.com>" } }))
            .toEqual({ git: { branch: "feature/y", commit: SHA, message: "Add login", author: "Ada Lovelace" }, source: "gitlab" });
        expect(resolvePublishGit({ env: { GITLAB_CI: "true", CI_COMMIT_REF_NAME: "v2", CI_COMMIT_TAG: "v2", CI_COMMIT_SHA: SHA } })).toBeNull();
        expect(resolvePublishGit({ env: { BITBUCKET_BUILD_NUMBER: "7", BITBUCKET_BRANCH: "dev", BITBUCKET_COMMIT: SHA } })).toEqual({ git: { branch: "dev", commit: SHA }, source: "bitbucket" });
        expect(resolvePublishGit({ env: { CIRCLECI: "true", CIRCLE_BRANCH: "next", CIRCLE_SHA1: SHA.toUpperCase() } })).toEqual({ git: { branch: "next", commit: SHA }, source: "circleci" });
        expect(resolvePublishGit({ env: { CI: "true" } })).toBeNull();
        expect(resolvePublishGit({ env: {} })).toBeNull();
        // CI'dan gelen geçersiz dal ve işleme sessizce düşer
        expect(resolvePublishGit({ env: { CIRCLECI: "true", CIRCLE_BRANCH: "bad..name", CIRCLE_SHA1: SHA } })).toBeNull();
        expect(resolvePublishGit({ env: { CIRCLECI: "true", CIRCLE_BRANCH: "ok", CIRCLE_SHA1: "nope" } })).toEqual({ git: { branch: "ok" }, source: "circleci" });
    });

    test("bayraklar her yerde çalışır ve CI'ın önüne geçer; başka işlemede CI iletisi gönderilmez; geçersiz bayrak hata", () => {
        expect(resolvePublishGit({ env: {}, branch: "feature/z", commit: "ABCDEF1" })).toEqual({ git: { branch: "feature/z", commit: "abcdef1" }, source: "flag" });
        const gl = { GITLAB_CI: "true", CI_COMMIT_REF_NAME: "feature/y", CI_COMMIT_SHA: SHA, CI_COMMIT_MESSAGE: "Add login" };
        expect(resolvePublishGit({ env: gl, branch: "main" })).toEqual({ git: { branch: "main", commit: SHA, message: "Add login" }, source: "flag" });
        expect(resolvePublishGit({ env: gl, commit: "1234567" })).toEqual({ git: { branch: "feature/y", commit: "1234567" }, source: "gitlab" });
        expect(resolvePublishGit({ env: {}, commit: "1234567" })).toBeNull();
        expect(() => resolvePublishGit({ env: {}, branch: "a b" })).toThrow(/not a valid Git branch/);
        expect(() => resolvePublishGit({ env: {}, branch: "main", commit: "xyz" })).toThrow(/commit SHA/);
    });
});

describe("publish: CI'dan Git bilgisi ve dal adresi", () => {
    const team = { id: PRJ, name: "acme-site", teamId: "team1", urls: { live: "https://acme-site.perafly.app" }, anonymous: null, publishRule: "auto" };
    const BRANCH_URL = "https://acme-site--br-feature-login.perafly.app";
    const ver = (over: Record<string, unknown> = {}) => ({ id: VER, projectId: PRJ, number: 12, state: "ready", target: "preview", url: "https://acme-site--v12.perafly.app", live: false, git: { trigger: "ci", branch: "feature/login", commit: { sha: SHA, message: "", author: "" }, pullRequest: null, branchUrl: BRANCH_URL }, ...over });
    const GH = { GITHUB_ACTIONS: "true", GITHUB_REF_NAME: "feature/login", GITHUB_SHA: SHA };
    const handler = (opts: { version?: Record<string, unknown> } = {}): Handler => (c) => {
        if (c.path === "/v1/publish") return { status: 201, json: { project: team, version: ver({ state: "uploading", number: null }), uploads: [] } };
        if (c.path.startsWith(`/v1/versions/${VER}/finalize`)) return { status: 200, json: { project: team, version: ver(opts.version) } };
        return undefined;
    };

    test("GitHub Actions: git alanı gider, hedef gönderilmez (dal kuralı); dal adresi tamamlama yanıtının version.git.branchUrl'i", async () => {
        const r = await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--json"], handler(), GH);
        expect(r.code).toBe(0);
        const body = calls.find((c) => c.path === "/v1/publish")!.body;
        expect(body.git).toEqual({ branch: "feature/login", commit: SHA });
        expect("target" in body).toBe(false);
        expect(r.json.data.branchUrl).toBe(BRANCH_URL);
        expect(r.json.data.version.git.branch).toBe("feature/login");
        // Dal adresi için ayrı istek yok
        expect(calls.map((c) => c.path.split("?")[0])).toEqual(["/v1/publish", `/v1/versions/${VER}/finalize`]);
        const human = await cli(["publish", dir, "--cwd", dir, "--project", "acme-site"], handler(), GH);
        expect(human.stdout).toMatch(/Branch URL\s+https:\/\/acme-site--br-feature-login\.perafly\.app/);
        expect(human.stdout).toMatch(/Branch\s+feature\/login @ 9f2c1a2/);
        expect(human.stderr).toContain("Branch feature/login @ 9f2c1a2 (GitHub Actions)");
    });

    test("--target verilirse gider; CI ve bayrak yoksa eskisi gibi target live, git yok", async () => {
        await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--target", "live", "--json"], handler({ version: { target: "live", live: true } }), GH);
        expect(calls.find((c) => c.path === "/v1/publish")!.body).toMatchObject({ target: "live", git: { branch: "feature/login" } });
        calls = [];
        await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--json"], handler({ version: { target: "live", live: true, git: null } }));
        const body = calls.find((c) => c.path === "/v1/publish")!.body;
        expect(body.target).toBe("live");
        expect(body.git).toBeUndefined();
        expect(calls.some((c) => c.path.endsWith("/branches"))).toBe(false);
    });

    test("--branch/--commit her yerde; geçersizse ağa gitmez; hesapsız yayında reddedilir", async () => {
        const r = await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--branch", "feature/login", "--commit", SHA.slice(0, 7), "--json"], handler());
        expect(r.code).toBe(0);
        expect(calls.find((c) => c.path === "/v1/publish")!.body.git).toEqual({ branch: "feature/login", commit: SHA.slice(0, 7) });
        calls = [];
        expect((await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--branch", "bad..branch", "--json"], handler())).code).toBe(2);
        expect((await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--branch", "x", "--commit", "zz", "--json"], handler())).code).toBe(2);
        const anon = await cli(["publish", dir, "--cwd", dir, "--branch", "feature/login", "--json"], handler(), { PERAFLY_TOKEN: "" });
        expect(anon.code).toBe(2);
        expect(anon.err.error.message).toContain("needs an account");
        expect(calls).toHaveLength(0);
    });

    test("sunucu branchUrl null verirse (canlı ya da üretim dalı) dal adresi yazılmaz, tahmin edilmez", async () => {
        const branchMain = { trigger: "ci", branch: "main", commit: { sha: SHA, message: "", author: "" }, pullRequest: null, branchUrl: null };
        const live = await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--json"], handler({ version: { target: "live", live: true, git: branchMain } }), { ...GH, GITHUB_REF_NAME: "main" });
        expect(live.code).toBe(0);
        expect(live.json.data.branchUrl).toBeUndefined();
        // Üretim dalı önizlemesi (otomatik canlı kapalı): sürüm önizleme ama dal adresi bağlanmamış
        const preview = await cli(["publish", dir, "--cwd", dir, "--project", "acme-site"], handler({ version: { git: branchMain } }), { ...GH, GITHUB_REF_NAME: "main" });
        expect(preview.code).toBe(0);
        expect(preview.stdout).toContain("Preview ready: https://acme-site--v12.perafly.app");
        expect(preview.stdout).not.toContain("Branch URL");
        expect(preview.stdout).not.toContain("--br-");
        expect(calls.some((c) => c.path.endsWith("/branches"))).toBe(false);
    });

    test("ileti ve yazar ortamda yoksa CI'ın çektiği depodaki işlemeden", async () => {
        git(["init", "-q"], dir);
        git(["add", "index.html"], dir);
        execFileSync("git", ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Add login form\n\nbody"], { cwd: dir });
        const sha = git(["rev-parse", "HEAD"], dir);
        await cli(["publish", dir, "--cwd", dir, "--project", "acme-site", "--json"], handler(), { ...GH, GITHUB_SHA: sha });
        expect(calls.find((c) => c.path === "/v1/publish")!.body.git).toEqual({ branch: "feature/login", commit: sha, message: "Add login form", author: "Ada Lovelace" });
    });
});

describe("git status, set, builds, approve, disconnect, branches", () => {
    test("durum: bağlantı, üretim dalı, itme adresi ve son 5 derleme; --json { git, builds }; bağlı değilse söyler", async () => {
        const rows = [BUILD(), BUILD({ id: "gbd_2", status: "awaiting_approval", fork: true, branch: "pr-7", branchUrl: null, version: null }), ...Array.from({ length: 5 }, (_, i) => BUILD({ id: `gbd_${i + 3}` }))];
        const h: Handler = (c) => (c.path === "/v1/projects/acme-site/git" ? { status: 200, json: GIT() } : c.path === "/v1/projects/acme-site/git/builds" ? { status: 200, json: { data: rows } } : undefined);
        const r = await cli(["git", "status", "--project", "acme-site"], h);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("acme/site (installation acme)");
        expect(r.stdout).toMatch(/Production\s+main → live/);
        expect(r.stdout).toContain(PUSH);
        expect(r.stdout).toMatch(/gbd_1\s+succeeded\s+feature\/login\s+9f2c1a2\s+Add login form\s+v12\s+https:\/\/acme-site--br-feature-login\.perafly\.app/);
        expect(r.stdout).toContain("needs approval");
        expect(r.stdout).toContain("perafly git approve gbd_2");
        expect(r.stdout).not.toContain("gbd_6");
        const bare = await cli(["git", "--project", "acme-site", "--json"], h);
        expect(bare.json.data.git).toEqual(GIT());
        expect(bare.json.data.builds).toHaveLength(5);
        const off = await cli(["git", "--project", "acme-site"], (c) => (c.path.endsWith("/git") ? { status: 200, json: GIT({ github: null, autoDeployProduction: false }) } : { status: 200, json: { data: [] } }));
        expect(off.stdout).toContain("Not connected");
        expect(off.stdout).toContain("automatic live deploys off");
        expect(off.stdout).toContain("No builds yet");
    });

    test("set: bayraklar gövdeye (--installation tamsayı, yalnız --repository ile); bayraksız ya da geçersiz değer ağa gitmez", async () => {
        const r = await cli(["git", "set", "--production-branch", "release", "--auto-production", "off", "--auto-previews", "on", "--repository", "acme/site", "--project", "acme-site", "--json"], (c) => (c.method === "PUT" ? { status: 200, json: GIT({ productionBranch: "release" }) } : undefined));
        expect(r.code).toBe(0);
        expect([calls[0]!.method, calls[0]!.path]).toEqual(["PUT", "/v1/projects/acme-site/git"]);
        expect(calls[0]!.body).toEqual({ productionBranch: "release", autoDeployProduction: false, autoDeployPreviews: true, repository: "acme/site" });
        calls = [];
        const inst = await cli(["git", "set", "--repository", "acme/site", "--installation", "4823", "--project", "acme-site", "--json"], (c) => (c.method === "PUT" ? { status: 200, json: GIT() } : undefined));
        expect(inst.code).toBe(0);
        expect(calls[0]!.body).toEqual({ repository: "acme/site", installation: 4823 });
        calls = [];
        for (const bad of ["0", "-1", "12.5", "abc", "99999999999999999999"]) {
            const r = await cli(["git", "set", "--repository", "acme/site", "--installation", bad, "--project", "acme-site", "--json"], () => undefined);
            expect([bad, r.code, r.err?.error?.code]).toEqual([bad, 2, "validation_error"]);
        }
        // Sunucu kurulumu yalnız depo bağlanırken kullanır: tek başına sessizce yok sayılmasın
        expect((await cli(["git", "set", "--installation", "4823", "--project", "acme-site"], () => undefined)).code).toBe(2);
        expect((await cli(["git", "set", "--project", "acme-site"], () => undefined)).code).toBe(2);
        expect((await cli(["git", "set", "--production-branch", "a..b", "--project", "acme-site"], () => undefined)).code).toBe(2);
        expect((await cli(["git", "set", "--repository", "not a repo", "--project", "acme-site"], () => undefined)).code).toBe(2);
        expect(calls).toHaveLength(0);
    });

    test("approve: uyarı her kipte; ajan kipinde PERAFLY_YES yetmez, açık --yes gerekir", async () => {
        const h: Handler = (c) => (c.method === "POST" ? { status: 200, json: BUILD({ id: "gbd_2", status: "queued", fork: true, branch: "pr-7" }) } : undefined);
        const agent = await cli(["git", "approve", "gbd_2", "--project", "acme-site"], h, { PERAFLY_AGENT: "1" });
        expect(agent.code).toBe(2);
        expect(agent.err.error.code).toBe("confirmation_required");
        expect(agent.stderr).toContain("environment variables");
        const envYes = await cli(["git", "approve", "gbd_2", "--project", "acme-site"], h, { PERAFLY_AGENT: "1", PERAFLY_YES: "1" });
        expect(envYes.code).toBe(2);
        const plain = await cli(["git", "approve", "gbd_2", "--project", "acme-site"], h);
        expect(plain.code).toBe(2);
        expect(calls).toHaveLength(0);
        expect((await cli(["git", "approve", "ver_1", "--project", "acme-site", "--yes"], h)).code).toBe(2);
        expect(calls).toHaveLength(0);
        const yes = await cli(["git", "approve", "gbd_2", "--project", "acme-site", "--yes"], h, { PERAFLY_AGENT: "1" });
        expect(yes.code).toBe(0);
        expect([calls[0]!.method, calls[0]!.path]).toEqual(["POST", "/v1/projects/acme-site/git/builds/gbd_2/approve"]);
        expect(yes.json.data.status).toBe("queued");
        const notWaiting = await cli(["git", "approve", "gbd_1", "--project", "acme-site", "--yes", "--json"], () => ({ status: 409, json: { status: 409, code: "git_build_not_awaiting", title: "Conflict", detail: "The build is not waiting for approval" } }));
        expect(notWaiting.code).toBe(30);
        expect(notWaiting.err.error.code).toBe("git_build_not_awaiting");
    });

    test("disconnect onay ister; builds --status sorguya; branches listesi", async () => {
        const noYes = await cli(["git", "disconnect", "--project", "acme-site"], () => ({ status: 204 }), { PERAFLY_AGENT: "1" });
        expect(noYes.code).toBe(2);
        expect(calls).toHaveLength(0);
        const yes = await cli(["git", "disconnect", "--project", "acme-site", "--yes", "--json"], () => ({ status: 204 }));
        expect(yes.code).toBe(0);
        expect([calls[0]!.method, calls[0]!.path]).toEqual(["DELETE", "/v1/projects/acme-site/git"]);
        calls = [];
        const b = await cli(["git", "builds", "--status", "awaiting_approval", "--project", "acme-site", "--json"], () => ({ status: 200, json: { data: [BUILD({ status: "awaiting_approval" })] } }));
        expect(calls[0]!.query.get("status")).toBe("awaiting_approval");
        expect(b.json).toEqual({ data: [BUILD({ status: "awaiting_approval" })], pagination: { nextCursor: null } });
        const br = await cli(["branches", "--project", "acme-site"], () => ({ status: 200, json: { data: [{ branch: "feature/login", slug: "feature-login", url: "https://acme-site--br-feature-login.perafly.app", version: { id: VER, number: 12 }, pullRequest: 7, updatedAt: "2026-11-14T10:00:00Z" }] } }));
        expect(br.stdout).toMatch(/feature\/login\s+https:\/\/acme-site--br-feature-login\.perafly\.app\s+v12\s+#7\s+2026-11-14 10:00/);
        const empty = await cli(["branches", "--project", "acme-site"], () => ({ status: 200, json: { data: [] } }));
        expect(empty.stdout).toContain("No branch previews yet");
    });
});

describe("yerel MCP: Faz 10 araçları", () => {
    test("bağlamak, kesmek ve çatal onayı araç değildir; okuma araçları projects.read ile", async () => {
        for (const op of ["setProjectGit", "disconnectProjectGit", "approveGitBuild"]) {
            expect([op, HIDDEN_OPERATIONS.has(op)]).toEqual([op, true]);
            expect(operationSpecs().map((s) => s.operationId)).not.toContain(op);
        }
        expect(OPERATION_PERMISSION).toMatchObject({ getProjectGit: "projects.read", listGitBuilds: "projects.read", listProjectBranches: "projects.read" });
        const builds = operationSpecs().find((s) => s.operationId === "listGitBuilds")!;
        expect(builds.queryParams).toEqual(["status"]);
        const h = createLocalHandlers({ root: dir, flags: { apiUrl: API }, deps: { env: { PERAFLY_HOME: home, PERAFLY_TOKEN: KEY, PERAFLY_CREDENTIAL_STORE: "plaintext" }, fetch: fakeFetch((c) => (c.path === "/v1/me" ? { status: 200, json: { permissions: ["projects.read", "projects.write", "publish.write"] } } : undefined)) } });
        const names = (await h.listTools()).map((t: any) => t.name);
        expect(names).toEqual(expect.arrayContaining(["getProjectGit", "listGitBuilds", "listProjectBranches"]));
        for (const op of ["setProjectGit", "disconnectProjectGit", "approveGitBuild"]) expect(names).not.toContain(op);
    });
});

describe("dal adı ve işleme kuralları: backend ile eşlik", () => {
    test("isValidBranch backend app/src/git/rules.ts ile aynı sonuçları verir; işleme 7–64 onaltılık", () => {
        // Beklenen değerler backend isValidBranch'ından üretildi (14 Kasım 2026)
        const valid: [string, boolean][] = [["main", true], ["feature/x", true], ["a..b", false], ["a b", false], ["-a", false], ["a.lock", false], ["a/", false], ["@", false], ["x~1", false], ["ok/.hidden", false], ["refs/heads/x", true]];
        for (const [b, ok] of valid) expect([b, isValidBranch(b)]).toEqual([b, ok]);
        expect(isValidBranch("a".repeat(256))).toBe(false);
        expect([isCommitSha("abcdef1"), isCommitSha(SHA), isCommitSha("abc"), isCommitSha("g".repeat(7)), isCommitSha("a".repeat(65))]).toEqual([true, true, false, false, false]);
    });
});
