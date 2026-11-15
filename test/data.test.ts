/**
 * Faz 9: veri katmanı, ortam değişkenleri, depolama ve SFTP komutları sahte fetch ile (gerçek ağ ve anahtar zinciri
 * yok): süzgeç sorgusu, sırların insan çıktısında bir kez görünüp `--json`'da karartılması, değerin argümandan
 * alınmaması, onaylar (ajan kipi `--yes` sayılmaz), iki adımlı yükleme ve imzalı adresin hiçbir çıktıya girmemesi,
 * plan sınırı iletileri, yerel MCP sınıflandırması.
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { ApiClient } from "../src/api/client.js";
import { setKeyringLoaderForTests } from "../src/auth/store.js";
import { parseFilters } from "../src/commands/data.js";
import { createLocalHandlers } from "../src/mcp/server.js";
import { HIDDEN_OPERATIONS, OPERATION_PERMISSION, operationSpecs } from "../src/mcp/tools.js";

const API = "https://api.perafly.test";
const KEY = `pfa_${"A1b2C3d4".repeat(4)}`;
const PFK = `pfk_${"K9j8H7g6".repeat(5)}`;
const PFP = `pfp_${"P5o4I3u2".repeat(4)}`;
const PFS = `pfs_${"S1d2F3g4".repeat(4)}`;
const UPLOAD_TOKEN = "eyJwIjoicHJqIn0.c2lnbmF0dXJlLXVwbG9hZA";
const DOWNLOAD_TOKEN = "eyJwIjoiZmlsZSJ9.c2lnbmF0dXJlLWRvd25sb2Fk";

class Sink extends Writable {
    text = "";
    isTTY = false;
    override _write(chunk: any, _e: string, cb: () => void) {
        this.text += chunk.toString();
        cb();
    }
}

interface Call { method: string; path: string; query: URLSearchParams; auth: string | null; headers: Record<string, string>; body: any }
type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | undefined;
type Handler = (c: Call) => Reply;

let home: string;
let dir: string;
let calls: Call[];
const savedHome = process.env.PERAFLY_HOME;

const fakeFetch = (handler: Handler) => (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    let body: any = init.body;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof Uint8Array) body = Buffer.from(body);
    else if (body && typeof body.getReader === "function") body = Buffer.from(await new Response(body).arrayBuffer());
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init.method ?? "GET", path: url.pathname + url.search, query: url.searchParams, auth: headers.Authorization ?? null, headers, body };
    calls.push(call);
    const r = handler(call);
    if (!r) return new Response(JSON.stringify({ status: 404, code: "not_found", title: "Not found" }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    if (r.status === 204) return new Response(null, { status: 204 });
    if (r.text !== undefined) return new Response(r.text, { status: r.status, headers: r.headers });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: { "Content-Type": r.status >= 400 ? "application/problem+json" : "application/json" } });
}) as typeof fetch;

const cli = async (argv: string[], handler: Handler, env: Record<string, string> = {}, stdinText?: string, stdinTTY = false) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const stdin = Object.assign(Readable.from(stdinText !== undefined ? [Buffer.from(stdinText)] : []), { isTTY: stdinTTY }) as any;
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

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pf-home-"));
    process.env.PERAFLY_HOME = home;
    dir = await mkdtemp(join(tmpdir(), "pf-data-"));
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

describe("data: koleksiyonlar ve kayıtlar", () => {
    const COLLECTION = { id: "col_1", name: "posts", fields: [{ name: "title", type: "text", required: true, indexed: true }, { name: "status", type: "select", indexed: true, options: ["draft", "published"] }], rules: { read: "public", create: "secret", update: "secret", delete: "secret" }, hook: null, recordCount: 2 };
    const rec = (over: Record<string, unknown> = {}) => ({ id: "rec_1", createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:00:00Z", title: "Hello", status: "published", ...over });

    test("süzgeçler: alan=değer → filter[alan], alan:op=değer → filter[alan][op]; sıralama ve sayfa sorguya gider", async () => {
        const r = await cli(["data", "ls", "posts", "--project", "acme", "--filter", "status=published", "--filter", "price:gte=10", "--filter", "price:lte=20", "--filter", "tag:in=a,b", "--sort", "-createdAt", "--limit", "5"],
            (c) => (c.path.startsWith("/v1/projects/acme/data/posts") ? { status: 200, json: { data: [rec(), rec({ id: "rec_2", title: "Evil \u001b[31mred\u001b[0m" })], nextCursor: "c2" } } : undefined));
        expect(r.code).toBe(0);
        const q = calls[0]!.query;
        expect([q.get("filter[status]"), q.get("filter[price][gte]"), q.get("filter[price][lte]"), q.get("filter[tag][in]"), q.get("sort"), q.get("limit")]).toEqual(["published", "10", "20", "a,b", "-createdAt", "5"]);
        expect(r.stdout).toMatch(/ID\s+TITLE\s+STATUS\s+CREATED/);
        expect(r.stdout).toContain("More: --cursor c2");
        // Ziyaretçinin yazdığı değer terminal kaçış dizisi taşımaz
        expect(r.stdout).not.toContain("\u001b");
        const json = await cli(["data", "ls", "posts", "--project", "acme", "--json"], () => ({ status: 200, json: { data: [rec()], nextCursor: null } }));
        expect(json.json).toEqual({ data: [rec()], pagination: { nextCursor: null } });
    });

    test("süzgeç ayrıştırma: aynı alanda düz değer eq olur; hatalı süzgeç ve işleç ağa gitmez", async () => {
        expect(parseFilters(["a=1", "b:gt=2", "b=3"])).toEqual({ a: "1", b: { gt: "2", eq: "3" } });
        expect(parseFilters(["constructor:eq=1"])).toEqual({ constructor: { eq: "1" } });
        expect((await cli(["data", "ls", "posts", "--project", "acme", "--filter", "nope"], () => undefined)).code).toBe(2);
        expect((await cli(["data", "ls", "posts", "--project", "acme", "--filter", "price:like=1"], () => undefined)).code).toBe(2);
        expect((await cli(["data", "ls", "posts", "--project", "acme", "--limit", "500"], () => undefined)).code).toBe(2);
        expect(calls).toHaveLength(0);
    });

    test("koleksiyon: şema dosyadan (yalnız fields/rules/hook gider), Idempotency-Key; liste ve gösterim; silme onay ister", async () => {
        await writeFile(join(dir, "schema.json"), JSON.stringify({ $schema: "x", name: "ignored", fields: COLLECTION.fields, rules: COLLECTION.rules }));
        const created = await cli(["data", "collections", "create", "posts", "--schema", "schema.json", "--project", "acme", "--cwd", dir], () => ({ status: 201, json: COLLECTION }));
        expect(created.code).toBe(0);
        expect([calls[0]!.method, calls[0]!.path]).toEqual(["POST", "/v1/projects/acme/collections"]);
        expect(calls[0]!.body).toEqual({ name: "posts", fields: COLLECTION.fields, rules: COLLECTION.rules });
        expect(calls[0]!.headers["Idempotency-Key"]).toBeTruthy();
        const fromStdin = await cli(["data", "collections", "create", "notes", "--schema", "-", "--project", "acme"], () => ({ status: 201, json: { ...COLLECTION, name: "notes" } }), {}, JSON.stringify([{ name: "body", type: "text" }]));
        expect(fromStdin.code).toBe(0);
        expect(calls.at(-1)!.body).toEqual({ name: "notes", fields: [{ name: "body", type: "text" }] });
        expect((await cli(["data", "collections", "create", "Bad Name", "--schema", "-", "--project", "acme"], () => undefined, {}, "[]")).code).toBe(2);

        const ls = await cli(["data", "collections", "--project", "acme"], () => ({ status: 200, json: { data: [COLLECTION] } }));
        expect(ls.stdout).toMatch(/posts\s+2\s+2\s+read public · create secret/);
        const show = await cli(["data", "collections", "show", "posts", "--project", "acme"], () => ({ status: 200, json: COLLECTION }));
        expect(show.stdout).toMatch(/status\s+select\s+no\s+yes\s+draft, published/);

        calls = [];
        const noYes = await cli(["data", "collections", "rm", "posts", "--project", "acme"], () => ({ status: 204 }), { PERAFLY_AGENT: "1" });
        expect(noYes.code).toBe(2);
        expect(noYes.err.error.code).toBe("confirmation_required");
        expect(calls).toHaveLength(0);
        await cli(["data", "collections", "rm", "posts", "--project", "acme", "--yes"], () => ({ status: 204 }));
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", "/v1/projects/acme/collections/posts"]);
    });

    test("kayıt: JSON stdin'den ya da dosyadan; terminalde dosya yoksa ne beklendiği söylenir; silme onay ister", async () => {
        const add = await cli(["data", "add", "posts", "--project", "acme", "--json"], () => ({ status: 201, json: rec() }), {}, '{"title":"Hello"}\n');
        expect(add.code).toBe(0);
        expect([calls[0]!.method, calls[0]!.path, calls[0]!.body]).toEqual(["POST", "/v1/projects/acme/data/posts", { title: "Hello" }]);
        expect(add.json.data.id).toBe("rec_1");
        await writeFile(join(dir, "patch.json"), '{"status":null}');
        await cli(["data", "update", "posts", "rec_1", "--file", "patch.json", "--project", "acme", "--cwd", dir], () => ({ status: 200, json: rec() }));
        expect([calls.at(-1)!.method, calls.at(-1)!.path, calls.at(-1)!.body]).toEqual(["PATCH", "/v1/projects/acme/data/posts/rec_1", { status: null }]);
        calls = [];
        const tty = await cli(["data", "add", "posts", "--project", "acme"], () => undefined, {}, undefined, true);
        expect(tty.code).toBe(2);
        expect(tty.stderr).toContain("--file <file>");
        expect((await cli(["data", "add", "posts", "--project", "acme"], () => undefined, {}, "[1,2]")).code).toBe(2);
        expect((await cli(["data", "add", "posts", "--project", "acme"], () => undefined, {}, "{oops")).code).toBe(2);
        expect((await cli(["data", "rm", "posts", "rec_1", "--project", "acme"], () => ({ status: 204 }))).code).toBe(2);
        expect(calls).toHaveLength(0);
        await cli(["data", "rm", "posts", "rec_1", "--project", "acme", "--yes"], () => ({ status: 204 }));
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", "/v1/projects/acme/data/posts/rec_1"]);
    });

    test("dışa aktarma: dosyaya (0600) ya da stdout'a akar; --json --out ister", async () => {
        const CSV = "id,title\nrec_1,Hello\n";
        const handler: Handler = (c) => (c.path.startsWith("/v1/projects/acme/collections/posts/export") ? { status: 200, text: CSV, headers: { "Content-Type": "text/csv" } } : undefined);
        const toFile = await cli(["data", "export", "posts", "--out", "posts.csv", "--project", "acme", "--cwd", dir], handler);
        expect(toFile.code).toBe(0);
        expect(calls[0]!.query.get("format")).toBe("csv");
        expect(await readFile(join(dir, "posts.csv"), "utf8")).toBe(CSV);
        expect((await stat(join(dir, "posts.csv"))).mode & 0o777).toBe(0o600);
        const toStdout = await cli(["data", "export", "posts", "--format", "json", "--project", "acme"], () => ({ status: 200, text: "[]" }));
        expect(toStdout.stdout).toBe("[]");
        expect(calls.at(-1)!.query.get("format")).toBe("json");
        calls = [];
        expect((await cli(["data", "export", "posts", "--project", "acme", "--json"], handler)).code).toBe(2);
        expect(calls).toHaveLength(0);
    });
});

describe("data keys", () => {
    const KEYS = { publishable: { key: PFP, createdAt: "2026-11-14T10:00:00Z" }, secret: { prefix: "pfk_K9j8", createdAt: "2026-11-14T10:00:00Z", createdBy: { name: "Ada" } }, webhook: null };

    test("yayınlanabilir anahtar sır değildir: --json'da görünür", async () => {
        const r = await cli(["data", "keys", "--project", "acme", "--json"], (c) => (c.path === "/v1/projects/acme/data-keys" ? { status: 200, json: KEYS } : undefined));
        expect(r.code).toBe(0);
        expect(r.json.data.publishable.key).toBe(PFP);
        const human = await cli(["data", "keys", "--project", "acme"], () => ({ status: 200, json: KEYS }));
        expect(human.stdout).toContain(PFP);
        expect(human.stdout).toContain("pfk_K9j8…");
    });

    test("gizli anahtar insan çıktısında bir kez görünür; --json ve ajan kipi istek atılmadan reddedilir; var olanı değiştirmek onay ister", async () => {
        const handler: Handler = (c) => {
            if (c.method === "GET" && c.path === "/v1/projects/acme/data-keys") return { status: 200, json: KEYS };
            if (c.method === "POST" && c.path === "/v1/projects/acme/data-keys/secret") return { status: 201, json: { secret: PFK, keys: KEYS } };
            return undefined;
        };
        for (const [argv, env] of [[["--json", "--yes"], {}], [["--yes"], { PERAFLY_AGENT: "1" }]] as const) {
            const refused = await cli(["data", "keys", "--create-secret", "--project", "acme", ...argv], handler, env);
            expect(refused.code).toBe(2);
            expect(refused.err.error).toMatchObject({ code: "validation_error" });
            expect(refused.err.error.message).toContain("never in --json output");
        }
        expect(calls).toHaveLength(0);

        // Var olanı değiştirmek onay ister (etkileşimsiz kipte --yes olmadan düşer, POST gitmez)
        const noYes = await cli(["data", "keys", "--create-secret", "--project", "acme"], handler);
        expect(noYes.code).toBe(2);
        expect(noYes.stderr).toContain("needs confirmation");
        expect(calls.map((c) => c.method)).toEqual(["GET"]);

        const human = await cli(["data", "keys", "--create-secret", "--project", "acme", "--yes"], handler);
        expect(human.code).toBe(0);
        expect(occurrences(human.stdout, PFK)).toBe(1);
        expect(human.stderr).not.toContain(PFK);

        // İlk gizli anahtar hiçbir şeyi değiştirmez: onay gerekmez
        calls = [];
        const first = await cli(["data", "keys", "--create-secret", "--project", "acme"], (c) => (c.method === "GET" ? { status: 200, json: { ...KEYS, secret: null } } : { status: 201, json: { secret: PFK, keys: KEYS } }));
        expect(first.code).toBe(0);
        expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
        expect(occurrences(first.stdout, PFK)).toBe(1);
    });

    test("yayınlanabilir anahtarı yenilemek ve gizliyi iptal etmek onay ister; iki bayrak birlikte verilmez", async () => {
        expect((await cli(["data", "keys", "--rotate-publishable", "--project", "acme"], () => ({ status: 200, json: KEYS }), { PERAFLY_AGENT: "1" })).code).toBe(2);
        expect((await cli(["data", "keys", "--revoke-secret", "--project", "acme"], () => ({ status: 200, json: KEYS }))).code).toBe(2);
        expect((await cli(["data", "keys", "--revoke-secret", "--rotate-publishable", "--project", "acme", "--yes"], () => undefined)).code).toBe(2);
        expect(calls).toHaveLength(0);
        await cli(["data", "keys", "--rotate-publishable", "--project", "acme", "--yes"], () => ({ status: 200, json: KEYS }));
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["POST", "/v1/projects/acme/data-keys/publishable"]);
        await cli(["data", "keys", "--revoke-secret", "--project", "acme", "--yes"], () => ({ status: 200, json: { ...KEYS, secret: null } }));
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", "/v1/projects/acme/data-keys/secret"]);
    });
});

describe("env", () => {
    test("değer stdin'den; çıktıda yok; --plain sensitive: false; sonraki sürüm notu", async () => {
        const SECRET = "postgres://user:hunter2@db/x";
        const r = await cli(["env", "set", "DATABASE_URL", "--project", "acme"], () => ({ status: 201, json: { key: "DATABASE_URL", value: null, sensitive: true, system: false } }), {}, `${SECRET}\n`);
        expect(r.code).toBe(0);
        expect([calls[0]!.method, calls[0]!.path, calls[0]!.body]).toEqual(["PUT", "/v1/projects/acme/env/DATABASE_URL", { value: SECRET, sensitive: true }]);
        expect(r.stdout + r.stderr).not.toContain("hunter2");
        expect(r.stdout).toContain("next version");
        await cli(["env", "set", "SITE_NAME", "--plain", "--project", "acme", "--json"], () => ({ status: 200, json: { key: "SITE_NAME", value: "Acme", sensitive: false, system: false } }), {}, "Acme");
        expect(calls.at(-1)!.body).toEqual({ value: "Acme", sensitive: false });
    });

    test("değerin boşlukları korunur: borudan gelende yalnız sondaki satır sonu atılır", async () => {
        const handler: Handler = () => ({ status: 200, json: { key: "K", value: null, sensitive: true, system: false } });
        await cli(["env", "set", "PADDED", "--project", "acme"], handler, {}, "  two  spaces\tand tab  \n");
        expect(calls.at(-1)!.body).toEqual({ value: "  two  spaces\tand tab  ", sensitive: true });
        await cli(["env", "set", "MULTILINE", "--project", "acme"], handler, {}, "line one\nline two\n\n");
        expect(calls.at(-1)!.body.value).toBe("line one\nline two\n");
        await cli(["env", "set", "CRLF", "--project", "acme"], handler, {}, " value \r\n");
        expect(calls.at(-1)!.body.value).toBe(" value ");
    });

    test("değer asla argümandan alınmaz: fazladan argüman ve AD=değer ağa gitmeden düşer", async () => {
        const extra = await cli(["env", "set", "API_TOKEN", "hunter2", "--project", "acme"], () => ({ status: 200, json: {} }));
        expect(extra.code).toBe(2);
        const assign = await cli(["env", "set", "API_TOKEN=hunter2", "--project", "acme"], () => ({ status: 200, json: {} }));
        expect(assign.code).toBe(2);
        expect(assign.stderr).toContain("stdin");
        expect(assign.stderr).not.toContain("hunter2");
        const empty = await cli(["env", "set", "API_TOKEN", "--project", "acme"], () => ({ status: 200, json: {} }), {}, "");
        expect(empty.code).toBe(2);
        expect(calls).toHaveLength(0);
    });

    test("liste gizli değeri göstermez; rm onay ister (ajan kipi --yes sayılmaz)", async () => {
        const LIST = { data: [{ key: "DATABASE_URL", value: null, sensitive: true, system: false, updatedAt: "2026-11-14T10:00:00Z", updatedBy: { kind: "user", name: "Ada" } }, { key: "PERAFLY_PUBLISHABLE_KEY", value: PFP, sensitive: false, system: true }], appliesTo: "next-version" };
        const ls = await cli(["env", "ls", "--project", "acme"], () => ({ status: 200, json: LIST }));
        expect(ls.stdout).toMatch(/DATABASE_URL\s+\(hidden\)\s+sensitive/);
        expect(ls.stdout).toContain("next version");
        const json = await cli(["env", "ls", "--project", "acme", "--json"], () => ({ status: 200, json: LIST }));
        expect(json.json).toMatchObject({ data: LIST.data, appliesTo: "next-version" });
        calls = [];
        expect((await cli(["env", "rm", "DATABASE_URL", "--project", "acme"], () => ({ status: 204 }), { PERAFLY_AGENT: "1" })).code).toBe(2);
        expect(calls).toHaveLength(0);
        await cli(["env", "rm", "DATABASE_URL", "--project", "acme", "--yes"], () => ({ status: 204 }));
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", "/v1/projects/acme/env/DATABASE_URL"]);
    });
});

describe("storage", () => {
    const UPLOAD_URL = `${API}/v1/storage-uploads/${UPLOAD_TOKEN}`;
    const object = (path: string, size: number) => ({ path, size, contentType: "image/jpeg", url: path.startsWith("public/") ? `https://acme.perafly.app/_files/${path.slice(7)}` : null, updatedAt: "2026-11-14T10:00:00Z", updatedBy: { kind: "apiKey", name: "CLI" } });

    test("put: iki istek (createStorageUpload, imzalı adrese PUT); yükleme adresi hiçbir çıktıda yok", async () => {
        await writeFile(join(dir, "hero.jpg"), Buffer.from([1, 2, 3, 4, 5]));
        const handler: Handler = (c) => {
            if (c.method === "POST" && c.path === "/v1/projects/acme/storage/uploads") return { status: 201, json: { uploadUrl: UPLOAD_URL, method: "PUT", expiresAt: "x" } };
            if (c.method === "PUT" && c.path.startsWith("/v1/storage-uploads/")) return { status: 200, json: object(`public/images/hero.jpg`, 5) };
            return undefined;
        };
        for (const json of [false, true]) {
            calls = [];
            const r = await cli(["storage", "put", "hero.jpg", "public/images/", "--project", "acme", "--cwd", dir, ...(json ? ["--json"] : [])], handler);
            expect(r.code).toBe(0);
            expect(calls.map((c) => c.method)).toEqual(["POST", "PUT"]);
            expect(calls[0]!.body).toEqual({ path: "public/images/hero.jpg", size: 5 });
            expect(calls[1]!.auth).toBeNull();
            expect([...calls[1]!.body]).toEqual([1, 2, 3, 4, 5]);
            expect(r.stdout + r.stderr).not.toContain(UPLOAD_TOKEN);
            if (json) expect(r.json.data.path).toBe("public/images/hero.jpg");
            else expect(r.stdout).toContain("Public address: https://acme.perafly.app/_files/images/hero.jpg");
        }
    });

    test("put: dışlanan dosya, klasör ve geçersiz uzak yol ağa gitmez", async () => {
        await writeFile(join(dir, ".env"), "SECRET=1");
        await writeFile(join(dir, "id_ed25519"), "x");
        await writeFile(join(dir, "a.txt"), "a");
        await mkdir(join(dir, "folder"));
        expect((await cli(["storage", "put", ".env", "private/.env", "--project", "acme", "--cwd", dir], () => undefined)).code).toBe(2);
        expect((await cli(["storage", "put", "id_ed25519", "private/k", "--project", "acme", "--cwd", dir], () => undefined)).code).toBe(2);
        expect((await cli(["storage", "put", "folder", "public/f", "--project", "acme", "--cwd", dir], () => undefined)).code).toBe(2);
        expect((await cli(["storage", "put", "a.txt", "images/a.txt", "--project", "acme", "--cwd", dir], () => undefined)).code).toBe(2);
        expect(calls).toHaveLength(0);
    });

    test("get: dosya bilgisi, sonra imzalı adresten kimliksiz indirme; indirme adresi çıktıda yok", async () => {
        const handler: Handler = (c) => {
            if (c.path.startsWith("/v1/projects/acme/storage/file")) return { status: 200, json: { ...object("private/exports/nov.csv", 6), downloadUrl: `${API}/v1/storage-files/${DOWNLOAD_TOKEN}`, downloadExpiresAt: "x" } };
            if (c.path.startsWith("/v1/storage-files/")) return { status: 200, text: "a,b\n1," };
            return undefined;
        };
        for (const json of [false, true]) {
            calls = [];
            const r = await cli(["storage", "get", "private/exports/nov.csv", "--project", "acme", "--cwd", dir, ...(json ? ["--json"] : [])], handler);
            expect(r.code).toBe(0);
            expect(calls[0]!.query.get("path")).toBe("private/exports/nov.csv");
            expect(calls[1]!.auth).toBeNull();
            expect(await readFile(join(dir, "nov.csv"), "utf8")).toBe("a,b\n1,");
            expect(r.stdout + r.stderr).not.toContain(DOWNLOAD_TOKEN);
            if (json) {
                expect(r.json.data).not.toHaveProperty("downloadUrl");
                expect(r.json.data.bytes).toBe(6);
            }
        }
    });

    test("ls: klasörler ve okunur boyutlar; rm: sondaki / klasörü siler, onay ister; mv gövdesi", async () => {
        const ls = await cli(["storage", "ls", "public/images", "--project", "acme"], () => ({ status: 200, json: { data: [object("public/images/hero.jpg", 1536)], folders: ["public/images/thumbs/"], nextCursor: null, usage: { bytes: 3 * 1024 * 1024, limit: 500 * 1024 * 1024 } } }));
        expect(ls.code).toBe(0);
        expect(calls[0]!.query.get("prefix")).toBe("public/images/");
        expect(ls.stdout).toMatch(/thumbs\/\s+—/);
        expect(ls.stdout).toMatch(/hero\.jpg\s+1\.5 KB/);
        expect(ls.stdout).toContain("3.0 MB of 500.0 MB");
        await cli(["storage", "ls", "public/", "--limit", "1000", "--project", "acme"], () => ({ status: 200, json: { data: [], folders: [], nextCursor: null } }));
        expect(calls.at(-1)!.query.get("limit")).toBe("1000");
        calls = [];
        expect((await cli(["storage", "ls", "public/", "--limit", "1001", "--project", "acme"], () => undefined)).code).toBe(2);
        expect((await cli(["storage", "rm", "public/images/", "--project", "acme"], () => ({ status: 200, json: { deleted: 2 } }), { PERAFLY_AGENT: "1" })).code).toBe(2);
        expect(calls).toHaveLength(0);
        await cli(["storage", "rm", "public/images/", "--project", "acme", "--yes"], () => ({ status: 200, json: { deleted: 2 } }));
        expect([calls.at(-1)!.method, calls.at(-1)!.query.get("prefix"), calls.at(-1)!.query.get("path")]).toEqual(["DELETE", "public/images/", null]);
        await cli(["storage", "rm", "public/images/hero.jpg", "--project", "acme", "--yes"], () => ({ status: 200, json: { deleted: 1 } }));
        expect([calls.at(-1)!.query.get("path"), calls.at(-1)!.query.get("prefix")]).toEqual(["public/images/hero.jpg", null]);
        await cli(["storage", "mv", "public/old/", "public/new", "--overwrite", "--project", "acme"], () => ({ status: 200, json: { moved: 3 } }));
        expect([calls.at(-1)!.path, calls.at(-1)!.body]).toEqual(["/v1/projects/acme/storage/move", { from: "public/old/", to: "public/new/", overwrite: true }]);
    });

    test("sync: eksik ve boyutu farklı dosyalar yüklenir, aynılar ve dışlananlar atlanır; --dry-run yüklemez; hiçbir şey silinmez", async () => {
        const media = join(dir, "media");
        await mkdir(join(media, "sub"), { recursive: true });
        await writeFile(join(media, "same.txt"), "abc");
        await writeFile(join(media, "changed.txt"), "abcd");
        await writeFile(join(media, "sub", "new.txt"), "n");
        await writeFile(join(media, ".env"), "SECRET=1");
        const remote: Handler = (c) => {
            if (c.method === "GET" && c.path.startsWith("/v1/projects/acme/storage?")) {
                const prefix = c.query.get("prefix");
                if (prefix === "public/media/") return { status: 200, json: { data: [object("public/media/same.txt", 3), object("public/media/changed.txt", 2)], folders: ["public/media/sub/", "public/media/unrelated/"], nextCursor: null } };
                if (prefix === "public/media/sub/") return { status: 200, json: { data: [], folders: [], nextCursor: null } };
            }
            if (c.method === "POST" && c.path.endsWith("/storage/uploads")) return { status: 201, json: { uploadUrl: `${API}/v1/storage-uploads/${UPLOAD_TOKEN}`, method: "PUT" } };
            if (c.method === "PUT") return { status: 200, json: {} };
            return undefined;
        };
        const dry = await cli(["storage", "sync", "media", "public/media", "--dry-run", "--project", "acme", "--cwd", dir, "--json"], remote);
        expect(dry.code).toBe(0);
        expect(dry.json.data.upload.map((u: any) => u.path)).toEqual(["public/media/changed.txt", "public/media/sub/new.txt"]);
        expect(dry.json.data.unchanged).toBe(1);
        expect(dry.json.data.skipped.map((s: any) => s.path)).toContain(".env");
        expect(calls.every((c) => c.method === "GET")).toBe(true);
        // Yerelde karşılığı olmayan uzak klasöre inilmez
        expect(calls.map((c) => c.query.get("prefix"))).toEqual(["public/media/", "public/media/sub/"]);

        calls = [];
        const real = await cli(["storage", "sync", "media", "public/media", "--project", "acme", "--cwd", dir], remote);
        expect(real.code).toBe(0);
        expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ path: "public/media/changed.txt", size: 4 }, { path: "public/media/sub/new.txt", size: 1 }]);
        expect(calls.some((c) => c.method === "DELETE")).toBe(false);
        expect(real.stdout).toContain("Uploaded 2 files");
        expect(real.stdout + real.stderr).not.toContain(UPLOAD_TOKEN);
    });

    test("plan sınırı (402): sınırı ve planı söyleyen ileti, çıkış 30", async () => {
        await writeFile(join(dir, "big.bin"), "x");
        const r = await cli(["storage", "put", "big.bin", "private/big.bin", "--project", "acme", "--cwd", dir, "--json"], () => ({ status: 402, json: { type: "https://perafly.com/docs/errors/plan_limit_storage_file", title: "File is larger than the plan allows", status: 402, code: "plan_limit_storage_file", feature: "storageFileBytes", limit: 25 * 1024 * 1024, used: 0, upgradeTo: "Individual", requestId: "req_1" } }));
        expect(r.code).toBe(30);
        expect(r.err.error.code).toBe("plan_limit_storage_file");
        expect(r.err.error.message).toBe("File is larger than the plan allows: the plan allows 25 MB. The Individual plan allows more. A team admin can change the plan in Perafly.");
        expect(r.err.error.details).toMatchObject({ limit: 25 * 1024 * 1024, upgradeTo: "Individual" });
        expect(calls).toHaveLength(1);
    });

    test("büyük dosya akışla yüklenir: gövde her denemede yeniden açılır, kimlik başlığı gitmez; tanılama satırında belirteç yok", async () => {
        let attempts = 0;
        const debug: string[] = [];
        const seen: Buffer[] = [];
        const f = (async (_input: any, init: any) => {
            attempts++;
            expect(init.duplex).toBe("half");
            expect(init.headers.Authorization).toBeUndefined();
            seen.push(Buffer.from(await new Response(init.body).arrayBuffer()));
            if (attempts === 1) return new Response("{}", { status: 503 });
            return new Response(JSON.stringify({ path: "public/x", size: 3 }), { status: 200 });
        }) as typeof fetch;
        const client = new ApiClient({ apiUrl: API, token: KEY, fetch: f, sleep: async () => undefined, debug: (l) => debug.push(l) });
        const out = await client.upload(`${API}/v1/storage-uploads/${UPLOAD_TOKEN}`, () => Readable.toWeb(Readable.from([Buffer.from("abc")])) as unknown as ReadableStream<Uint8Array>, undefined, "uploadStorageFile");
        expect(out).toEqual({ path: "public/x", size: 3 });
        expect(seen.map((b) => b.toString())).toEqual(["abc", "abc"]);
        const dl = new ApiClient({ apiUrl: API, fetch: (async () => new Response("x", { status: 200 })) as typeof fetch, debug: (l) => debug.push(l) });
        expect(await (await dl.download(`${API}/v1/storage-files/${DOWNLOAD_TOKEN}`)).text()).toBe("x");
        expect(debug).toEqual(["PUT /v1/storage-uploads/… 503 uploadStorageFile", "PUT /v1/storage-uploads/… 200 uploadStorageFile", "GET /v1/storage-files/… 200 downloadStorageFile"]);
        await expect(client.upload("http://evil.example/v1/storage-uploads/x", new Uint8Array([1]))).rejects.toMatchObject({ code: "invalid_response" });
        await expect(client.download("http://evil.example/v1/storage-files/x")).rejects.toMatchObject({ code: "invalid_response" });
    });
});

describe("sftp", () => {
    const ACCOUNT = { id: "sfa_abcdefghjkmnpqrstvwxyz01", label: "Agency laptop", username: "acme.k3f9x2", auth: "password", fingerprint: null, scope: { mode: "full", folder: null }, allowedIps: [], expiresAt: null, status: "active", lastLoginAt: null, createdAt: "x", createdBy: { kind: "user", name: "Ada" } };
    const CONN = { host: "sftp.perafly.test", port: 2222 };

    test("--password: parola insan çıktısında bir kez; bağlantı oluşturma yanıtından (tek istek); --json ve ajan kipi istek atılmadan reddedilir", async () => {
        const handler: Handler = (c) => (c.method === "POST" && c.path === "/v1/projects/acme/sftp" ? { status: 201, json: { account: ACCOUNT, password: PFS, connection: CONN } } : undefined);
        const human = await cli(["sftp", "add", "Agency laptop", "--password", "--project", "acme"], handler);
        expect(human.code).toBe(0);
        expect(calls.map((c) => c.method)).toEqual(["POST"]);
        expect(calls[0]!.body).toEqual({ label: "Agency laptop", password: true });
        expect(occurrences(human.stdout, PFS)).toBe(1);
        expect(human.stdout).toContain("Connect: sftp -P 2222 acme.k3f9x2@sftp.perafly.test");
        expect(human.stdout).toMatch(/Host\s+sftp\.perafly\.test/);
        expect(human.stderr).not.toContain(PFS);
        calls = [];
        for (const [argv, env] of [[["--json"], {}], [[], { PERAFLY_AGENT: "1" }]] as const) {
            const refused = await cli(["sftp", "add", "Agency laptop", "--password", "--project", "acme", ...argv], handler, env);
            expect(refused.code).toBe(2);
            expect(refused.err.error.message).toContain("never in --json output");
        }
        expect(calls).toHaveLength(0);
    });

    test("--key: yalnız .pub okunur; özel anahtar reddedilir; kapsam, IP ve bitiş gövdeye girer", async () => {
        const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJm9 ada@laptop";
        await writeFile(join(dir, "id_ed25519.pub"), `${PUB}\n`);
        await writeFile(join(dir, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n-----END OPENSSH PRIVATE KEY-----\n");
        await writeFile(join(dir, "wrong.pub"), "-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n");
        // --key ile sır dönmez: --json serbest
        const ok = await cli(["sftp", "add", "deploy", "--key", "id_ed25519.pub", "--folder", "public/uploads/", "--ip", "203.0.113.0/24", "--ip", "198.51.100.7/32", "--expires", "2026-12-31", "--project", "acme", "--cwd", dir, "--json"],
            () => ({ status: 201, json: { account: { ...ACCOUNT, auth: "publicKey", fingerprint: "SHA256:abc" }, connection: CONN } }));
        expect(ok.code).toBe(0);
        expect(calls.map((c) => c.method)).toEqual(["POST"]);
        expect(calls[0]!.body).toEqual({ label: "deploy", publicKey: PUB, scope: { mode: "folder", folder: "public/uploads" }, allowedIps: ["203.0.113.0/24", "198.51.100.7/32"], expiresAt: "2026-12-31T00:00:00.000Z" });
        expect(ok.json.data).toMatchObject({ account: { id: ACCOUNT.id, auth: "publicKey" }, connection: CONN });
        calls = [];
        const priv = await cli(["sftp", "add", "x", "--key", "id_ed25519", "--project", "acme", "--cwd", dir], () => undefined);
        expect(priv.code).toBe(2);
        expect(priv.stderr).toContain(".pub");
        expect((await cli(["sftp", "add", "x", "--key", "wrong.pub", "--project", "acme", "--cwd", dir], () => undefined)).code).toBe(2);
        expect((await cli(["sftp", "add", "x", "--project", "acme"], () => undefined)).code).toBe(2);
        expect((await cli(["sftp", "add", "x", "--password", "--key", "id_ed25519.pub", "--project", "acme", "--cwd", dir], () => undefined)).code).toBe(2);
        expect((await cli(["sftp", "add", "x", "--password", "--readonly", "--folder", "public/a", "--project", "acme"], () => undefined)).code).toBe(2);
        expect((await cli(["sftp", "add", "x", "--password", "--expires", "someday", "--project", "acme"], () => undefined)).code).toBe(2);
        expect(calls).toHaveLength(0);
    });

    test("plan SFTP içermiyorsa 402 iletisi; ls bağlantıyı ve planı söyler; rm etiketle bulur ve onay ister", async () => {
        const denied = await cli(["sftp", "add", "x", "--password", "--project", "acme"], () => ({ status: 402, json: { title: "Not included in your plan", status: 402, code: "plan_feature_unavailable", detail: "sftp is not included in your plan. The Individual plan includes it.", feature: "sftp", upgradeTo: "Individual" } }));
        expect(denied.code).toBe(30);
        expect(denied.stderr).toContain("sftp is not included in your plan. The Individual plan includes it.");
        const ls = await cli(["sftp", "ls", "--project", "acme"], () => ({ status: 200, json: { data: [ACCOUNT], connection: CONN, available: false } }));
        expect(ls.stdout).toContain("SFTP is not included in your plan");
        expect(ls.stdout).toContain("Server: sftp.perafly.test, port 2222");
        expect(ls.stdout).toMatch(/Agency laptop\s+sfa_\w+\s+acme\.k3f9x2\s+password/);
        calls = [];
        const noYes = await cli(["sftp", "rm", "Agency laptop", "--project", "acme"], () => ({ status: 200, json: { data: [ACCOUNT], connection: CONN, available: true } }), { PERAFLY_AGENT: "1" });
        expect(noYes.code).toBe(2);
        expect(calls.map((c) => c.method)).toEqual(["GET"]);
        await cli(["sftp", "rm", "Agency laptop", "--project", "acme", "--yes"], (c) => (c.method === "GET" ? { status: 200, json: { data: [ACCOUNT] } } : { status: 204 }));
        expect([calls.at(-1)!.method, calls.at(-1)!.path]).toEqual(["DELETE", `/v1/projects/acme/sftp/${ACCOUNT.id}`]);
        expect((await cli(["sftp", "rm", "nobody", "--project", "acme", "--yes"], () => ({ status: 200, json: { data: [ACCOUNT] } }))).code).toBe(20);
    });
});

describe("sır argümanda verilmez", () => {
    test("40 karakterlik pfk_, pfw_ ve pfo_ argümanı ağa gitmeden düşer; yayınlanabilir pfp_ sır değildir, geçer", async () => {
        const PFW = `pfw_${"W1x2Y3z4".repeat(5)}`;
        const PFO = `pfo_${"O1p2Q3r4".repeat(4)}`;
        expect(PFK.length).toBe(44);
        for (const secret of [PFK, PFW, PFO]) {
            const r = await cli(["data", "ls", "posts", "--project", "acme", "--filter", `key=${secret}`, "--json"], () => ({ status: 200, json: { data: [], nextCursor: null } }));
            expect(r.code).toBe(2);
            expect(r.err.error.code).toBe("validation_error");
            expect(r.stdout + r.stderr).not.toContain(secret);
        }
        const bare = await cli(["env", "set", PFK, "--project", "acme"], () => ({ status: 200, json: {} }));
        expect(bare.code).toBe(2);
        expect(calls).toHaveLength(0);
        const publishable = await cli(["data", "ls", "posts", "--project", "acme", "--filter", `key=${PFP}`, "--json"], () => ({ status: 200, json: { data: [], nextCursor: null } }));
        expect(publishable.code).toBe(0);
        expect(calls[0]!.query.get("filter[key]")).toBe(PFP);
    });
});

describe("yerel MCP: Faz 9 araçları", () => {
    const HIDDEN = ["rotatePublishableKey", "createSecretKey", "revokeSecretKey", "setEnvVar", "deleteEnvVar", "createSftpAccount", "revokeSftpAccount", "deleteCollection", "exportCollection", "createStorageUpload", "uploadStorageFile", "downloadStorageFile"];

    test("kimlik bilgisi, ortam değişkeni yazma, toptan silme ve dosya baytı araç değildir; okuma ve kayıt yazma izne göre", async () => {
        for (const op of HIDDEN) {
            expect([op, HIDDEN_OPERATIONS.has(op)]).toEqual([op, true]);
            expect(operationSpecs().map((s) => s.operationId)).not.toContain(op);
        }
        expect(OPERATION_PERMISSION).toMatchObject({ listCollections: "projects.read", createRecord: "projects.write", deleteRecord: "projects.write", listEnvVars: "env.read", moveStorage: "projects.write", deleteStorage: "projects.write", listSftpAccounts: "projects.read", getDataKeys: "projects.read" });
        const create = operationSpecs().find((s) => s.operationId === "createRecord")!;
        expect(create.bodyNested).toBe(true);
        expect(create.schema.properties.body).toMatchObject({ type: "object", additionalProperties: true });
        expect(create.schema.required).toEqual(expect.arrayContaining(["project", "collection", "body"]));

        const h = createLocalHandlers({ root: dir, flags: { apiUrl: API }, deps: { env: { PERAFLY_HOME: home, PERAFLY_TOKEN: KEY, PERAFLY_CREDENTIAL_STORE: "plaintext" }, fetch: fakeFetch((c) => (c.path === "/v1/me" ? { status: 200, json: { permissions: ["projects.read", "projects.write"] } } : undefined)) } });
        const names = (await h.listTools()).map((t: any) => t.name);
        expect(names).toEqual(expect.arrayContaining(["listCollections", "createRecord", "listStorage", "getDataKeys"]));
        expect(names).not.toContain("listEnvVars");
        for (const op of HIDDEN) expect(names).not.toContain(op);
    });

    test("listRecords süzgeci deepObject açılır; createRecord gövdesi kayıt alanlarıdır; indirme adresi sonuçta karartılır", async () => {
        const h = createLocalHandlers({
            root: dir, flags: { apiUrl: API },
            deps: {
                env: { PERAFLY_HOME: home, PERAFLY_TOKEN: KEY, PERAFLY_CREDENTIAL_STORE: "plaintext" },
                fetch: fakeFetch((c) => {
                    if (c.path.startsWith("/v1/projects/acme/data/posts") && c.method === "GET") return { status: 200, json: { data: [], nextCursor: null } };
                    if (c.path === "/v1/projects/acme/data/posts" && c.method === "POST") return { status: 201, json: { id: "rec_1", title: "Hi" } };
                    if (c.path.startsWith("/v1/projects/acme/storage/file")) return { status: 200, json: { path: "private/a.txt", size: 1, downloadUrl: `${API}/v1/storage-files/${DOWNLOAD_TOKEN}` } };
                    return undefined;
                })
            }
        });
        const list = await h.callTool("listRecords", { project: "acme", collection: "posts", filter: { status: "published", price: { gte: 10 } }, sort: "-createdAt" });
        expect(list.isError).toBeFalsy();
        expect([calls[0]!.query.get("filter[status]"), calls[0]!.query.get("filter[price][gte]"), calls[0]!.query.get("sort")]).toEqual(["published", "10", "-createdAt"]);
        const add = await h.callTool("createRecord", { project: "acme", collection: "posts", body: { title: "Hi" } });
        expect(add.isError).toBeFalsy();
        expect(calls[1]!.body).toEqual({ title: "Hi" });
        const file = await h.callTool("getStorageFile", { project: "acme", path: "private/a.txt" });
        expect(JSON.stringify(file)).not.toContain(DOWNLOAD_TOKEN);
    });
});
