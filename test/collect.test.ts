import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collect } from "../src/publish/collect.js";
import { excludedFileReason, invalidPathReason } from "../src/publish/exclude.js";
import { extractArchive, safeEntryPath } from "../src/publish/archive.js";
import { hashFiles } from "../src/publish/hash.js";
import { makeTarGz, makeZip } from "./helpers/archives.js";

const dirs: string[] = [];
const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), "pf-test-"));
    dirs.push(d);
    return d;
};
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const put = async (root: string, rel: string, text = "x") => {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), text);
};

describe("dışlama kuralları", () => {
    test("sır ve yerel durum dosyaları her zaman atlanır", () => {
        for (const p of [".env", ".env.local", ".env.example", "a/.env.production", "key.pem", "certs/server.key", "id_rsa", "id_ed25519.pub", ".npmrc", ".netrc",
            "x/.git-credentials", ".git/config", "node_modules/a/index.js", ".perafly/state.json", ".perafly/project.json", "a/.ssh/config", ".DS_Store"]) {
            expect([p, excludedFileReason(p)]).not.toEqual([p, null]);
        }
        for (const p of ["index.html", "env.js", "environment.html", "keys.html", "a/key.json", "docs/.well-known/security.txt"]) expect([p, excludedFileReason(p)]).toEqual([p, null]);
    });
    test("geçersiz yol bölümleri", () => {
        expect(invalidPathReason("a/../b")).not.toBeNull();
        expect(invalidPathReason("a\\b")).not.toBeNull();
        expect(invalidPathReason("a//b")).not.toBeNull();
        expect(invalidPathReason("a\u0007b")).not.toBeNull();
        expect(invalidPathReason("ok/fine.html")).toBeNull();
    });
});

