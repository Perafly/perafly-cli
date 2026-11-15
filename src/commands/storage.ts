/**
 * Proje depolaması (backend docs/API.md §20.6): `public/` ya da `private/` ile başlayan yol adresli dosyalar. Proje
 * `--project` ya da bağlı klasörden; yalnız takım projesinde.
 *
 *   perafly storage ls [önek]                    klasörler ve dosyalar (boyut okunur), kullanım
 *   perafly storage put <yerel> <uzak>           createStorageUpload → imzalı adrese PUT (iki istek)
 *   perafly storage get <uzak> [yerel|-]         getStorageFile → imzalı adresten indirme
 *   perafly storage mv <kaynak> <hedef> [--overwrite]
 *   perafly storage rm <yol|klasör/>             onay ister; sondaki `/` klasörü (`?prefix=`) siler
 *   perafly storage sync <yerel klasör> <uzak önek> [--dry-run]   eksik ya da boyutu farklı dosyaları yükler; silmez
 *
 * İmzalı yükleme ve indirme adresleri hiçbir çıktıya yazılmaz (`--json`'da da karartılır). Yerel dosyada yayının
 * dışlama kuralları geçerlidir (README §9: `.env*`, anahtarlar, `.git`, `node_modules` hiçbir yoldan yüklenmez);
 * sembolik bağ izlenmez.
 */
import { createReadStream } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { ApiClient, UploadBody } from "../api/client.js";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { formatBytes, requireConfirmation, table } from "../output/index.js";
import { collect, excludedFileReason } from "../publish/index.js";
import { enc, pipeToStdout, safeText, saveResponse, storagePath, teamProject, when } from "./shared.js";

const WHAT = "Storage";
/** Bu boyutun üstündeki dosya belleğe alınmaz, akışla yüklenir */
export const STREAM_UPLOAD_OVER = 32 * 1024 * 1024;
const MAX_PATH = 512;

const base = (ref: string) => `/v1/projects/${enc(ref)}/storage`;
const lastSegment = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

const checkLimit = (limit: string | undefined) => {
    if (limit !== undefined && !/^(1000|[1-9][0-9]{0,2})$/.test(limit)) throw new CliError("validation_error", "--limit is 1 to 1000.", { exitCode: 2 });
};

/** Yüklenecek yerel dosya: düzenli dosya, sembolik bağ değil, dışlama kurallarına takılmıyor */
const localFile = async (ctx: Context, input: string): Promise<{ abs: string; size: number }> => {
    const abs = resolve(ctx.cwd, input);
    const st = await lstat(abs).catch(() => null);
    if (!st) throw new CliError("validation_error", `Not found: ${input}`, { exitCode: 2 });
    if (st.isSymbolicLink()) throw new CliError("validation_error", `${input} is a symbolic link. Pass the real file.`, { exitCode: 2 });
    if (st.isDirectory()) throw new CliError("validation_error", `${input} is a folder. Upload folders with perafly storage sync.`, { exitCode: 2 });
    if (!st.isFile()) throw new CliError("validation_error", `${input} is not a regular file.`, { exitCode: 2 });
    const rel = relative(ctx.cwd, abs);
    const checked = !rel || rel.startsWith("..") || isAbsolute(rel) ? basename(abs) : rel.split(sep).join("/");
    const reason = excludedFileReason(checked);
    if (reason) throw new CliError("validation_error", `${input} is never uploaded (${reason}).`, { exitCode: 2 });
    return { abs, size: st.size };
};

/** createStorageUpload, sonra baytlar imzalı adrese; adres hiçbir yere yazılmaz */
const uploadOne = async (client: ApiClient, ref: string, abs: string, path: string, size: number, contentType?: string): Promise<any> => {
    const up = (await client.post<any>(`${base(ref)}/uploads`, { operationId: "createStorageUpload", body: { path, size, ...(contentType ? { contentType } : {}) } })).data;
    if (typeof up?.uploadUrl !== "string") throw new CliError("invalid_response", "The API did not return an upload URL", { exitCode: 1 });
    let body: UploadBody;
    if (size > STREAM_UPLOAD_OVER) {
        body = () => Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>;
    } else {
        const bytes = new Uint8Array(await readFile(abs));
        if (bytes.length !== size) throw new CliError("validation_error", `${path} changed while uploading. Try again.`, { exitCode: 2 });
        body = bytes;
    }
    return (await client.upload(up.uploadUrl, body, undefined, "uploadStorageFile")) ?? { path, size };
};

