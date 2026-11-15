/**
 * Veri, depolama, ortam değişkenleri ve SFTP komutlarının ortak parçaları (backend docs/API.md §20):
 *
 *   teamProject   hedef proje ve takım anahtarı; hesapsız projede bunların hiçbiri yoktur (sunucu 403), ağa gitmeden söylenir
 *   storagePath   `public/` ya da `private/` ile başlayan depolama yolu ya da klasörü
 *   readJsonInput JSON girdisi dosyadan ya da stdin'den (komut argümanından değil)
 *   saveResponse  yanıt gövdesini geçici dosya üzerinden diske yazar; pipeToStdout aynısını stdout'a akıtır
 *   safeText      sunucudan gelen metni terminale yazmadan önce denetim karakterlerinden arındırır
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { formatBytes } from "../output/index.js";

export const enc = encodeURIComponent;

export const teamProject = async (ctx: Context, what: string) => {
    const t = await ctx.requireProjectTarget();
    if (t.anonymous) throw new CliError("validation_error", `${what} belong to team projects. Claim this project first.`, { exitCode: 2, recovery: "perafly projects claim" });
    const { client } = await ctx.requireApiKey();
    return { ref: t.ref, client };
};

/** Depolama yolu `public/` ya da `private/` ile başlar (baştaki `/` atılır, klasöre sondaki `/` eklenir); sunucu ayrıca doğrular */
export const storagePath = (raw: string, kind: "file" | "folder"): string => {
    let p = raw.trim().replace(/^\/+/, "");
    if (kind === "folder" && p && !p.endsWith("/")) p += "/";
    if (!(kind === "folder" ? /^(public|private)\// : /^(public|private)\/.*[^/]$/).test(p)) {
        throw new CliError("validation_error", `Storage paths start with public/ or private/ (got "${raw}").`, { exitCode: 2 });
    }
    return p;
};

const readAll = async (stream: NodeJS.ReadableStream, max: number): Promise<string> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > max) throw new CliError("validation_error", `The input is larger than ${formatBytes(max)}.`, { exitCode: 2 });
        chunks.push(b);
    }
    return Buffer.concat(chunks).toString("utf8");
};

/**
 * JSON girdisi: `--file <dosya>`, `--file -` (stdin) ya da dosya verilmediyse borudan gelen stdin. stdin terminalse ve
 * `-` açıkça verilmediyse sorulmaz: ne beklendiği söylenir.
 */
export const readJsonInput = async (ctx: Context, file: string | undefined, what: string, max = 1024 * 1024): Promise<unknown> => {
    let text: string;
    let source: string;
    if (file && file !== "-") {
        const abs = resolve(ctx.cwd, file);
        const st = await stat(abs).catch(() => null);
        if (!st?.isFile()) throw new CliError("validation_error", `Not found: ${file}`, { exitCode: 2 });
        if (st.size > max) throw new CliError("validation_error", `${file} is larger than ${formatBytes(max)}.`, { exitCode: 2 });
        text = await readFile(abs, "utf8");
        source = file;
    } else {
        const stdin = ctx.deps.stdin ?? process.stdin;
        if (stdin.isTTY && file !== "-") throw new CliError("validation_error", `Pass ${what} as JSON: --file <file>, or pipe it on stdin.`, { exitCode: 2 });
        text = await readAll(stdin, max);
        source = "stdin";
    }
    if (!text.trim()) throw new CliError("validation_error", `No JSON on ${source}. Pass ${what} with --file <file>, or pipe it on stdin.`, { exitCode: 2 });
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new CliError("validation_error", `${source} is not valid JSON: ${(error as Error).message}`, { exitCode: 2 });
    }
};

/** Yanıt gövdesini `file`'a yazar (önce geçici dosyaya, sonra yerine taşır); yazılan bayt sayısını döner */
export const saveResponse = async (res: Response, file: string, mode = 0o666): Promise<number> => {
    const tmp = `${file}.${randomBytes(4).toString("hex")}.part`;
    try {
        const body = res.body ? Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>) : Readable.from([]);
        await pipeline(body, createWriteStream(tmp, { flags: "wx", mode }));
        const { size } = await stat(tmp);
        await rename(tmp, file);
        return size;
    } catch (error: any) {
        await rm(tmp, { force: true }).catch(() => undefined);
        if (error instanceof CliError) throw error;
        throw new CliError("validation_error", `Could not write ${file}${error?.code ? ` (${error.code})` : ""}.`, { exitCode: 2 });
    }
};

/** Yanıt gövdesini stdout'a akıtır (stdout kapatılmaz) */
export const pipeToStdout = async (ctx: Context, res: Response) => {
    if (!res.body) return;
    const out = (ctx.deps.stdout ?? process.stdout) as NodeJS.WritableStream;
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), out, { end: false });
};

/** Sunucudan gelen (ör. ziyaretçinin yazdığı) metin terminale yazılmadan önce: denetim karakterleri ve satır sonları atılır */
// eslint-disable-next-line no-control-regex
export const safeText = (v: unknown, max = 60): string => {
    if (v === null || v === undefined) return "—";
    const s = (typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** ISO zamanın okunur kısmı */
export const when = (iso: unknown): string => (typeof iso === "string" && iso ? iso.slice(0, 16).replace("T", " ") : "—");
