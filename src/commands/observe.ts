/**
 * Gözlem komutları (backend docs/API.md §18.7): `logs`, `metrics`, `top`. Yalnız takım anahtarıyla (hesapsız proje
 * ölçülmez). operationId: listProjectLogs, getProjectMetrics, listProjectMetrics.
 *
 *   perafly logs [access|runtime|access,runtime] [--level warn] [--since 1h] [--search metin] [--version v7] [-f]
 *   perafly metrics [--range 24h]
 *   perafly top [--range 1h] [--watch] [--interval 5]

 * Proje `--project` ya da bağlı klasörden gelir (diğer komutlar gibi). `logs build` ayrı alt komuttur: barındırıcının
 * derleme logunu okur (getBuildLog); `build` akışındaki Perafly satırları `logs` ile de görünür.
 *
 * `--follow` 2 saniyede bir `after` imleciyle yoklar; `--json`'da her satır ayrı bir JSON satırıdır (NDJSON). Ctrl-C
 * bırakır. Ölçülmemiş değer "—" yazılır, sıfır değil; kod çalıştırmayan projede çalışma ölçümleri yerine bu söylenir.
 */
import { CliError } from "../errors.js";
import type { Context, ProjectTarget } from "../context.js";
import { formatBytes, table } from "../output/index.js";

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RANGES = ["1h", "24h", "7d", "30d"] as const;
const RANGE_LABEL: Record<string, string> = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };

/** `15m`, `2h`, `3d` ya da ISO tarih → ISO */
export const sinceToIso = (value: string | undefined, now: Date = new Date()): string | undefined => {
    if (!value) return undefined;
    const m = /^(\d{1,4})([smhd])$/.exec(value.trim());
    if (m) {
        const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
        return new Date(now.getTime() - Number(m[1]) * unit).toISOString();
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new CliError("validation_error", `Not a time: ${value}. Use 15m, 2h, 3d or an ISO date.`, { exitCode: 2 });
    return d.toISOString();
};

const rangeOf = (value: string | undefined, fallback: (typeof RANGES)[number]) => {
    const r = value ?? fallback;
    if (!(RANGES as readonly string[]).includes(r)) throw new CliError("validation_error", `Range must be one of ${RANGES.join(", ")}`, { exitCode: 2 });
    return r;
};

/** Bağlı ya da seçili proje (`--project`). Hesapsız proje ölçülmez */
const projectFor = async (ctx: Context): Promise<string> => {
    const target: ProjectTarget = await ctx.requireProjectTarget();
    if (target.anonymous) {
        throw new CliError("validation_error", "Logs and metrics are for team projects. Claim this project first.", { exitCode: 2, recovery: "perafly projects claim" });
    }
    return target.ref;
};

const LEVEL_TAG: Record<string, string> = { info: "INFO ", warn: "WARN ", error: "ERROR" };

/** Tek log satırı (insan kipi): zaman, düzey, akış, ileti; istek satırında süre ve boyut */
export const logLine = (e: any, paint: (c: "red" | "yellow" | "dim", t: string) => string = (_c, t) => t): string => {
    const at = String(e.at ?? "").replace("T", " ").slice(0, 19);
    const level = LEVEL_TAG[e.level] ?? "INFO ";
    const tag = e.level === "error" ? paint("red", level) : e.level === "warn" ? paint("yellow", level) : level;
    const extra = e.request && (e.request.durationMs != null || e.request.bytes != null)
        ? paint("dim", `  ${[e.request.durationMs != null ? `${e.request.durationMs} ms` : null, e.request.bytes != null ? formatBytes(e.request.bytes) : null].filter(Boolean).join(" · ")}`)
        : "";
    const version = e.version?.number ? paint("dim", ` v${e.version.number}`) : "";
    return `${paint("dim", at)}  ${tag}  ${String(e.stream ?? "").padEnd(7)}${version}  ${e.message ?? ""}${extra}`;
};

const STREAMS = ["access", "runtime", "build"];

/** `access`, `runtime`, `build` ya da virgüllü birleşimi; boş → hepsi */
export const streamsOf = (kind: string | undefined): string | undefined => {
    if (!kind) return undefined;
    const list = kind.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.some((s) => !STREAMS.includes(s))) throw new CliError("validation_error", `Log kind must be access, runtime or build (comma-separated): ${kind}`, { exitCode: 2 });
    return [...new Set(list)].join(",");
};

