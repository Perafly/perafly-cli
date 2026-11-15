/**
 * `agent` (README §2; backend docs/API.md §17.6): Perafly'ın yerleşik ajanı.
 *
 *   perafly agent "<tarif>" [--project p] [--budget 5] [--new] [--no-wait|--detach]   yeni oturum açar, ilerlemeyi izler,
 *                                                                                      önizleme adresini yazar
 *   perafly agent --session <ags> ["<ileti>"] [--detach]   var olan oturuma iletiyi gönderir (`say`) ve izler; ileti
 *                                                          yoksa izler (`attach`)
 *   perafly agent ls | attach <ags> | say <ags> "<ileti>" | stop <ags> | budget <ags> <dolar> | allow|deny <ags> <olay>
 *
 * Tarif ya da ileti `-` ise stdin'den okunur. `--detach` `--no-wait` ile aynıdır: gönderir, oturum kimliğini yazar,
 * izlemez.
 *
 * Yalnız tam profilli girişle (sunucu ajan profilini 403 ile reddeder: ajan kredisini başka bir ajan harcamaz). Ajan
 * yalnız önizleme yayınlar; canlıya almak `perafly promote` ya da panel işidir. İzlerken olaylar `?after=<seq>` ile
 * 2 sn'de bir okunur; `--json`'da çıktı son oturum ve olaylardır.
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { table } from "../output/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const usd = (cents: number | null | undefined) => (typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "—");
const SESSION_RE = /^ags_[0-9a-z]{24}$/;
const BUSY = new Set(["starting", "running"]);

const needSession = (id: string) => {
    if (!SESSION_RE.test(id)) throw new CliError("validation_error", "Pass an agent session id (ags_…).", { exitCode: 2 });
};

const cents = (dollars: string | undefined): number | undefined => {
    if (dollars === undefined) return undefined;
    const n = Number(dollars);
    if (!Number.isFinite(n) || n <= 0) throw new CliError("validation_error", "--budget is in US dollars, for example --budget 5", { exitCode: 2 });
    return Math.round(n * 100);
};

const line = (e: any): string | null => {
    switch (e.type) {
        case "user.message": return `› ${e.text}`;
        case "agent.message": return `${e.agent ? `${e.agent}: ` : ""}${e.text}`;
        case "agent.tool": return `  · ${e.tool} ${e.summary}${e.decision ? ` (${e.decision})` : ""}`;
        case "agent.thread": return `  ↳ ${e.agent} ${e.action === "started" ? "got a task" : e.action === "finished" ? "reported back" : "message"}`;
        case "preview": return `Preview ready: ${e.version?.url ?? e.version?.id} (${e.project?.name} v${e.version?.number ?? "?"})`;
        case "outcome": return `  ✓ checks: ${e.result}`;
        case "status": return `  [${e.status}${e.stopReason ? `: ${e.stopReason}` : ""}]`;
        case "error": return `Error: ${e.message}`;
        default: return null;
    }
};

const statusNote = (s: any): string => {
    switch (s.status) {
        case "waiting": return `The agent is waiting for approval: ${s.pending.map((p: any) => `${p.tool} ${p.summary} → perafly agent allow ${s.id} ${p.id}`).join("; ")}`;
        case "paused": return `Paused: the budget is used up. Raise it with: perafly agent budget ${s.id} <dollars>`;
        case "failed": return "The session failed. Start a new one.";
        case "ended": return "The session has ended.";
        default: return s.previews?.length ? `Make a preview live with: perafly promote <version> --project ${s.project?.name ?? "<project>"}` : "";
    }
};

/** Oturumu izler: yeni olayları yazar, ajan durunca döner */
const follow = async (ctx: Context, client: any, id: string, opts: { after?: number; timeoutSeconds: number }) => {
    let after = opts.after ?? 0;
    const all: any[] = [];
    const deadline = Date.now() + opts.timeoutSeconds * 1000;
    for (;;) {
        const page = (await client.get(`/v1/agent/sessions/${enc(id)}/events`, { operationId: "listAgentEvents", query: { after: String(after), limit: "200" } })).data;
        for (const e of page.data ?? []) {
            all.push(e);
            const text = line(e);
            if (text) ctx.output.info(text);
        }
        after = page.nextAfter ?? after;
        const s = (await client.get(`/v1/agent/sessions/${enc(id)}`, { operationId: "getAgentSession" })).data;
        if (!BUSY.has(s.status)) return { session: s, events: all };
        if (Date.now() > deadline) throw new CliError("wait_timeout", "The agent is still working. It continues on the server.", { exitCode: 50, recovery: `perafly agent attach ${id}` });
        await (ctx.deps.sleep ?? sleep)(2000);
    }
};

