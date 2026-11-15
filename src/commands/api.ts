/**
 * `perafly api <METHOD> <yol>` (README §2): açık API'ye ham istek, CLI'ın kimliği ve API adresiyle.
 *
 *   yol      `/v1/…` ya da `/…` (önüne `/v1` eklenir); sorgu yolun içinde (`/v1/projects?q=site`). Mutlak adres, `//`,
 *            ters eğik çizgi ve `.`/`..` parçası reddedilir: kimlik yapılandırılmış API'den başka yere gitmez.
 *   --data   JSON gövde: değer, `@dosya` ya da `-` (stdin); GET gövde almaz
 *   DELETE   yıkıcıdır: etkileşimli kipte sorulur, değilse açık `--yes` (ajan kipi onay yerine geçmez)
 *
 * Çıktı yanıt gövdesinin kendisidir (`{ data }` zarfı yok): JSON güzel biçimli, `--json` ile tek satır; JSON değilse
 * metin. 2xx dışı yanıt hata nesnesidir (stderr; ek problem alanları `details`'te) ve çıkış kodu durumdan gelir (§4.2).
 * Gövde, başlıklar ve hata `redact`/`redactDeep`'ten geçer: anahtar, imzalı adres ve sırlar yazılmaz.
 */
import { lstat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { CliError, problemToError } from "../errors.js";
import type { Context } from "../context.js";
import { excludedFileReason } from "../publish/exclude.js";
import { redact, redactDeep, REDACTED } from "../auth/redact.js";
import { requireConfirmation } from "../output/index.js";
import { readJsonInput } from "./shared.js";

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

const MAX_BODY = 5 * 1024 * 1024;
/** Problem gövdesinin hata nesnesinde zaten karşılığı olan alanları */
const PROBLEM_KEYS = new Set(["type", "title", "status", "code", "detail", "instance", "requestId"]);
/** Değeri hiç yazılmayan yanıt başlıkları */
const SECRET_HEADERS = new Set(["set-cookie", "authorization", "proxy-authorization", "cookie"]);

const invalid = (message: string) => new CliError("validation_error", message, { exitCode: 2 });

export const apiMethod = (raw: string): ApiMethod => {
    const m = (raw ?? "").trim().toUpperCase();
    if (!(API_METHODS as readonly string[]).includes(m)) throw invalid(`Unknown method "${raw}". Use ${API_METHODS.join(", ")}.`);
    return m as ApiMethod;
};

/**
 * Kullanıcının yazdığı yolu API yoluna çevirir (`/v1/…` ve varsa sorgu). Mutlak adres ve ana bilgisayarı değiştirebilecek
 * her biçim reddedilir; `apiUrl` verilirse sonuç ayrıca aynı kökene ve `/v1` altına düştüğü için denetlenir.
 */
export const apiPath = (raw: string, apiUrl?: string): string => {
    const input = (raw ?? "").trim();
    if (!input) throw invalid("Pass a path, for example /v1/projects.");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000- \u007f]/.test(input)) throw invalid("The path must not contain spaces or control characters. Encode them (%20).");
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith("//")) {
        throw invalid("Pass a path on the Perafly API (/v1/…), not a full URL. The CLI sends its key only to the configured API (--api-url).");
    }
    if (input.includes("#")) throw invalid("Fragments (#…) are not sent to the API. Remove them from the path.");
    const q = input.indexOf("?");
    let path = q < 0 ? input : input.slice(0, q);
    const query = q < 0 ? "" : input.slice(q + 1);
    if (path.includes("\\")) throw invalid("Use / in the path, not \\.");
    if (!path.startsWith("/")) path = `/${path}`;
    if (path !== "/v1" && !path.startsWith("/v1/")) path = `/v1${path}`;
    for (const seg of path.split("/")) {
        let decoded = seg;
        try {
            decoded = decodeURIComponent(seg);
        } catch {
            throw invalid(`The path has a malformed escape: ${seg}`);
        }
        if (decoded === "." || decoded === "..") throw invalid("The path must not contain . or .. segments.");
    }
    const out = query ? `${path}?${query}` : path;
    if (apiUrl) {
        const base = new URL(apiUrl);
        const target = new URL(`${apiUrl.replace(/\/+$/, "")}${out}`);
        const prefix = `${base.pathname.replace(/\/+$/, "")}/v1`;
        if (target.origin !== base.origin || !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))) {
            throw invalid("The path must stay on the Perafly API under /v1.");
        }
    }
    return out;
};

