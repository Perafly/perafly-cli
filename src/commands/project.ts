/**
 * Proje komutları (README §2): init, link, unlink, status, open, projects ls|get|create|update|rm|claim.
 * operationId: listProjects, getProject, createProject, updateProject, deleteProject, claimProject, getMe.
 */
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { projectRefFromInput, readProjectLink, removeProjectLink, writeProjectLink } from "../config/index.js";
import { defaultPeraflyConfig, PERAFLY_JSONC, readPeraflyConfig } from "../config/jsonc.js";
import { readState, saveClaimResult } from "../publish/state.js";
import { openUrl } from "../open.js";
import { requireConfirmation, table } from "../output/index.js";
import { login } from "./auth.js";

const enc = encodeURIComponent;

export const projectLine = (p: any) => `${p.name}${p.title ? ` (${p.title})` : ""}`;
const liveLabel = (p: any) => (p.liveVersion ? `v${p.liveVersion.number}` : "—");

export const describeProject = (p: any) =>
    table([
        ["Project", `${p.name} (${p.id})`],
        ...(p.title ? [["Title", p.title]] : []),
        ["Live URL", p.urls?.live ?? "—"],
        ["Live", p.liveVersion ? `v${p.liveVersion.number}${p.liveVersion.liveSince ? ` since ${p.liveVersion.liveSince}` : ""}` : "nothing live yet"],
        ["Latest", p.latestVersion ? `${p.latestVersion.number ? `v${p.latestVersion.number}` : p.latestVersion.id} (${p.latestVersion.state})` : "—"],
        ["Versions", String(p.versionCount ?? 0)],
        ["Publish rule", p.publishRule ?? "auto"],
        ...(p.anonymous ? [["Expires", `${p.anonymous.expiresAt}${p.anonymous.expired ? " (expired)" : ""}`], ["Claim before", p.anonymous.claimDeadline]] : []),
        ...(p.takenDown ? [["Status", "taken down by Perafly"]] : [])
    ]);

export const init = async (ctx: Context, opts: { create?: boolean; name?: string }) => {
    const file = join(ctx.cwd, PERAFLY_JSONC);
    const exists = await stat(file).then(() => true).catch(() => false);
    if (exists) await readPeraflyConfig(ctx.cwd);
    else await writeFile(file, defaultPeraflyConfig(), { flag: "wx" });
    let project: any = null;
    if (opts.create) {
        if (ctx.settings.link) throw new CliError("validation_error", "This folder is already linked. Run perafly unlink first.", { exitCode: 2 });
        const { client } = await ctx.requireApiKey();
        project = (await client.post<any>("/v1/projects", { operationId: "createProject", body: opts.name ? { name: opts.name } : {}, idempotencyKey: true })).data;
        await writeProjectLink(ctx.cwd, { projectId: project.id, projectName: project.name, teamId: project.teamId ?? null, apiUrl: ctx.apiUrl });
    }
    ctx.output.success({ file: PERAFLY_JSONC, created: !exists, project }, () =>
        [exists ? `${PERAFLY_JSONC} already exists and is valid.` : `Wrote ${PERAFLY_JSONC}.`, project ? `Created and linked ${project.name} (${project.id}).` : ""].filter(Boolean).join("\n")
    );
};

export const link = async (ctx: Context, ref?: string) => {
    const { client } = await ctx.requireApiKey();
    let id = ref ? projectRefFromInput(ref) : null;
    if (!id) {
        const list = (await client.get<any>("/v1/projects", { operationId: "listProjects", query: { limit: 100 } })).data.data as any[];
        if (list.length === 1) id = list[0].id;
        else throw new CliError("no_project_selected", list.length ? "Pass the project to link." : "No projects yet. Run perafly publish.", { exitCode: 2, suggestions: list.map((p) => p.name), recovery: list.length ? "perafly link <project>" : "perafly publish" });
    }
    const p = (await client.get<any>(`/v1/projects/${enc(id!)}`, { operationId: "getProject" })).data;
    await writeProjectLink(ctx.cwd, { projectId: p.id, projectName: p.name, teamId: p.teamId ?? null, apiUrl: ctx.apiUrl });
    ctx.output.success({ project: p }, () => `Linked this folder to ${p.name} (${p.id}).`);
};

export const unlink = async (ctx: Context, opts: { yes?: boolean }) => {
    const current = await readProjectLink(ctx.cwd);
    if (!current) {
        ctx.output.success({ removed: false }, () => "This folder is not linked.");
        return;
    }
    // Yerel işlem: ajan kipinde PERAFLY_AGENT_ALLOW_DESTRUCTIVE=1 de onaylar
    const allow = opts.yes || ["1", "true", "yes"].includes(String(ctx.env.PERAFLY_AGENT_ALLOW_DESTRUCTIVE || "").toLowerCase());
    await requireConfirmation(ctx.output, { yes: allow, env: ctx.env }, `Unlink this folder from ${current.projectName ?? current.projectId}?`, "perafly unlink --yes");
    await removeProjectLink(ctx.cwd);
    ctx.output.success({ removed: true, projectId: current.projectId }, () => `Unlinked ${current.projectName ?? current.projectId}. The project itself is unchanged.`);
};

