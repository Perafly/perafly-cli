/**
 * Yerel MCP sunucusu: `perafly mcp` (stdio; README §2.5, §6). stdout yalnız MCP protokolünü taşır; tanılama stderr'e.
 *
 * Kimlik CLI'ınkiyle aynıdır (`PERAFLY_TOKEN` → kayıtlı giriş → klasörün ajan anahtarı → hesapsız projenin anahtarı).
 * Araçlar OpenAPI'den üretilir; yerel `publish` aracı dosyaları satır içi değil, çalışma kökündeki bir klasörden okur
 * (src/mcp/files.ts). Araç sonucuna anahtar, imzalı adres ve sahiplenme bağlantısı yazılmaz (`redactDeep`).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, type ContextDeps } from "../context.js";
import { CliError } from "../errors.js";
import { redactDeep } from "../auth/redact.js";
import { toErrorObject } from "../output/index.js";
import { runPublish } from "../publish/run.js";
import { jsonResult } from "../commands/publish.js";
import { resume } from "../approval.js";
import { VERSION } from "../version.js";
import { resolveInsideRoot } from "./files.js";
import { AGENT_RULES, OPERATION_PERMISSION, operationSpecs, type OpSpec } from "./tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (value: unknown): ToolResult => {
    const safe = redactDeep(value) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }], structuredContent: safe && typeof safe === "object" && !Array.isArray(safe) ? safe : { result: safe } };
};
const fail = (error: unknown): ToolResult => {
    const obj = toErrorObject(error);
    const exe = (obj.details?.execution as { id?: string; approvalUrl?: string } | undefined) ?? undefined;
    // MCP'de sürdürme aracı resume_execution'dır (CLI komutu değil)
    const value = obj.code === "approval_required" && exe?.id
        ? { error: { ...obj, recovery: null }, next: `Give the user ${exe.approvalUrl ?? "the approval link"}. After they approve, call resume_execution with ${exe.id}. Don't publish or promote again.` }
        : { error: obj };
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: true };
};

export const LOCAL_PUBLISH_TOOL = {
    name: "publish",
    title: "Publish a folder",
    description: "Publish a folder (or one HTML file, or a .zip/.tar.gz) from the workspace. Uploads only changed files, waits until the version is ready. Without a sign-in it creates a project without an account (claim it with the CLI). Publishing over the live version with an agent sign-in returns approval_required: give the user approvalUrl, then call resume_execution.",
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "Folder or file inside the workspace, e.g. dist. Default: the workspace root" },
            project: { type: "string", description: "Project id or name; default: the folder's linked project, or a new project" },
            name: { type: "string", description: "Name of a new project" },
            target: { enum: ["live", "preview"], default: "live" },
            mode: { enum: ["snapshot", "additive"], default: "snapshot" },
            note: { type: "string", maxLength: 500 },
            prebuilt: { type: "boolean", description: "Ready-made output: don't apply .gitignore rules" }
        },
        additionalProperties: false
    }
};

const OPERATION_STATUS_TOOL = {
    name: "operation_status",
    title: "Operation status",
    description: "Status of a long-running operation (opr_…). With wait: true, waits until it finishes (up to 55 s). Report success only when the status is succeeded.",
    inputSchema: { type: "object", properties: { operation: { type: "string" }, wait: { type: "boolean" } }, required: ["operation"], additionalProperties: false }
};

const RESUME_TOOL = {
    name: "resume_execution",
    title: "Resume an approved action",
    description: "After a teammate approves an action that returned approval_required (execution exe_…), returns its result. If still pending, try again later. Never start the same action again instead.",
    inputSchema: { type: "object", properties: { execution: { type: "string" } }, required: ["execution"], additionalProperties: false }
};

export interface LocalServerOptions {
    root: string;
    flags?: { apiUrl?: string; profile?: string };
    deps?: ContextDeps;
}

/** Araç listesi ve çağrı işleyicisi (taşıyıcıdan bağımsız; testler doğrudan çağırır) */
export const createLocalHandlers = (opts: LocalServerOptions) => {
    const deps: ContextDeps = { ...opts.deps, stdout: opts.deps?.stdout ?? process.stderr };
    const ctxFor = (extra: { project?: string } = {}) => Context.create({ cwd: opts.root, json: true, apiUrl: opts.flags?.apiUrl, profile: opts.flags?.profile, project: extra.project }, deps);
    let permCache: { at: number; perms: Set<string> | null } | null = null;

    const credential = async (ctx: Context) => {
        const key = await ctx.apiKey();
        if (key) return key.token;
        const pk = await ctx.projectKey();
        return pk?.token ?? null;
    };

    const permissions = async (): Promise<Set<string> | null> => {
        if (permCache && Date.now() - permCache.at < 60_000) return permCache.perms;
        const ctx = await ctxFor();
        const token = await credential(ctx);
        let perms: Set<string> | null = null;
        if (token) {
            try {
                const me = await ctx.client(token).get<any>("/v1/me", { operationId: "getMe" });
                perms = new Set<string>(me.data.permissions ?? []);
            } catch {
                perms = null;
            }
        }
        permCache = { at: Date.now(), perms };
        return perms;
    };

    const listTools = async () => {
        const perms = await permissions();
        const tools: any[] = [];
        if (perms) {
            for (const s of operationSpecs()) {
                const need = OPERATION_PERMISSION[s.operationId];
                if (need === null || (need && perms.has(need))) tools.push({ name: s.operationId, description: s.summary, inputSchema: s.schema, annotations: { readOnlyHint: s.method === "GET", destructiveHint: s.method === "DELETE" } });
            }
        }
        if (!perms || perms.has("publish.write")) tools.push(LOCAL_PUBLISH_TOOL);
        if (perms) tools.push(OPERATION_STATUS_TOOL, RESUME_TOOL);
        return tools;
    };

    const runOperation = async (spec: OpSpec, args: any) => {
        const a = args && typeof args === "object" ? args : {};
        let path = spec.path;
        for (const p of spec.pathParams) {
            if (typeof a[p] !== "string" || !a[p]) throw new CliError("validation_error", `${p} is required`, { exitCode: 2 });
            path = path.replace(`{${p}}`, encodeURIComponent(a[p]));
        }
        // Nesne değer (deepObject `filter`) istemcide `filter[alan][op]=…` olarak açılır
        const query: Record<string, unknown> = {};
        for (const q of spec.queryParams) if (a[q] !== undefined) query[q] = a[q];
        let body: unknown;
        if (spec.bodyNested) body = a.body;
        else if (spec.bodyKeys.length) {
            const b: Record<string, unknown> = {};
            for (const k of spec.bodyKeys) if (a[k] !== undefined) b[k] = a[k];
            body = b;
        }
        const ctx = await ctxFor();
        const token = await credential(ctx);
        if (!token) throw ctx.authRequired();
        const res = await ctx.client(token).request<any>(spec.method, path, { operationId: spec.operationId, query, body, idempotencyKey: spec.method === "POST" ? true : undefined });
        return res.data ?? { ok: true };
    };

    const callTool = async (name: string, args: any): Promise<ToolResult> => {
        try {
            if (name === "publish") {
                const ctx = await ctxFor({ project: typeof args?.project === "string" ? args.project : undefined });
                const dir = await resolveInsideRoot(opts.root, args?.path);
                const r = await runPublish(ctx, {
                    dir, name: args?.name, message: args?.note, target: args?.target, mode: args?.mode, prebuilt: !!args?.prebuilt,
                    wait: true, waitTimeoutSeconds: 240, approvalWait: false
                });
                permCache = null;
                return ok({ ...jsonResult(r), ...(r.claim ? { claimed: false, next: "Published without an account. The user can keep it with: perafly projects claim" } : {}) });
            }
            if (name === "operation_status") {
                const ctx = await ctxFor();
                const token = await credential(ctx);
                if (!token) throw ctx.authRequired();
                const deadline = Date.now() + (args?.wait ? 55_000 : 0);
                for (;;) {
                    const r = await ctx.client(token).get<any>(`/v1/operations/${encodeURIComponent(String(args?.operation ?? ""))}`, { operationId: "getOperation" });
                    if (r.data?.status !== "running" || Date.now() > deadline) return ok(r.data);
                    await new Promise((res) => setTimeout(res, 2000));
                }
            }
            if (name === "resume_execution") {
                const ctx = await ctxFor();
                const token = await credential(ctx);
                if (!token) throw ctx.authRequired();
                return ok(await resume(ctx.client(token), String(args?.execution ?? "")));
            }
            const spec = operationSpecs().find((s) => s.operationId === name);
            if (!spec) throw new CliError("validation_error", `Unknown tool: ${name}`, { exitCode: 2 });
            return ok(await runOperation(spec, args));
        } catch (error) {
            return fail(error);
        }
    };

    return { listTools, callTool };
};

export const startLocalServer = async (opts: LocalServerOptions) => {
    const server = new Server({ name: "perafly", title: "Perafly", version: VERSION }, { capabilities: { tools: {} }, instructions: AGENT_RULES });
    const h = createLocalHandlers(opts);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await h.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => (await h.callTool(req.params.name, req.params.arguments ?? {})) as any);
    const closed = new Promise<void>((resolve) => {
        server.onclose = () => resolve();
        process.stdin.once("end", () => resolve());
    });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`Perafly MCP server ${VERSION} (workspace ${opts.root})\n`);
    // İstemci bağlantıyı kapatana dek süreç açık kalır
    await closed;
};