export const logs = async (ctx: Context, kind: string | undefined, opts: { level?: string; since?: string; search?: string; version?: string; limit?: string; follow?: boolean; followTimeout?: string }) => {
    const stream = streamsOf(kind);
    const since = sinceToIso(opts.since);
    const project = await projectFor(ctx);
    const { client } = await ctx.requireApiKey();
    const base: Record<string, string | undefined> = { stream, level: opts.level, q: opts.search, version: opts.version, since };
    const path = `/v1/projects/${enc(project)}/logs`;
    const first = (await client.get<any>(path, { operationId: "listProjectLogs", query: { ...base, limit: opts.limit ?? "100" } })).data;
    const rows: any[] = [...(first.data ?? [])].reverse();
    const paint = (c: "red" | "yellow" | "dim", t: string) => ctx.output.paint(c, t);

    if (!opts.follow) {
        ctx.output.success(rows, () => {
            const body = rows.length ? rows.map((e) => logLine(e, paint)).join("\n") : "No log lines in this window.";
            const notes = [
                first.truncated ? `Older lines are past this plan's ${first.retentionDays}-day log retention.` : "",
                first.before ? "More: narrow with --since, --stream or --level." : ""
            ].filter(Boolean);
            return notes.length ? `${body}\n\n${notes.join("\n")}` : body;
        }, { pagination: { before: first.before ?? null, after: first.after ?? null }, retentionDays: first.retentionDays, truncated: first.truncated });
        return;
    }

    // İzleme: önce son satırlar, sonra imleçten yenileri
    for (const e of rows) ctx.output.stream(e, () => logLine(e, paint));
    ctx.output.info(paint("dim", "Following new lines. Press Ctrl-C to stop."));
    let after: string = first.after;
    const limitMs = opts.followTimeout ? Number(opts.followTimeout) * 1000 : 0;
    let waited = 0;
    for (;;) {
        await (ctx.deps.sleep ?? sleep)(2000);
        waited += 2000;
        const page = (await client.get<any>(path, { operationId: "listProjectLogs", query: { ...base, since: undefined, after, limit: "500" } })).data;
        for (const e of page.data ?? []) ctx.output.stream(e, () => logLine(e, paint));
        after = page.after ?? after;
        if (limitMs && waited >= limitMs) return;
    }
};