export const status = async (ctx: Context) => {
    const key = await ctx.apiKey();
    const state = await readState(ctx.cwd);
    const target = await ctx.projectTarget().catch(() => null);
    let project: any = null;
    let projectError: string | null = null;
    if (target) {
        try {
            project = (await (await ctx.clientFor(target)).get<any>(`/v1/projects/${enc(target.ref)}`, { operationId: "getProject" })).data;
        } catch (error) {
            projectError = (error as Error).message;
        }
    }
    const data = {
        apiUrl: ctx.apiUrl,
        profile: ctx.settings.profile,
        signedIn: !!key,
        credentialSource: key?.source ?? null,
        team: key?.credential?.team ?? (ctx.settings.profileConfig.teamId ? { id: ctx.settings.profileConfig.teamId, name: ctx.settings.profileConfig.teamName ?? "" } : null),
        project,
        anonymous: state.anonymous ? { projectId: state.anonymous.projectId, projectName: state.anonymous.projectName, expiresAt: state.anonymous.expiresAt, claimDeadline: state.anonymous.claimDeadline } : null,
        error: projectError
    };
    ctx.output.success(data, () =>
        [
            table([
                ["Signed in", key ? `yes (${key.source}${key.credential?.team ? `, team ${key.credential.team.name}` : ""})` : "no"],
                ["Profile", ctx.settings.profile],
                ["API", ctx.apiUrl],
                ["Project", project ? `${project.name} (${project.id})` : target ? target.ref : "not linked"],
                ...(project ? [["Live URL", project.urls?.live ?? "—"], ["Live", liveLabel(project)]] : []),
                ...(state.anonymous ? [["Without account", `${state.anonymous.projectName ?? state.anonymous.projectId}, live until ${project?.anonymous?.expiresAt ?? state.anonymous.expiresAt ?? "?"}`]] : [])
            ]),
            projectError ? `\nCould not load the project: ${projectError}` : "",
            state.anonymous ? "\nRun perafly projects claim to keep it." : !key ? "\nRun perafly login to sign in." : ""
        ].join("")
    );
};

export const open = async (ctx: Context, opts: { version?: string }) => {
    const target = await ctx.requireProjectTarget();
    const client = await ctx.clientFor(target);
    const p = (await client.get<any>(`/v1/projects/${enc(target.ref)}`, { operationId: "getProject" })).data;
    let url: string | null = p.urls?.live ?? null;
    if (opts.version) url = (await client.get<any>(`/v1/projects/${enc(p.id)}/versions/${enc(opts.version)}`, { operationId: "getProjectVersion" })).data.url ?? null;
    if (!url) throw new CliError("not_found", "Nothing to open yet.", { exitCode: 20 });
    if (ctx.output.interactive) await (ctx.deps.openUrl ?? openUrl)(url);
    ctx.output.success({ url }, () => url!);
};

/* ─── projects ─── */

export const projectsLs = async (ctx: Context, opts: { q?: string; limit?: string; cursor?: string }) => {
    const { client } = await ctx.requireApiKey();
    const res = (await client.get<any>("/v1/projects", { operationId: "listProjects", query: { q: opts.q, limit: opts.limit, cursor: opts.cursor } })).data;
    ctx.output.success(res.data, () => (res.data.length ? table(res.data.map((p: any) => [p.name, p.id, liveLabel(p), p.urls?.live ?? ""]), ["NAME", "ID", "LIVE", "URL"]) + (res.nextCursor ? `\n\nMore: --cursor ${res.nextCursor}` : "") : "No projects."), { pagination: { nextCursor: res.nextCursor ?? null } });
};

export const projectsGet = async (ctx: Context, ref?: string) => {
    const target = ref ? { ref: projectRefFromInput(ref), source: "flag" as const, anonymous: false as const } : await ctx.requireProjectTarget();
    const p = (await (await ctx.clientFor(target)).get<any>(`/v1/projects/${enc(target.ref)}`, { operationId: "getProject" })).data;
    ctx.output.success(p, () => describeProject(p));
};

export const projectsCreate = async (ctx: Context, opts: { name?: string; title?: string; link?: boolean }) => {
    const { client } = await ctx.requireApiKey();
    const p = (await client.post<any>("/v1/projects", { operationId: "createProject", body: { ...(opts.name ? { name: opts.name } : {}), ...(opts.title ? { title: opts.title } : {}) }, idempotencyKey: true })).data;
    if (opts.link) await writeProjectLink(ctx.cwd, { projectId: p.id, projectName: p.name, teamId: p.teamId ?? null, apiUrl: ctx.apiUrl });
    ctx.output.success(p, () => `Created ${p.name} (${p.id}).${opts.link ? " Linked this folder." : ""}`);
};