const finish = (ctx: Context, result: { session: any; events: any[] }) => {
    const s = result.session;
    ctx.output.success({ session: s, events: result.events }, () => {
        const previews = (s.previews ?? []).map((p: any) => `  v${p.number ?? "?"}  ${p.url ?? p.versionId}`);
        return [
            table([["Session", s.id], ["Status", s.status], ["Project", s.project?.name ?? "—"], ["Spent", `${usd(s.budget?.chargedCents)} of ${usd(s.budget?.cents)}`]]),
            ...(previews.length ? ["", "Previews:", ...previews] : []),
            statusNote(s) ? `\n${statusNote(s)}` : ""
        ].join("\n");
    });
    if (s.status === "failed") throw new CliError("agent_session_failed", "The agent session failed.", { exitCode: 1 });
};

export interface AgentFlags {
    project?: string;
    budget?: string;
    wait?: boolean;
    waitTimeout?: number;
    detach?: boolean;
    session?: string;
    new?: boolean;
}

/** Tarif `-` ise stdin'den (en çok 64 KB) */
const readBrief = async (ctx: Context, brief: string): Promise<string> => {
    if (brief.trim() !== "-") return brief;
    const stdin = ctx.deps.stdin ?? process.stdin;
    if (stdin.isTTY) ctx.output.info("Type the brief, then press Ctrl-D.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin as AsyncIterable<Buffer | string>) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > 64 * 1024) throw new CliError("validation_error", "The brief on stdin is longer than 64 KB.", { exitCode: 2 });
        chunks.push(b);
    }
    return Buffer.concat(chunks).toString("utf8");
};

/**
 * Üst komut: `--session` varsa var olan oturuma ileti (`say`) ya da izleme (`attach`); yoksa yeni oturum (`--new`
 * varsayılandır). `--detach` = `--no-wait`. Bütçe yalnız yeni oturumda (`--budget`) ya da `agent budget` ile değişir.
 */
export const agent = async (ctx: Context, brief: string, opts: AgentFlags) => {
    const wait = opts.wait !== false && !opts.detach;
    const waitTimeout = opts.waitTimeout ?? 3600;
    if (opts.session !== undefined) {
        if (opts.new) throw new CliError("validation_error", "Pass either --session (continue a session) or --new (start one), not both.", { exitCode: 2 });
        if (opts.project) throw new CliError("validation_error", "--project applies only to a new session; the session already has its project.", { exitCode: 2 });
        if (opts.budget !== undefined) throw new CliError("validation_error", `--budget applies only to a new session. Change this session's budget with: perafly agent budget ${opts.session} <dollars>`, { exitCode: 2 });
        needSession(opts.session);
        const text = (await readBrief(ctx, brief ?? "")).trim();
        if (!text) {
            if (!wait) throw new CliError("validation_error", "Nothing to send. Pass a message, or drop --detach to follow the session.", { exitCode: 2 });
            return attach(ctx, opts.session, { waitTimeout });
        }
        return say(ctx, opts.session, text, { wait, waitTimeout });
    }
    return start(ctx, await readBrief(ctx, brief ?? ""), { project: opts.project, budget: opts.budget, wait, waitTimeout });
};

export const start = async (ctx: Context, brief: string, opts: { project?: string; budget?: string; wait?: boolean; waitTimeout?: number }) => {
    const prompt = (brief ?? "").trim();
    if (!prompt) throw new CliError("validation_error", "Describe what the agent should build, for example: perafly agent \"A one-page site for my bakery\"", { exitCode: 2 });
    const { client } = await ctx.requireApiKey();
    const body: Record<string, unknown> = { prompt };
    if (opts.project) body.project = opts.project;
    const budget = cents(opts.budget);
    if (budget !== undefined) body.budgetCents = budget;
    const s = (await client.post<any>("/v1/agent/sessions", { operationId: "startAgentSession", body })).data;
    ctx.output.info(`Started ${s.id} with a budget of ${usd(s.budget?.cents)}. It continues on the server if you stop watching.`);
    if (opts.wait === false) return ctx.output.success(s, () => `${s.id}\nFollow it with: perafly agent attach ${s.id}`);
    return finish(ctx, await follow(ctx, client, s.id, { timeoutSeconds: opts.waitTimeout ?? 3600 }));
};

