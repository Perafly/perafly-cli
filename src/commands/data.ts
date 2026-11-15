/**
 * Headless veri katmanı (backend docs/API.md §20.1–§20.4). Proje `--project` ya da bağlı klasörden; yalnız takım
 * projesinde (hesapsız projede veri katmanı yoktur).
 *
 *   perafly data collections [ls]                          koleksiyonlar: alan ve kayıt sayısı, kurallar, kanca
 *   perafly data collections show <ad>                     şema, kurallar, kanca
 *   perafly data collections create|update <ad> --schema <dosya|->   `{ fields, rules?, hook? }` dosyadan ya da stdin'den
 *   perafly data collections rm <ad>                       koleksiyonu ve bütün kayıtlarını siler (onay ister)
 *   perafly data ls <koleksiyon> [--filter …] [--sort] [--limit] [--cursor]
 *   perafly data get|add|update|rm …                       kayıt işleri; kayıt JSON'u dosyadan ya da stdin'den
 *   perafly data export <koleksiyon> [--format csv|json] [--out <dosya>]
 *   perafly data keys [--create-secret|--rotate-publishable|--revoke-secret]
 *   perafly data hooks [--collection <ad>]                 son kanca teslimleri
 *
 * Yayınlanabilir anahtar (`pfp_`) sır değildir: `--json`'da görünür. Gizli anahtar (`pfk_`) yalnız üretilirken ve yalnız
 * insan çıktısında bir kez gösterilir: `--json` (ve ajan kipi) ile `--create-secret` istek atılmadan reddedilir
 * (`api-keys create` gibi); loglarda karartılır (src/auth/redact.ts). Kayıt değerleri
 * ziyaretçiden gelebilir: terminale denetim karakterlerinden arındırılarak yazılır.
 */
import { resolve } from "node:path";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { formatBytes, requireConfirmation, table } from "../output/index.js";
import { enc, pipeToStdout, readJsonInput, safeText, saveResponse, teamProject, when } from "./shared.js";

const WHAT = "Collections and records";
const COLLECTION_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in"] as const;
const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

const base = (ref: string) => `/v1/projects/${enc(ref)}`;

/* ─── Koleksiyonlar ─── */

const rulesText = (r: any) => ["read", "create", "update", "delete"].map((op) => `${op} ${r?.[op] ?? "secret"}`).join(" · ");
const hookText = (h: any) => (h?.path ? `POST ${h.path} on ${(h.events ?? []).join(", ") || "no events"}` : "None");
const fieldDetails = (f: any): string => {
    if (f.type === "select") return (f.options ?? []).join(", ");
    if (f.type === "relation") return f.collection ? `→ ${f.collection}` : "";
    if (f.type === "text" && f.maxLength) return `max ${f.maxLength} chars`;
    if (f.type === "number") return [f.integer ? "integer" : "", f.min != null ? `min ${f.min}` : "", f.max != null ? `max ${f.max}` : ""].filter(Boolean).join(", ");
    return "";
};

export const collectionsLs = async (ctx: Context) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    const rows: any[] = (await client.get<any>(`${base(ref)}/collections`, { operationId: "listCollections" })).data.data ?? [];
    ctx.output.success(rows, () => (rows.length
        ? table(rows.map((c) => [c.name, String(c.fields?.length ?? 0), c.recordCount == null ? "—" : String(c.recordCount), rulesText(c.rules), c.hook?.path ?? "—"]), ["NAME", "FIELDS", "RECORDS", "RULES", "HOOK"])
        : "No collections. Create one: perafly data collections create <name> --schema schema.json"), { pagination: { nextCursor: null } });
};

const collectionText = (c: any) => {
    const fields: any[] = c.fields ?? [];
    return [
        `${c.name} (${c.id})${c.recordCount == null ? "" : ` · ${c.recordCount} record${c.recordCount === 1 ? "" : "s"}`}`,
        `Rules: ${rulesText(c.rules)}`,
        `Hook:  ${hookText(c.hook)}`,
        "",
        fields.length ? table(fields.map((f) => [f.name, f.type, f.required ? "yes" : "no", f.indexed ? "yes" : "no", fieldDetails(f)]), ["FIELD", "TYPE", "REQUIRED", "INDEXED", "DETAILS"]) : "No fields."
    ].join("\n");
};

export const collectionsShow = async (ctx: Context, name: string) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    const c = (await client.get<any>(`${base(ref)}/collections/${enc(name)}`, { operationId: "getCollection" })).data;
    ctx.output.success(c, () => collectionText(c));
};

