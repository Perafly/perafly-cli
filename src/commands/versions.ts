/**
 * Sürüm ve işlem komutları (README §2): versions ls|get|rm, promote, rollback, operations get|wait, logs build.
 * operationId: listProjectVersions, getProjectVersion, deleteProjectVersion, promoteProjectVersion, getOperation, getBuildLog.
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { requireConfirmation, table } from "../output/index.js";
import { approvalRequired, resume, waitForApproval, type ExecutionBrief } from "../approval.js";

const enc = encodeURIComponent;
const label = (v: any) => (v.number ? `v${v.number}` : v.id);

const versionRow = (v: any) => [label(v), v.state + (v.live ? " (live)" : ""), v.target ?? "", v.url ?? "", v.note ? String(v.note).slice(0, 40) : "", v.createdAt ?? ""];

export const versionsLs = async (ctx: Context, opts: { state?: string; limit?: string; cursor?: string }) => {
    const target = await ctx.requireProjectTarget();
    const client = await ctx.clientFor(target);
    const res = (await client.get<any>(`/v1/projects/${enc(target.ref)}/versions`, { operationId: "listProjectVersions", query: { state: opts.state, limit: opts.limit, cursor: opts.cursor } })).data;
    ctx.output.success(res.data, () => (res.data.length ? table(res.data.map(versionRow), ["VERSION", "STATE", "TARGET", "URL", "NOTE", "CREATED"]) + (res.nextCursor ? `\n\nMore: --cursor ${res.nextCursor}` : "") : "No versions yet."), { pagination: { nextCursor: res.nextCursor ?? null } });
};

export const versionsGet = async (ctx: Context, version: string) => {
    const target = await ctx.requireProjectTarget();
    const v = (await (await ctx.clientFor(target)).get<any>(`/v1/projects/${enc(target.ref)}/versions/${enc(version)}`, { operationId: "getProjectVersion" })).data;
    ctx.output.success(v, () =>
        table([
            ["Version", `${label(v)} (${v.id})`],
            ["State", v.state + (v.live ? ", live" : "")],
            ["URL", v.url ?? "—"],
            ["Target", v.target ?? "—"],
            ["Files", `${v.fileCount ?? 0} (${v.totalBytes ?? 0} bytes)`],
            ["Source", v.source ?? "—"],
            ["Note", v.note || "—"],
            ["Created", `${v.createdAt ?? ""} by ${v.createdBy?.name || v.createdBy?.kind || "?"}`],
            ...(v.error ? [["Error", `${v.error.code}: ${v.error.message}`]] : [])
        ])
    );
};

export const versionsRm = async (ctx: Context, version: string, opts: { yes?: boolean }) => {
    const target = await ctx.requireProjectTarget();
    const client = await ctx.clientFor(target);
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Delete version ${version}?`, `perafly versions rm ${version} --yes`);
    await client.delete(`/v1/projects/${enc(target.ref)}/versions/${enc(version)}`, { operationId: "deleteProjectVersion" });
    ctx.output.success({ version, deleted: true }, () => `Deleted ${version}.`);
};

/**
 * promote ve rollback aynı uçtur; rollback yerel onay ister (README §4.3). Ajan profilli kimlikte sunucu onayı da
 * aranır: `--wait` (varsayılan) kararı bekler, `--no-wait` `approval_required` verir.
 */