const num = (n: number | null | undefined) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");
const pct = (r: number | null | undefined) => (typeof r === "number" ? `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%` : "—");
const ms = (n: number | null | undefined) => (typeof n === "number" ? (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`) : "—");
const bytes = (n: number | null | undefined) => (typeof n === "number" ? formatBytes(n) : "—");

export const metricsText = (m: any, projectName: string): string => {
    const t = m.traffic ?? {};
    const rt = m.runtime ?? {};
    const lines: string[][] = [["Project", projectName], ["Range", RANGE_LABEL[m.range] ?? m.range]];
    if (m.measured?.traffic === false) {
        lines.push(["Traffic", "Not measured (the hosting log drain is not set up)."]);
    } else {
        lines.push(["Traffic", `${num(t.requests)} requests · ${num(t.pageViews)} page views · ${num(t.visitors)} visitors · ${bytes(t.bytes)}`]);
        if (t.status) lines.push(["Status", `2xx ${num(t.status["2xx"])} · 3xx ${num(t.status["3xx"])} · 4xx ${num(t.status["4xx"])} · 5xx ${num(t.status["5xx"])} · error rate ${pct(t.errorRate)}`]);
        if (t.cacheHitRate != null) lines.push(["Cache", `${pct(t.cacheHitRate)} served from cache`]);
    }
    if (!rt.runsCode) {
        lines.push(["Runtime", "This project runs no code (static files only)."]);
    } else {
        lines.push(["Functions", `${num(rt.invocations)} calls · ${num(rt.errors)} errors (${pct(rt.errorRate)})`]);
        lines.push(["Duration", `p50 ${ms(rt.durationMs?.p50)} · p95 ${ms(rt.durationMs?.p95)} · max ${ms(rt.durationMs?.max)}`]);
        lines.push(["CPU", ms(rt.cpuMs)]);
        lines.push(["Memory", rt.memory?.maxMb != null ? `${rt.memory.maxMb} MB peak · ${rt.memory.avgMb ?? "—"} MB average · ${rt.memory.limitMb ?? "—"} MB allocated` : "—"]);
    }
    lines.push(["Build time", `${num(m.usage?.buildSeconds)} s`]);
    let out = table(lines);
    const paths: any[] = t.topPaths ?? [];
    if (paths.length) out += `\n\n${table(paths.map((p) => [p.path ?? "(not found)", num(p.requests), num(p.pageViews)]), ["PATH", "REQUESTS", "PAGE VIEWS"])}`;
    const refs: any[] = t.topReferrers ?? [];
    if (refs.length) out += `\n\n${table(refs.map((r) => [r.host, num(r.pageViews)]), ["REFERRER", "PAGE VIEWS"])}`;
    return out;
};

export const metrics = async (ctx: Context, opts: { range?: string }) => {
    const range = rangeOf(opts.range, "24h");
    const project = await projectFor(ctx);
    const { client } = await ctx.requireApiKey();
    const m = (await client.get<any>(`/v1/projects/${enc(project)}/metrics`, { operationId: "getProjectMetrics", query: { range } })).data;
    ctx.output.success(m, () => metricsText(m, project));
};

export const topText = (res: any): string => {
    const rows: any[] = res.data ?? [];
    if (!rows.length) return "No projects yet.";
    return table(
        rows.map((r) => [r.project?.name ?? "—", num(r.requests), num(r.errors), pct(r.errorRate), bytes(r.bytes), num(r.visitors), num(r.invocations), `${num(r.buildSeconds)} s`]),
        ["PROJECT", "REQUESTS", "ERRORS", "ERROR %", "BANDWIDTH", "VISITORS", "CALLS", "BUILD"]
    );
};

export const top = async (ctx: Context, opts: { range?: string; watch?: boolean; interval?: string; count?: string }) => {
    const range = rangeOf(opts.range, "1h");
    const { client } = await ctx.requireApiKey();
    const load = async () => (await client.get<any>("/v1/metrics/projects", { operationId: "listProjectMetrics", query: { range } })).data;
    if (!opts.watch) {
        const res = await load();
        ctx.output.success(res.data ?? [], () => `Projects, ${RANGE_LABEL[range]}:\n\n${topText(res)}`, { range });
        return;
    }
    const interval = Math.max(2, Number(opts.interval ?? 5) || 5) * 1000;
    const count = opts.count ? Math.max(1, Number(opts.count) || 1) : 0;
    for (let i = 0; ; i++) {
        const res = await load();
        // Etkileşimli uçbirimde ekranı temizleyip yeniden çizer; JSON'da her yenileme bir satır
        const clear = ctx.output.interactive ? "\u001b[2J\u001b[H" : "";
        ctx.output.stream(res, () => `${clear}Projects, ${RANGE_LABEL[range]} (updated ${new Date().toISOString().slice(11, 19)} UTC; Ctrl-C to stop):\n\n${topText(res)}`);
        if (count && i + 1 >= count) return;
        await (ctx.deps.sleep ?? sleep)(interval);
    }
};