export const ls = async (ctx: Context, prefix: string | undefined, opts: { limit?: string; cursor?: string }) => {
    const p = prefix && prefix !== "/" ? storagePath(prefix, "folder") : undefined;
    checkLimit(opts.limit);
    const { ref, client } = await teamProject(ctx, WHAT);
    const res = (await client.get<any>(base(ref), { operationId: "listStorage", query: { prefix: p, limit: opts.limit, cursor: opts.cursor } })).data;
    const files: any[] = res.data ?? [];
    const folders: string[] = res.folders ?? [];
    const name = (path: string) => safeText(p && path.startsWith(p) ? path.slice(p.length) : path, 80);
    ctx.output.success(files, () => {
        const rows = [...folders.map((f) => [name(f), "—", ""]), ...files.map((o) => [name(o.path), formatBytes(Number(o.size ?? 0)), when(o.updatedAt)])];
        const lines = [rows.length ? table(rows, ["NAME", "SIZE", "UPDATED"]) : `Nothing under ${p ?? "storage"} yet. Upload: perafly storage put <file> ${p ?? "public/"}`];
        if (res.nextCursor) lines.push("", `More: --cursor ${res.nextCursor}`);
        if (res.usage) lines.push("", `Team storage: ${formatBytes(Number(res.usage.bytes ?? 0))}${res.usage.limit == null ? "" : ` of ${formatBytes(Number(res.usage.limit))}`}`);
        return lines.join("\n");
    }, { folders, pagination: { nextCursor: res.nextCursor ?? null }, usage: res.usage ?? null });
};

export const put = async (ctx: Context, local: string, remote: string, opts: { contentType?: string }) => {
    const { abs, size } = await localFile(ctx, local);
    const path = remote.trim().endsWith("/") ? storagePath(remote, "folder") + basename(abs) : storagePath(remote, "file");
    const { ref, client } = await teamProject(ctx, WHAT);
    const obj = await uploadOne(client, ref, abs, path, size, opts.contentType);
    ctx.output.success(obj, () => `Uploaded ${path} (${formatBytes(Number(obj.size ?? size))}).${obj.url ? `\nPublic address: ${obj.url}` : ""}`);
};

export const get = async (ctx: Context, remote: string, local: string | undefined) => {
    const path = storagePath(remote, "file");
    if (local === "-" && ctx.output.json) throw new CliError("validation_error", "With --json, pass a local file name: the file is not JSON output.", { exitCode: 2 });
    let file: string | null = null;
    if (local !== "-") {
        file = resolve(ctx.cwd, local ?? lastSegment(path));
        if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, lastSegment(path));
    }
    const { ref, client } = await teamProject(ctx, WHAT);
    const obj = (await client.get<any>(`${base(ref)}/file`, { operationId: "getStorageFile", query: { path } })).data;
    if (typeof obj?.downloadUrl !== "string") throw new CliError("invalid_response", "The API did not return a download URL", { exitCode: 1 });
    const res = await client.download(obj.downloadUrl);
    if (!file) return pipeToStdout(ctx, res);
    const bytes = await saveResponse(res, file);
    // İmzalı adres ve süresi çıktıya girmez
    const { downloadUrl: _u, downloadExpiresAt: _e, ...info } = obj;
    ctx.output.success({ ...info, file, bytes }, () => `Downloaded ${path} to ${relative(ctx.cwd, file!) || file} (${formatBytes(bytes)}).`);
};

export const mv = async (ctx: Context, from: string, to: string, opts: { overwrite?: boolean }) => {
    const folder = from.trim().endsWith("/");
    const f = storagePath(from, folder ? "folder" : "file");
    const t = folder ? storagePath(to, "folder") : to.trim().endsWith("/") ? storagePath(to, "folder") + lastSegment(f) : storagePath(to, "file");
    const { ref, client } = await teamProject(ctx, WHAT);
    const out = (await client.post<any>(`${base(ref)}/move`, { operationId: "moveStorage", body: { from: f, to: t, ...(opts.overwrite ? { overwrite: true } : {}) } })).data;
    const moved = Number(out?.moved ?? 0);
    ctx.output.success({ from: f, to: t, moved }, () => `Moved ${moved} file${moved === 1 ? "" : "s"}: ${f} → ${t}.`);
};

export const rm = async (ctx: Context, target: string, opts: { yes?: boolean }) => {
    const folder = target.trim().endsWith("/");
    const p = storagePath(target, folder ? "folder" : "file");
    const { ref, client } = await teamProject(ctx, WHAT);
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, folder ? `Delete every file under ${p} (up to 1000)?` : `Delete ${p}?`, `perafly storage rm ${p} --project ${ref} --yes`);
    const out = (await client.delete<any>(base(ref), { operationId: "deleteStorage", query: folder ? { prefix: p } : { path: p } })).data;
    const deleted = Number(out?.deleted ?? 0);
    ctx.output.success({ ...(folder ? { prefix: p } : { path: p }), deleted }, () => `Deleted ${deleted} file${deleted === 1 ? "" : "s"}.${folder && deleted >= 1000 ? " There may be more: run it again." : ""}`);
};