/**
 * `--data`: satır içi JSON, `@dosya` ya da `-` (stdin). Dosyada yayının dışlama kuralları geçerlidir (README §9:
 * `.env*`, anahtarlar, `.perafly/` hiçbir yoldan gönderilmez); sembolik bağ izlenmez.
 */
const readBody = async (ctx: Context, data: string): Promise<unknown> => {
    if (data === "-") return readJsonInput(ctx, "-", "the request body", MAX_BODY);
    if (data.startsWith("@")) {
        const file = data.slice(1);
        if (!file) throw invalid("Pass a file after @, for example --data @body.json.");
        const abs = resolve(ctx.cwd, file);
        const st = await lstat(abs).catch(() => null);
        if (st?.isSymbolicLink()) throw invalid(`${file} is a symbolic link. Pass the real file.`);
        const reason = excludedFileReason(abs.split(sep).join("/"));
        if (reason) throw invalid(`${file} is never sent (${reason}).`);
        return readJsonInput(ctx, file, "the request body", MAX_BODY);
    }
    try {
        return JSON.parse(data);
    } catch (error) {
        throw invalid(`--data is not valid JSON: ${(error as Error).message}. Use --data @file.json or --data - for stdin.`);
    }
};

const headerLines = (res: Response): string => {
    const lines = [`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`];
    res.headers.forEach((value, name) => {
        lines.push(`${name}: ${SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : redact(value)}`);
    });
    return lines.join("\n");
};

export interface ApiFlags {
    data?: string;
    include?: boolean;
}

export const api = async (ctx: Context, methodArg: string, pathArg: string, flags: ApiFlags) => {
    const method = apiMethod(methodArg);
    const path = apiPath(pathArg, ctx.apiUrl);
    let body: unknown;
    if (flags.data !== undefined) {
        if (method === "GET") throw invalid("GET requests don't take a body. Put parameters in the path: /v1/projects?q=site");
        body = await readBody(ctx, flags.data);
    }
    if (method === "DELETE") {
        await requireConfirmation(ctx.output, { yes: ctx.flags.yes, env: ctx.env }, `Send DELETE ${path.split("?")[0]} to ${ctx.apiUrl}?`, `perafly api DELETE ${path} --yes`);
    }
    // Kimlik: takım anahtarı, yoksa bu klasörün hesapsız projesinin anahtarı, yoksa kimliksiz (herkese açık uçlar)
    const key = await ctx.apiKey();
    const token = key?.token ?? (await ctx.projectKey())?.token ?? null;
    const res = await ctx.client(token).stream(method, path, { operationId: "api", body, anyStatus: true });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
    }
    const stderr = (ctx.deps.stderr ?? process.stderr) as NodeJS.WritableStream;
    const stdout = (ctx.deps.stdout ?? process.stdout) as NodeJS.WritableStream;
    if (flags.include) stderr.write(`${headerLines(res)}\n\n`);
    const compact = !!ctx.flags.json;
    const rendered = !text ? "" : json !== undefined ? JSON.stringify(redactDeep(json), null, compact ? 0 : 2) : redact(text);

    if (res.status >= 200 && res.status < 300) {
        if (rendered) stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
        return;
    }
    // 2xx dışı: stdout boş kalır; insan kipinde gövde stderr'e, hata nesnesi her kipte stderr'e
    if (rendered && !ctx.output.json) stderr.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
    const problem = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    const base = problemToError(res.status, problem, `HTTP ${res.status}`);
    const details: Record<string, unknown> = { ...base.details };
    if (problem) for (const [k, v] of Object.entries(problem)) if (!PROBLEM_KEYS.has(k) && !(k in details)) details[k] = v;
    throw new CliError(base.code, base.message, {
        status: res.status,
        type: base.type,
        title: base.title,
        retryable: base.retryable,
        requestId: base.requestId ?? res.headers.get("x-request-id"),
        recovery: res.status === 401 && !token ? "perafly login" : null,
        details
    });
};
