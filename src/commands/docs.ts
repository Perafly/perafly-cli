/**
 * `perafly docs <sorgu...>` (README §2; backend docs/API.md §22.4 `GET /v1/docs/search`, operationId `searchDocs`):
 * Perafly belgelerinde arama. Giriş gerektirmez ve kimlik gönderilmez. Dil `--lang`, yoksa sistem dili (`tr*` → tr),
 * yoksa en. Sonuç: başlık, bağlam, adres, kısa alıntı; `--json` sunucunun listesidir. 503 `docs_unavailable` anlaşılır
 * bir iletiye çevrilir.
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { safeText } from "./shared.js";

export const DOCS_URL = "https://perafly.com/docs";

/** Sistem dili: LC_ALL → LC_MESSAGES → LANG → LANGUAGE → Intl; `tr` ile başlıyorsa tr, değilse en */
export const systemLang = (env: NodeJS.ProcessEnv = process.env): "en" | "tr" => {
    const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().locale;
        } catch {
            return "";
        }
    })();
    return /^tr([_.@:-]|$)/i.test(String(raw ?? "").trim()) ? "tr" : "en";
};

export const formatDocResults = (rows: any[]): string => {
    if (!rows.length) return "No results. Try other words, or browse https://perafly.com/docs.";
    return rows
        .map((r, i) => {
            const title = safeText(r.title, 120);
            const context = r.context ? safeText(r.context, 120) : "";
            const lines = [`${i + 1}. ${title}${context && context !== title ? `  (${context})` : ""}`];
            if (r.url) lines.push(`   ${safeText(r.url, 300)}`);
            if (r.snippet) lines.push(`   ${safeText(r.snippet, 240)}`);
            return lines.join("\n");
        })
        .join("\n\n");
};

export const docs = async (ctx: Context, words: string[], opts: { lang?: string; limit?: string }) => {
    const q = (words ?? []).join(" ").trim();
    if (!q) throw new CliError("validation_error", "Pass what to look for, for example: perafly docs custom domain", { exitCode: 2 });
    if (q.length > 200) throw new CliError("validation_error", "The query is longer than 200 characters.", { exitCode: 2 });
    const lang = opts.lang ?? systemLang(ctx.env);
    if (lang !== "en" && lang !== "tr") throw new CliError("validation_error", "--lang must be en or tr", { exitCode: 2 });
    let limit: number | undefined;
    if (opts.limit !== undefined) {
        limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new CliError("validation_error", "--limit is 1 to 20.", { exitCode: 2 });
    }
    let res: any;
    try {
        // Kimliksiz: arama herkese açıktır, anahtar gönderilmez
        res = (await ctx.client(null).get<any>("/v1/docs/search", { operationId: "searchDocs", query: { q, lang, limit } })).data;
    } catch (error) {
        if (error instanceof CliError && error.status === 503) {
            throw new CliError(error.code, `The docs search is unavailable right now. Try again in a minute, or open ${DOCS_URL}.`, { status: 503, exitCode: 1, retryable: true, type: error.type, title: error.title, requestId: error.requestId });
        }
        throw error;
    }
    const rows: any[] = Array.isArray(res?.data) ? res.data : [];
    ctx.output.success(rows, () => formatDocResults(rows));
};