/** Uzak boyutlar: önekten başlayıp yalnız yerelde karşılığı olan klasörlere iner */
const remoteSizes = async (client: ApiClient, ref: string, prefix: string, wanted: Set<string>): Promise<Map<string, number>> => {
    const sizes = new Map<string, number>();
    const queue = [prefix];
    const seen = new Set(queue);
    let requests = 0;
    while (queue.length) {
        const p = queue.shift()!;
        let cursor: string | null = null;
        do {
            if (++requests > 5000) throw new CliError("validation_error", "Too many remote files to compare. Sync a smaller folder.", { exitCode: 2 });
            const res: any = (await client.get<any>(base(ref), { operationId: "listStorage", query: { prefix: p, limit: 1000, cursor } })).data;
            for (const o of res.data ?? []) sizes.set(String(o.path), Number(o.size));
            for (const f of (res.folders ?? []) as string[]) if (wanted.has(f) && !seen.has(f)) {
                seen.add(f);
                queue.push(f);
            }
            cursor = res.nextCursor ?? null;
        } while (cursor);
    }
    return sizes;
};

export const sync = async (ctx: Context, localDir: string, remotePrefix: string, opts: { dryRun?: boolean }) => {
    const prefix = storagePath(remotePrefix, "folder");
    const abs = resolve(ctx.cwd, localDir);
    const st = await lstat(abs).catch(() => null);
    if (!st) throw new CliError("validation_error", `Not found: ${localDir}`, { exitCode: 2 });
    if (st.isSymbolicLink()) throw new CliError("validation_error", `${localDir} is a symbolic link. Pass the real folder.`, { exitCode: 2 });
    if (!st.isDirectory()) throw new CliError("validation_error", `${localDir} is not a folder. Upload one file with perafly storage put.`, { exitCode: 2 });
    const collected = await collect(abs, { respectGitignore: false });
    try {
        const skipped = [...collected.skipped];
        const files = collected.files.filter((f) => {
            if ((prefix + f.path).length <= MAX_PATH) return true;
            skipped.push({ path: f.path, reason: "path too long" });
            return false;
        });
        const wanted = new Set<string>();
        for (const f of files) {
            const parts = f.path.split("/").slice(0, -1);
            for (let i = 1; i <= parts.length; i++) wanted.add(`${prefix}${parts.slice(0, i).join("/")}/`);
        }
        const { ref, client } = await teamProject(ctx, WHAT);
        const remote = await remoteSizes(client, ref, prefix, wanted);
        const plan = files.filter((f) => remote.get(prefix + f.path) !== f.size);
        const unchanged = files.length - plan.length;
        const total = plan.reduce((n, f) => n + f.size, 0);
        const skippedNote = skipped.length ? `\nSkipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join(", ")}${skipped.length > 5 ? ", …" : ""}` : "";
        if (opts.dryRun) {
            const upload = plan.map((f) => ({ path: prefix + f.path, size: f.size }));
            return ctx.output.success({ dryRun: true, prefix, upload, unchanged, skipped }, () => [
                plan.length ? `Would upload ${plan.length} file${plan.length === 1 ? "" : "s"} (${formatBytes(total)}) to ${prefix}:` : `Nothing to upload: ${prefix} is up to date.`,
                ...upload.map((u) => `  ${u.path}  ${formatBytes(u.size)}`),
                `${unchanged} unchanged. Nothing is deleted.${skippedNote}`
            ].join("\n"));
        }
        const uploaded: { path: string; size: number }[] = [];
        for (const f of plan) {
            const path = prefix + f.path;
            ctx.output.info(`Uploading ${path} (${formatBytes(f.size)})`);
            await uploadOne(client, ref, f.absPath, path, f.size);
            uploaded.push({ path, size: f.size });
        }
        ctx.output.success({ prefix, uploaded, unchanged, skipped }, () => `${uploaded.length ? `Uploaded ${uploaded.length} file${uploaded.length === 1 ? "" : "s"} (${formatBytes(total)}) to ${prefix}.` : `Nothing to upload: ${prefix} is up to date.`} ${unchanged} unchanged. Nothing is deleted.${skippedNote}`);
    } finally {
        await collected.cleanup();
    }
};