export const projectsUpdate = async (ctx: Context, ref: string | undefined, opts: { name?: string; title?: string; publishRule?: string }) => {
    const body: Record<string, unknown> = {};
    if (opts.name) body.name = opts.name;
    if (opts.title !== undefined) body.title = opts.title === "" ? null : opts.title;
    if (opts.publishRule) {
        if (opts.publishRule !== "auto" && opts.publishRule !== "manual") throw new CliError("validation_error", "--publish-rule must be auto or manual", { exitCode: 2 });
        body.publishRule = opts.publishRule;
    }
    if (!Object.keys(body).length) throw new CliError("validation_error", "Nothing to update. Pass --name, --title or --publish-rule.", { exitCode: 2 });
    const { client } = await ctx.requireApiKey();
    const target = ref ? projectRefFromInput(ref) : (await ctx.requireProjectTarget()).ref;
    const p = (await client.patch<any>(`/v1/projects/${enc(target)}`, { operationId: "updateProject", body })).data;
    const link = ctx.settings.link;
    if (link && link.projectId === p.id && link.projectName !== p.name) await writeProjectLink(ctx.cwd, { ...link, projectName: p.name });
    ctx.output.success(p, () => `Updated ${p.name} (${p.id}).`);
};

export const projectsRm = async (ctx: Context, ref: string | undefined, opts: { yes?: boolean }) => {
    const { client } = await ctx.requireApiKey();
    const target = ref ? projectRefFromInput(ref) : (await ctx.requireProjectTarget()).ref;
    const p = (await client.get<any>(`/v1/projects/${enc(target)}`, { operationId: "getProject" })).data;
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Delete ${p.name} and all its versions? This can't be undone`, `perafly projects rm ${p.name} --yes`);
    await client.delete(`/v1/projects/${enc(p.id)}`, { operationId: "deleteProject", body: { confirmName: p.name } });
    if (ctx.settings.link?.projectId === p.id) await removeProjectLink(ctx.cwd);
    ctx.output.success({ id: p.id, name: p.name, deleted: true }, () => `Deleted ${p.name}.`);
};

/**
 * Hesapsız projeyi takıma alır (README §1 "Hesapsız yayın ve sahiplenme"). Proje anahtarı bu klasörden ya da
 * PERAFLY_CLAIM_TOKEN'dan; kişinin girişi yoksa etkileşimli kipte önce giriş yapılır.
 */
export const projectsClaim = async (ctx: Context, opts: { keepPublishing?: boolean; access?: string }) => {
    const pk = await ctx.projectKey();
    if (!pk) throw new CliError("no_project_selected", "No project published without an account in this folder (and PERAFLY_CLAIM_TOKEN is not set).", { exitCode: 2 });
    let key = await ctx.apiKey();
    if (key?.source === "folder") key = null;
    if (!key) {
        if (!ctx.output.interactive) throw ctx.authRequired();
        ctx.output.info("Sign in to claim this project.");
        await login(ctx, { access: opts.access });
        key = await (await import("../auth/token.js")).resolveApiKey({ profile: ctx.settings.profile, apiUrl: ctx.apiUrl, env: ctx.env });
        if (!key) throw ctx.authRequired();
    }
    const projectId = pk.project?.projectId ?? (await ctx.client(pk.token).get<any>("/v1/me", { operationId: "getMe" })).data.project?.id;
    if (!projectId) throw new CliError("not_found", "The project key no longer works. The project may have been claimed or deleted.", { exitCode: 20 });
    const res = (await ctx.client(key.token).post<any>(`/v1/projects/${enc(projectId)}/claim`, { operationId: "claimProject", body: { projectKey: pk.token, keepPublishing: !!opts.keepPublishing } })).data;
    const p = res.project;
    // Proje anahtarı artık geçersiz: klasörden silinir; ajan anahtarı verildiyse aynı dosyada (0600) saklanır
    await saveClaimResult(ctx.cwd, { projectId: p.id, apiUrl: ctx.apiUrl, agentKey: res.agentKey ?? null });
    await writeProjectLink(ctx.cwd, { projectId: p.id, projectName: p.name, teamId: p.teamId ?? null, apiUrl: ctx.apiUrl });
    ctx.output.success({ project: p, keepPublishing: !!res.agentKey }, () =>
        [`Claimed ${p.name} into your team. ${p.urls?.live ?? ""} keeps its address and no longer expires.`, res.agentKey ? "The publishing agent can keep publishing from this folder (its key is limited to this project)." : ""].filter(Boolean).join("\n")
    );
};