/** Şema dosyası: `{ fields, rules?, hook? }` ya da yalnız alan dizisi; başka anahtar gönderilmez */
const schemaBody = (input: unknown, requireFields: boolean): Record<string, unknown> => {
    const obj = Array.isArray(input) ? { fields: input } : input;
    if (!obj || typeof obj !== "object") throw new CliError("validation_error", "The schema must be a JSON object { fields, rules?, hook? } or an array of fields.", { exitCode: 2 });
    const o = obj as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    for (const k of ["fields", "rules", "hook"]) if (o[k] !== undefined) body[k] = o[k];
    if (requireFields && !Array.isArray(body.fields)) throw new CliError("validation_error", "The schema needs a fields array.", { exitCode: 2, pointer: "/fields" });
    if (!Object.keys(body).length) throw new CliError("validation_error", "The schema has none of fields, rules or hook.", { exitCode: 2 });
    return body;
};

export const collectionsCreate = async (ctx: Context, name: string, opts: { schema: string }) => {
    if (!COLLECTION_RE.test(name)) throw new CliError("validation_error", "Collection names use a–z, 0–9, _ and -, start with a letter and are at most 64 characters.", { exitCode: 2 });
    const body = { name, ...schemaBody(await readJsonInput(ctx, opts.schema, "the schema"), true) };
    const { ref, client } = await teamProject(ctx, WHAT);
    const c = (await client.post<any>(`${base(ref)}/collections`, { operationId: "createCollection", body, idempotencyKey: true })).data;
    ctx.output.success(c, () => `Created collection ${c.name} (${c.fields?.length ?? 0} fields).\nRecords: perafly data ls ${c.name}\nKeys for your site: perafly data keys`);
};

export const collectionsUpdate = async (ctx: Context, name: string, opts: { schema: string }) => {
    const body = schemaBody(await readJsonInput(ctx, opts.schema, "the schema"), false);
    const { ref, client } = await teamProject(ctx, WHAT);
    const c = (await client.patch<any>(`${base(ref)}/collections/${enc(name)}`, { operationId: "updateCollection", body })).data;
    ctx.output.success(c, () => `Updated collection ${c.name}.\n\n${collectionText(c)}`);
};