describe("klasör toplama", () => {
    test("sır dosyaları, sembolik bağlar ve dışlanan klasörler bildirime girmez; atlananlar nedeniyle listelenir", async () => {
        const root = await tmp();
        await put(root, "index.html", "<h1>hi</h1>");
        await put(root, "assets/app.js");
        await put(root, ".env", "SECRET=1");
        await put(root, ".git/config");
        await put(root, "node_modules/x/index.js");
        await put(root, ".perafly/state.json", "{}");
        const outside = await tmp();
        await put(outside, "secret.txt", "outside");
        await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
        await symlink(outside, join(root, "linkdir"));
        const r = await collect(root);
        expect(r.files.map((f) => f.path)).toEqual(["assets/app.js", "index.html"]);
        const skipped = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
        expect(skipped[".env"]).toBe("environment file");
        expect(skipped[".git/"]).toBe("version control directory");
        expect(skipped["node_modules/"]).toBe("node_modules");
        expect(skipped[".perafly/"]).toBe("local Perafly state");
        expect(skipped["link.txt"]).toBe("symbolic link");
        expect(skipped["linkdir"]).toBe("symbolic link");
        expect(r.totalBytes).toBe(r.files.reduce((n, f) => n + f.size, 0));
    });

    test(".gitignore yalnız istenince; iç içe dosya ve olumsuzlama git gibi", async () => {
        const root = await tmp();
        await put(root, ".gitignore", "*.log\nbuild/\n");
        await put(root, "a.log");
        await put(root, "build/x.js");
        await put(root, "sub/.gitignore", "!keep.log\n");
        await put(root, "sub/keep.log");
        await put(root, "sub/drop.log");
        await put(root, "index.html");
        const plain = await collect(root);
        expect(plain.files.map((f) => f.path)).toContain("a.log");
        const src = await collect(root, { respectGitignore: true });
        expect(src.files.map((f) => f.path).sort()).toEqual(["index.html", "sub/keep.log"]);
        expect(src.skipped).toContainEqual({ path: ".gitignore", reason: "version control file" });
    });

    test("tek HTML dosyası index.html olur; ev klasörü ve kök reddedilir; bağ olan girdi reddedilir", async () => {
        const root = await tmp();
        await put(root, "page.html", "<p>x</p>");
        const r = await collect(join(root, "page.html"));
        expect(r.files).toEqual([{ path: "index.html", absPath: join(root, "page.html"), size: 8 }]);
        await expect(collect(homedir())).rejects.toMatchObject({ code: "validation_error" });
        await expect(collect("/")).rejects.toMatchObject({ code: "validation_error" });
        await symlink(root, join(await tmp(), "l"));
        await expect(collect(join(dirs[dirs.length - 1]!, "l"))).rejects.toMatchObject({ code: "validation_error" });
    });

    test("girdi sınırı aşılınca düşer", async () => {
        const root = await tmp();
        for (let i = 0; i < 12; i++) await put(root, `f${i}.html`);
        await expect(collect(root, { maxEntries: 10 })).rejects.toMatchObject({ code: "validation_error" });
    });

    test("özetler: sha256 ve boyut", async () => {
        const root = await tmp();
        await put(root, "a.txt", "abc");
        const r = await collect(root);
        const [h] = await hashFiles(r.files);
        expect(h!.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
});

describe("arşivler", () => {
    test("zip: yol kaçışı içeren arşiv bütünüyle reddedilir; dışarıya hiçbir şey yazılmaz", async () => {
        const work = await tmp();
        for (const evil of ["../evil.txt", "site/../../evil2.txt", "/abs.txt"]) {
            const file = join(work, "a.zip");
            await writeFile(file, makeZip([{ name: "site/index.html", content: Buffer.from("<h1>z</h1>") }, { name: evil, content: Buffer.from("evil") }]));
            await expect(collect(file)).rejects.toMatchObject({ code: "validation_error" });
            expect((await readdir(work)).sort()).toEqual(["a.zip"]);
        }
        expect(await stat(join(tmpdir(), "evil.txt")).catch(() => null)).toBeNull();
    });

    test("zip: sembolik bağ atlanır; tek üst klasör kök olur; geçici klasör temizlenir", async () => {
        const work = await tmp();
        const file = join(work, "b.zip");
        await writeFile(file, makeZip([
            { name: "site/" },
            { name: "site/index.html", content: Buffer.from("<h1>z</h1>") },
            { name: "site/link", content: Buffer.from("/etc/passwd"), unixMode: 0o120777 },
            { name: "__MACOSX/site/._index.html", content: Buffer.from("junk") }
        ]));
        const r = await collect(file);
        const root = r.root;
        try {
            expect(r.kind).toBe("archive");
            expect(r.files.map((f) => f.path)).toEqual(["index.html"]);
            expect(r.skipped).toContainEqual({ path: "site/link", reason: "symbolic link" });
        } finally {
            await r.cleanup();
        }
        expect(await stat(root).catch(() => null)).toBeNull();
    });

    test("zip: açılmış boyut sınırı ve şifreli giriş reddedilir; geçici klasör silinir", async () => {
        const work = await tmp();
        const big = join(work, "big.zip");
        await writeFile(big, makeZip([{ name: "a.bin", content: Buffer.alloc(2048) }, { name: "b.bin", content: Buffer.alloc(2048) }]));
        await expect(extractArchive(big, { maxBytes: 3000 })).rejects.toMatchObject({ code: "validation_error" });
        const enc = join(work, "enc.zip");
        await writeFile(enc, makeZip([{ name: "a.txt", content: Buffer.from("x"), encrypted: true }]));
        await expect(extractArchive(enc)).rejects.toMatchObject({ code: "validation_error" });
        const left = (await readdir(tmpdir())).filter((n) => n.startsWith("perafly-archive-"));
        for (const n of left) expect((await stat(join(tmpdir(), n)).catch(() => null))?.isDirectory() ?? false).toBe(true);
    });

    test("tar.gz: `..`, mutlak yol, sembolik ve sabit bağ atlanır", async () => {
        const work = await tmp();
        const file = join(work, "a.tar.gz");
        await writeFile(file, makeTarGz([
            { name: "index.html", content: Buffer.from("<h1>t</h1>") },
            { name: "../evil.txt", content: Buffer.from("evil") },
            { name: "/abs.txt", content: Buffer.from("evil") },
            { name: "sym", type: "2", linkname: "/etc/passwd" },
            { name: "hard", type: "1", linkname: "index.html" },
            { name: "dir", type: "5" },
            { name: "dir/a.css", content: Buffer.from("a{}") }
        ]));
        const r = await collect(file);
        try {
            expect(r.files.map((f) => f.path)).toEqual(["dir/a.css", "index.html"]);
            const reasons = r.skipped.map((s) => s.reason);
            expect(reasons).toContain("symbolic link");
            expect(reasons).toContain("hard link");
            expect(reasons.filter((x) => x === "unsafe path in archive").length).toBe(2);
        } finally {
            await r.cleanup();
        }
        expect((await readdir(work)).sort()).toEqual(["a.tar.gz"]);
    });

    test("tar.gz: boyut sınırı", async () => {
        const work = await tmp();
        const file = join(work, "b.tgz");
        await writeFile(file, makeTarGz([{ name: "a.bin", content: Buffer.alloc(4096) }]));
        await expect(extractArchive(file, { maxBytes: 1000 })).rejects.toMatchObject({ code: "validation_error" });
    });

    test("arşiv yolu denetimi", () => {
        expect(safeEntryPath("./a/b.html")).toBe("a/b.html");
        expect(safeEntryPath("a/")).toBe("a");
        for (const bad of ["../a", "a/../../b", "/etc/passwd", "C:/x", "a\\b", ""]) expect(safeEntryPath(bad)).toBeNull();
    });
});