export const promote = async (ctx: Context, version: string, opts: { yes?: boolean; rollback?: boolean; wait?: boolean; waitTimeout?: number }) => {
    const target = await ctx.requireProjectTarget();
    const client = await ctx.clientFor(target);
    if (opts.rollback) await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Roll the live site back to ${version}?`, `perafly rollback ${version} --yes`);
    let res: any;
    try {
        res = (await client.post<any>(`/v1/projects/${enc(target.ref)}/versions/${enc(version)}/promote`, { operationId: "promoteProjectVersion", idempotencyKey: true })).data;
    } catch (error) {
        const execution = error instanceof CliError && error.code === "approval_required" ? (error.details.execution as ExecutionBrief | undefined) : undefined;
        if (!execution) throw error;
        if (opts.wait === false) throw approvalRequired(execution);
        await waitForApproval(client, execution, { output: ctx.output, timeoutSeconds: opts.waitTimeout ?? 900, sleep: ctx.deps.sleep });
        res = await resume(client, execution.id);
    }
    ctx.output.success({ project: res.project, version: res.version, live: true }, () => `${label(res.version)} is live at ${res.project?.urls?.live ?? ""}. Nothing was rebuilt.`);
};

/** `operations resume <exe_…>`: onaylanmış işin sonucu; karar yoksa bekler (README §2) */
export const operationsResume = async (ctx: Context, id: string, opts: { wait?: boolean; timeout?: number }) => {
    if (!/^exe_[0-9a-z]{24}$/.test(id)) throw new CliError("validation_error", "Pass an execution id (exe_…).", { exitCode: 2 });
    const { client } = await ctx.requireApiKey();
    let out: any;
    try {
        out = await resume(client, id);
    } catch (error) {
        if (!(error instanceof CliError) || error.code !== "approval_pending") throw error;
        const execution = (error.details.execution as ExecutionBrief | undefined) ?? { id, status: "pending" };
        if (opts.wait === false) throw approvalRequired(execution);
        await waitForApproval(client, execution, { output: ctx.output, timeoutSeconds: opts.timeout ?? 900, sleep: ctx.deps.sleep });
        out = await resume(client, id);
    }
    ctx.output.success(out, () => `${out.execution?.kind === "publish" ? "Published" : "Promoted"}: ${out.version ? label(out.version) : ""} is live at ${out.project?.urls?.live ?? ""}.`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const operationsGet = async (ctx: Context, id: string, opts: { wait?: boolean; timeout?: number }) => {
    if (!/^opr_[0-9a-z]{24}$/.test(id)) throw new CliError("validation_error", "Pass an operation id (opr_…).", { exitCode: 2 });
    const key = await ctx.apiKey();
    const pk = key ? null : await ctx.projectKey();
    if (!key && !pk) throw ctx.authRequired();
    const client = ctx.client(key?.token ?? pk!.token);
    const deadline = Date.now() + (opts.timeout ?? 900) * 1000;
    let op = (await client.get<any>(`/v1/operations/${enc(id)}`, { operationId: "getOperation" })).data;
    while (opts.wait && op.status === "running") {
        if (Date.now() > deadline) throw new CliError("wait_timeout", "Still running. It continues on the server.", { exitCode: 50, recovery: `perafly operations wait ${id}` });
        await (ctx.deps.sleep ?? sleep)(2000);
        op = (await client.get<any>(`/v1/operations/${enc(id)}`, { operationId: "getOperation" })).data;
    }
    if (opts.wait && op.status === "failed") throw new CliError(op.error?.code || "operation_failed", `Operation failed: ${op.error?.message || "unknown error"}`, { exitCode: 1 });
    ctx.output.success(op, () => table([["Operation", op.id], ["Kind", op.kind], ["Status", op.status], ["Version", op.versionId ?? "—"], ...(op.error ? [["Error", `${op.error.code}: ${op.error.message}`]] : [])]));
};

export const logsBuild = async (ctx: Context, opts: { version?: string }) => {
    const target = await ctx.requireProjectTarget();
    const client = await ctx.clientFor(target);
    const res = (await client.get<any>(`/v1/projects/${enc(target.ref)}/logs/build`, { operationId: "getBuildLog", query: { version: opts.version } })).data;
    const lines: any[] = res.lines ?? [];
    ctx.output.success(res, () => [`Build log of ${res.version ? label(res.version) : "latest version"}${res.done ? "" : " (still running)"}:`, ...lines.map((l) => `${l.at}  ${l.level === "error" ? "ERROR " : l.level === "warn" ? "WARN  " : ""}${l.text}`), lines.length ? "" : "(no lines)"].join("\n"));
};