export const collectionsRm = async (ctx: Context, name: string, opts: { yes?: boolean }) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Delete collection ${name} and all its records?`, `perafly data collections rm ${name} --project ${ref} --yes`);
    await client.delete(`${base(ref)}/collections/${enc(name)}`, { operationId: "deleteCollection" });
    ctx.output.success({ collection: name, deleted: true }, () => `Deleted collection ${name} and its records.`);
};

/* ─── Kayıtlar ─── */

export type FilterQuery = Record<string, string | Record<string, string>>;

/**
 * `--filter alan=değer` → `filter[alan]=değer`; `--filter alan:op=değer` → `filter[alan][op]=değer` (backend
 * docs/API.md §20.2). Aynı alanda düz değer ve işleç birlikteyse düz değer `eq` olur.
 */
export const parseFilters = (exprs: readonly string[]): FilterQuery => {
    const fields = new Map<string, string | Record<string, string>>();
    for (const expr of exprs) {
        const m = /^([a-z][a-zA-Z0-9_]{0,63})(?::([a-z]+))?=([\s\S]*)$/.exec(expr);
        if (!m) throw new CliError("validation_error", `Bad --filter "${expr}". Use field=value or field:op=value (${OPS.join(", ")}).`, { exitCode: 2 });
        const [, field, op, value] = m as unknown as [string, string, string | undefined, string];
        if (op && !(OPS as readonly string[]).includes(op)) throw new CliError("validation_error", `Unknown filter operator "${op}". Use one of ${OPS.join(", ")}.`, { exitCode: 2 });
        const cur = fields.get(field);
        if (!op) {
            if (cur && typeof cur === "object") cur.eq = value;
            else fields.set(field, value);
            continue;
        }
        const ops: Record<string, string> = cur === undefined ? {} : typeof cur === "string" ? { eq: cur } : cur;
        ops[op] = value;
        fields.set(field, ops);
    }
    return Object.fromEntries(fields);
};

const recordsTable = (rows: any[]): string => {
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!SYSTEM_FIELDS.has(k) && !cols.includes(k)) cols.push(k);
    const shown = cols.slice(0, 4);
    const out = table(rows.map((r) => [safeText(r.id), ...shown.map((c) => safeText(r[c], 32)), when(r.createdAt)]), ["ID", ...shown.map((c) => safeText(c, 32).toUpperCase()), "CREATED"]);
    return cols.length > shown.length ? `${out}\n\n${cols.length - shown.length} more field${cols.length - shown.length === 1 ? "" : "s"} not shown: use --json or perafly data get.` : out;
};

export const recordsLs = async (ctx: Context, collection: string, opts: { filter?: string[]; sort?: string; limit?: string; cursor?: string }) => {
    const filter = parseFilters(opts.filter ?? []);
    if (opts.limit !== undefined && !/^(100|[1-9][0-9]?)$/.test(opts.limit)) throw new CliError("validation_error", "--limit is 1 to 100.", { exitCode: 2 });
    const { ref, client } = await teamProject(ctx, WHAT);
    const res = (await client.get<any>(`${base(ref)}/data/${enc(collection)}`, { operationId: "listRecords", query: { filter, sort: opts.sort, limit: opts.limit, cursor: opts.cursor } })).data;
    const rows: any[] = res.data ?? [];
    ctx.output.success(rows, () => (rows.length ? recordsTable(rows) + (res.nextCursor ? `\n\nMore: --cursor ${res.nextCursor}` : "") : "No records."), { pagination: { nextCursor: res.nextCursor ?? null } });
};

const recordText = (r: any) => table(Object.entries(r).map(([k, v]) => [safeText(k, 64), safeText(v, 200)]));

export const recordsGet = async (ctx: Context, collection: string, id: string) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    const r = (await client.get<any>(`${base(ref)}/data/${enc(collection)}/${enc(id)}`, { operationId: "getRecord" })).data;
    ctx.output.success(r, () => recordText(r));
};

const recordBody = async (ctx: Context, file: string | undefined) => {
    const input = await readJsonInput(ctx, file, "the record");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CliError("validation_error", "A record is a JSON object of field values, e.g. {\"title\": \"Hello\"}.", { exitCode: 2 });
    return input as Record<string, unknown>;
};

export const recordsAdd = async (ctx: Context, collection: string, opts: { file?: string }) => {
    const body = await recordBody(ctx, opts.file);
    const { ref, client } = await teamProject(ctx, WHAT);
    // Idempotency-Key yok: uç tanımıyor; yeniden denenirse kayıt iki kez açılabilir (istemci yalnız GET'i yineler)
    const r = (await client.post<any>(`${base(ref)}/data/${enc(collection)}`, { operationId: "createRecord", body })).data;
    ctx.output.success(r, () => `Added ${r.id} to ${collection}.`);
};

export const recordsUpdate = async (ctx: Context, collection: string, id: string, opts: { file?: string }) => {
    const body = await recordBody(ctx, opts.file);
    const { ref, client } = await teamProject(ctx, WHAT);
    const r = (await client.patch<any>(`${base(ref)}/data/${enc(collection)}/${enc(id)}`, { operationId: "updateRecord", body })).data;
    ctx.output.success(r, () => `Updated ${r.id ?? id} in ${collection}.`);
};

export const recordsRm = async (ctx: Context, collection: string, id: string, opts: { yes?: boolean }) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Delete record ${id} from ${collection}?`, `perafly data rm ${collection} ${id} --project ${ref} --yes`);
    await client.delete(`${base(ref)}/data/${enc(collection)}/${enc(id)}`, { operationId: "deleteRecord" });
    ctx.output.success({ collection, id, deleted: true }, () => `Deleted ${id} from ${collection}.`);
};

/**
 * Dışa aktarma dosyadır, JSON çıktısı değil: `--out` yoksa insan kipinde stdout'a akar; `--json` (ve ajan kipi)
 * `--out` ister. Dosya 0600 açılır (kayıtlar kişisel veri taşıyabilir).
 */
export const recordsExport = async (ctx: Context, collection: string, opts: { format?: string; out?: string }) => {
    const format = opts.format ?? "csv";
    if (!opts.out && ctx.output.json) throw new CliError("validation_error", "With --json, pass --out <file>: the export is a file, not JSON output.", { exitCode: 2 });
    const { ref, client } = await teamProject(ctx, WHAT);
    const res = await client.stream("GET", `${base(ref)}/collections/${enc(collection)}/export`, { operationId: "exportCollection", query: { format } });
    if (!opts.out) return pipeToStdout(ctx, res);
    const file = resolve(ctx.cwd, opts.out);
    const bytes = await saveResponse(res, file, 0o600);
    ctx.output.success({ collection, format, file, bytes }, () => `Exported ${collection} to ${opts.out} (${formatBytes(bytes)}).`);
};