export const ls = async (ctx: Context, opts: { project?: string }) => {
    const { client } = await ctx.requireApiKey();
    const res = (await client.get<any>("/v1/agent/sessions", { operationId: "listAgentSessions", query: opts.project ? { project: opts.project } : {} })).data;
    const rows: any[] = res.data ?? [];
    ctx.output.success(rows, () => (rows.length ? table(rows.map((s) => [s.id, s.status, s.project?.name ?? "—", `${usd(s.budget?.chargedCents)}/${usd(s.budget?.cents)}`, s.title]), ["SESSION", "STATUS", "PROJECT", "SPENT", "BRIEF"]) : "No agent sessions."), { pagination: { nextCursor: null } });
};

export const attach = async (ctx: Context, id: string, opts: { waitTimeout?: number }) => {
    needSession(id);
    const { client } = await ctx.requireApiKey();
    return finish(ctx, await follow(ctx, client, id, { timeoutSeconds: opts.waitTimeout ?? 3600 }));
};

export const say = async (ctx: Context, id: string, text: string, opts: { wait?: boolean; waitTimeout?: number }) => {
    needSession(id);
    const message = (text ?? "").trim();
    if (!message) throw new CliError("validation_error", "Write a message.", { exitCode: 2 });
    const { client } = await ctx.requireApiKey();
    // İzlenecekse önceki olaylar atlanır (yalnız bu iletiden sonrası yazılır)
    const before = opts.wait === false ? null : (await client.get<any>(`/v1/agent/sessions/${enc(id)}/events`, { operationId: "listAgentEvents", query: { after: "0", limit: "200" } })).data;
    const s = (await client.post<any>(`/v1/agent/sessions/${enc(id)}/messages`, { operationId: "sendAgentMessage", body: { text: message } })).data;
    if (opts.wait === false || !before) return ctx.output.success(s, () => `Sent to ${id}.\nFollow it with: perafly agent attach ${id}`);
    return finish(ctx, await follow(ctx, client, id, { after: before.nextAfter ?? 0, timeoutSeconds: opts.waitTimeout ?? 3600 }));
};

export const stop = async (ctx: Context, id: string) => {
    needSession(id);
    const { client } = await ctx.requireApiKey();
    const s = (await client.post<any>(`/v1/agent/sessions/${enc(id)}/interrupt`, { operationId: "interruptAgentSession" })).data;
    ctx.output.success(s, () => `Stopped what the agent was doing. Send a new message with: perafly agent say ${id} "…"`);
};

export const budget = async (ctx: Context, id: string, dollars: string) => {
    needSession(id);
    const value = cents(dollars)!;
    const { client } = await ctx.requireApiKey();
    const s = (await client.post<any>(`/v1/agent/sessions/${enc(id)}/budget`, { operationId: "setAgentBudget", body: { budgetCents: value } })).data;
    ctx.output.success(s, () => `Budget is ${usd(s.budget?.cents)}. ${s.status === "running" ? `The agent continues: perafly agent attach ${id}` : ""}`.trim());
};

export const decide = async (ctx: Context, id: string, eventId: string, allow: boolean, opts: { message?: string }) => {
    needSession(id);
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(eventId)) throw new CliError("validation_error", "Pass the pending event id shown by perafly agent attach.", { exitCode: 2 });
    const { client } = await ctx.requireApiKey();
    const s = (await client.post<any>(`/v1/agent/sessions/${enc(id)}/confirmations/${enc(eventId)}`, { operationId: "confirmAgentTool", body: { allow, ...(opts.message ? { message: opts.message } : {}) } })).data;
    ctx.output.success(s, () => `${allow ? "Allowed" : "Denied"}. Follow it with: perafly agent attach ${id}`);
};