/* ─── Anahtarlar ve kanca teslimleri ─── */

const keysText = (k: any) => [
    table([
        ["Publishable key", k.publishable?.key ? `${k.publishable.key}  (for the browser; not a secret)` : "None yet (created with the first collection)"],
        ["Secret key", k.secret ? `${k.secret.prefix}…  created ${when(k.secret.createdAt)}${k.secret.createdBy?.name ? ` by ${safeText(k.secret.createdBy.name)}` : ""}` : "None. Create one: perafly data keys --create-secret"],
        ["Webhook secret", k.webhook ? `Set (created ${when(k.webhook.createdAt)})` : "None (created with the first change hook)"]
    ]),
    "",
    "Your site reads the secret key and webhook secret as PERAFLY_SECRET_KEY and PERAFLY_WEBHOOK_SECRET from the next version."
].join("\n");

export const keys = async (ctx: Context, opts: { createSecret?: boolean; rotatePublishable?: boolean; revokeSecret?: boolean; yes?: boolean }) => {
    if ([opts.createSecret, opts.rotatePublishable, opts.revokeSecret].filter(Boolean).length > 1) {
        throw new CliError("validation_error", "Pass only one of --create-secret, --rotate-publishable and --revoke-secret.", { exitCode: 2 });
    }
    if (opts.createSecret && ctx.output.json) {
        throw new CliError("validation_error", "The secret key is shown only once and never in --json output. Run without --json in a terminal.", { exitCode: 2 });
    }
    const { ref, client } = await teamProject(ctx, "Data keys");
    const path = `${base(ref)}/data-keys`;
    const confirm = (question: string, flag: string) => requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, question, `perafly data keys ${flag} --project ${ref} --yes`);

    if (opts.rotatePublishable) {
        await confirm("Replace the publishable key? The current one stops working at once, so update your site", "--rotate-publishable");
        const k = (await client.post<any>(`${path}/publishable`, { operationId: "rotatePublishableKey" })).data;
        return ctx.output.success(k, () => `Publishable key replaced. Update your site to use the new key.\n\n${keysText(k)}`);
    }
    if (opts.revokeSecret) {
        await confirm("Revoke the secret key? Server code using it stops working", "--revoke-secret");
        const k = (await client.delete<any>(`${path}/secret`, { operationId: "revokeSecretKey" })).data;
        return ctx.output.success(k, () => `Secret key revoked.\n\n${keysText(k)}`);
    }
    if (opts.createSecret) {
        const current = (await client.get<any>(path, { operationId: "getDataKeys" })).data;
        if (current?.secret) await confirm("Replace the secret key? The current one stops working at once", "--create-secret");
        const out = (await client.post<any>(`${path}/secret`, { operationId: "createSecretKey" })).data;
        // Anahtar yalnız aşağıda, insan çıktısında bir kez yazılır (`--json` yukarıda reddedilir; `secret` alanı ayrıca karartılır)
        ctx.output.success(out, () => "Secret key created. Your site gets it as PERAFLY_SECRET_KEY from the next version. It is shown only now:");
        ctx.output.raw(`\n  ${out.secret}\n\nCopy it now: it won't be shown again. Keep it on the server; never put it in the browser.`);
        return;
    }
    const k = (await client.get<any>(path, { operationId: "getDataKeys" })).data;
    ctx.output.success(k, () => keysText(k));
};

const DELIVERY: Record<string, string> = { pending: "Pending", succeeded: "Delivered", failed: "Failed" };

export const hooks = async (ctx: Context, opts: { collection?: string }) => {
    const { ref, client } = await teamProject(ctx, "Change hooks");
    const rows: any[] = (await client.get<any>(`${base(ref)}/hook-deliveries`, { operationId: "listHookDeliveries", query: { collection: opts.collection } })).data.data ?? [];
    ctx.output.success(rows, () => (rows.length
        ? table(rows.map((d) => [d.id, d.collection, d.type, DELIVERY[d.status] ?? d.status, String(d.attempts ?? 0), d.responseStatus == null ? (d.error ? safeText(d.error, 40) : "—") : String(d.responseStatus), when(d.createdAt)]), ["DELIVERY", "COLLECTION", "EVENT", "STATUS", "ATTEMPTS", "RESPONSE", "CREATED"])
        : "No hook deliveries yet."), { pagination: { nextCursor: null } });
};
