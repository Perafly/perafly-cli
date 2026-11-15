/**
 * Git ve CI (backend docs/API.md §21). Proje `--project` ya da bağlı klasörden; yalnız takım projesinde.
 *
 *   perafly git [status]                      GitHub bağlantısı, üretim dalı, otomatik yayın, itme adresi, son 5 derleme
 *   perafly git remote [--name perafly]       bu depoya itme adresini uzak olarak ekler, kimlik yardımcısını yalnız o adres
 *                                             için kurar; `origin`'e dokunmaz; anahtar adrese ve git yapılandırmasına yazılmaz
 *   perafly git credential <get|store|erase>  Git'in kimlik yardımcısı (src/git/credential.ts; Git çalıştırır)
 *   perafly git set [--production-branch] [--auto-production on|off] [--auto-previews on|off] [--repository sahip/ad
 *                   [--installation <kimlik>]]
 *   perafly git disconnect                    GitHub bağlantısını keser (onay ister)
 *   perafly git builds [--status]             son 50 derleme
 *   perafly git approve <gbd_…>               çataldan gelen çekme isteğinin derlemesini onaylar: çatalın kodu projenin
 *                                             ortam değişkenleriyle çalışır. Her kipte onay ister; ajan kipinde yalnız açık
 *                                             `--yes` (PERAFLY_YES sayılmaz)
 *   perafly branches                          dal adresleri ve sundukları sürüm
 *
 * Depoyu bağlamak (GitHub Uygulaması kurulumu panelden) ve çatal derlemesini onaylamak kişinin işidir: yerel MCP'de
 * araç değildir (src/mcp/tools.ts).
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { DEFAULT_API_URL } from "../config/index.js";
import { requireConfirmation, table } from "../output/index.js";
import { isValidBranch } from "../git/rules.js";
import { isPeraflyTarget } from "../git/credential.js";
import { configureRemote, gitRoot, helperCommand, urlOrigin } from "../git/repo.js";
import { enc, safeText, teamProject, when } from "./shared.js";

const WHAT = "Git settings";
const BUILD_STATUSES = ["queued", "running", "succeeded", "failed", "superseded", "awaiting_approval", "canceled"] as const;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const base = (ref: string) => `/v1/projects/${enc(ref)}`;

/* ─── Metin ─── */

const STATUS: Record<string, string> = {
    queued: "queued", running: "running", succeeded: "succeeded", failed: "failed", superseded: "superseded", awaiting_approval: "needs approval", canceled: "canceled"
};

const shortSha = (sha: unknown) => (typeof sha === "string" && sha ? sha.slice(0, 7) : "—");
const versionLabel = (v: any) => (v?.number ? `v${v.number}` : v?.id ?? "—");

const buildsTable = (rows: any[]) =>
    table(
        rows.map((b) => [
            safeText(b.id, 40), STATUS[b.status] ?? safeText(b.status, 20), safeText(b.branch, 40), shortSha(b.commit?.sha), safeText(b.commit?.message, 40),
            versionLabel(b.version), b.branchUrl ? safeText(b.branchUrl, 120) : "—"
        ]),
        ["BUILD", "STATUS", "BRANCH", "COMMIT", "MESSAGE", "VERSION", "BRANCH URL"]
    );

const approveHint = (rows: any[]) => {
    const waiting = rows.find((b) => b.status === "awaiting_approval");
    return waiting ? `\n\nA pull request from a fork is waiting. Read it first, then: perafly git approve ${waiting.id}` : "";
};

const settingsText = (g: any) => {
    const gh = g?.github;
    const repo = gh?.repository?.fullName
        ? `${safeText(gh.repository.fullName, 100)}${gh.installation?.account ? ` (installation ${safeText(gh.installation.account, 60)})` : ""}${gh.repository.url ? `  ${safeText(gh.repository.url, 120)}` : ""}`
        : "Not connected. Install the Perafly GitHub app from the panel, then: perafly git set --repository owner/name";
    const prod = g?.productionBranch ?? "main";
    return table([
        ["GitHub", repo],
        ["Production", `${safeText(prod, 80)} → ${g?.autoDeployProduction === false ? "preview (automatic live deploys off)" : "live"}`],
        ["Other branches", g?.autoDeployPreviews === false ? "not built (automatic previews off)" : "branch previews (<name>--br-<branch>)"],
        ["Push URL", g?.push?.url ? `${safeText(g.push.url, 200)}  (set up: perafly git remote)` : "—"]
    ]);
};

/* ─── Komutlar ─── */

export const status = async (ctx: Context) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    const [g, b] = await Promise.all([
        client.get<any>(`${base(ref)}/git`, { operationId: "getProjectGit" }),
        client.get<any>(`${base(ref)}/git/builds`, { operationId: "listGitBuilds" })
    ]);
    const builds: any[] = (b.data?.data ?? []).slice(0, 5);
    ctx.output.success({ git: g.data, builds }, () =>
        `${settingsText(g.data)}\n\n${builds.length ? `Recent builds\n${buildsTable(builds)}${approveHint(builds)}` : "No builds yet. Push a branch: perafly git remote, then git push perafly HEAD:" + (g.data?.productionBranch ?? "main")}`);
};

const onOff = (v: string | undefined, flag: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (v === "on") return true;
    if (v === "off") return false;
    throw new CliError("validation_error", `${flag} is on or off.`, { exitCode: 2 });
};

export const set = async (ctx: Context, opts: { productionBranch?: string; autoProduction?: string; autoPreviews?: string; repository?: string; installation?: string }) => {
    const body: Record<string, unknown> = {};
    if (opts.productionBranch !== undefined) {
        if (!isValidBranch(opts.productionBranch)) throw new CliError("validation_error", `"${opts.productionBranch}" is not a valid Git branch name.`, { exitCode: 2 });
        body.productionBranch = opts.productionBranch;
    }
    const autoProduction = onOff(opts.autoProduction, "--auto-production");
    if (autoProduction !== undefined) body.autoDeployProduction = autoProduction;
    const autoPreviews = onOff(opts.autoPreviews, "--auto-previews");
    if (autoPreviews !== undefined) body.autoDeployPreviews = autoPreviews;
    if (opts.repository !== undefined) {
        if (!REPO_RE.test(opts.repository)) throw new CliError("validation_error", "--repository is owner/name, e.g. acme/site.", { exitCode: 2 });
        body.repository = opts.repository;
    }
    if (opts.installation !== undefined) {
        // GitHub kurulum kimliği pozitif tamsayıdır; depo birden çok kurulumda görünüyorsa hangisinin kullanılacağını seçer
        if (!/^[1-9][0-9]{0,15}$/.test(opts.installation) || !Number.isSafeInteger(Number(opts.installation))) {
            throw new CliError("validation_error", "--installation is a GitHub installation id (a positive whole number).", { exitCode: 2 });
        }
        if (opts.repository === undefined) throw new CliError("validation_error", "--installation only applies with --repository.", { exitCode: 2 });
        body.installation = Number(opts.installation);
    }
    if (!Object.keys(body).length) throw new CliError("validation_error", "Pass at least one of --production-branch, --auto-production, --auto-previews or --repository.", { exitCode: 2 });
    const { ref, client } = await teamProject(ctx, WHAT);
    const g = (await client.put<any>(`${base(ref)}/git`, { operationId: "setProjectGit", body })).data;
    ctx.output.success(g, () => `Saved Git settings.\n\n${settingsText(g)}`);
};

export const disconnect = async (ctx: Context, opts: { yes?: boolean }) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Disconnect the GitHub repository from ${ref}? New GitHub pushes stop building; versions and branch previews stay`, `perafly git disconnect --project ${ref} --yes`);
    await client.delete(`${base(ref)}/git`, { operationId: "disconnectProjectGit" });
    ctx.output.success({ project: ref, disconnected: true }, () => "Disconnected GitHub. Versions and branch previews stay; direct pushes (perafly git remote) still work.");
};

export const builds = async (ctx: Context, opts: { status?: string }) => {
    if (opts.status !== undefined && !(BUILD_STATUSES as readonly string[]).includes(opts.status)) {
        throw new CliError("validation_error", `--status is one of ${BUILD_STATUSES.join(", ")}.`, { exitCode: 2 });
    }
    const { ref, client } = await teamProject(ctx, WHAT);
    const rows: any[] = (await client.get<any>(`${base(ref)}/git/builds`, { operationId: "listGitBuilds", query: { status: opts.status } })).data?.data ?? [];
    ctx.output.success(rows, () => (rows.length ? `${buildsTable(rows)}${approveHint(rows)}` : "No builds."), { pagination: { nextCursor: null } });
};

export const approve = async (ctx: Context, build: string, opts: { yes?: boolean }) => {
    if (!/^gbd_[A-Za-z0-9]{1,64}$/.test(build)) throw new CliError("validation_error", "Pass a build id (gbd_…): perafly git builds --status awaiting_approval", { exitCode: 2 });
    const { ref, client } = await teamProject(ctx, WHAT);
    ctx.output.warn(`The build runs code from someone else's fork with ${ref}'s environment variables, including secret keys. Approve only after reading the pull request.`);
    // Ajan kipinde yalnız açık `--yes` (PERAFLY_YES sayılmaz): çatal kodunu sırlarla çalıştırmak kişinin kararıdır
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.output.agent ? {} : ctx.env }, `Approve ${build} and build it with the project's environment variables?`, `perafly git approve ${build} --project ${ref} --yes`);
    const b = (await client.post<any>(`${base(ref)}/git/builds/${enc(build)}/approve`, { operationId: "approveGitBuild" })).data;
    ctx.output.success(b, () => `Approved ${b?.id ?? build}: ${safeText(b?.branch, 80)} builds a preview now.\nFollow it: perafly git builds`);
};

export const branches = async (ctx: Context) => {
    const { ref, client } = await teamProject(ctx, "Branch previews");
    const rows: any[] = (await client.get<any>(`${base(ref)}/branches`, { operationId: "listProjectBranches" })).data?.data ?? [];
    ctx.output.success(rows, () => (rows.length
        ? table(rows.map((r) => [safeText(r.branch, 60), safeText(r.url, 120), versionLabel(r.version), r.pullRequest ? `#${r.pullRequest}` : "—", when(r.updatedAt)]), ["BRANCH", "URL", "VERSION", "PR", "UPDATED"])
        : "No branch previews yet. Push a branch other than the production branch: git push perafly HEAD:feature-x"), { pagination: { nextCursor: null } });
};

/** İtme adresi: https (yerelde http yalnız döngü adresi), kimlik ve sorgu taşımaz */
const checkPushUrl = (raw: unknown): string => {
    let u: URL;
    try {
        u = new URL(String(raw ?? ""));
    } catch {
        throw new CliError("invalid_response", "The API did not return a push URL.", { exitCode: 1 });
    }
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname.endsWith(".localhost");
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new CliError("invalid_response", "The API returned a push URL that is not https.", { exitCode: 1 });
    if (u.username || u.password || u.search || u.hash) throw new CliError("invalid_response", "The API returned a push URL with credentials or a query.", { exitCode: 1 });
    return u.href;
};

export const remote = async (ctx: Context, opts: { name?: string }) => {
    const name = opts.name ?? "perafly";
    if (name === "origin") throw new CliError("validation_error", "perafly git remote never changes origin. Use another --name (default: perafly).", { exitCode: 2 });
    if (!REMOTE_RE.test(name)) throw new CliError("validation_error", `"${name}" is not a valid remote name.`, { exitCode: 2 });
    // Depo denetimi ağdan önce
    await gitRoot(ctx.cwd);
    const { ref, client } = await teamProject(ctx, WHAT);
    const g = (await client.get<any>(`${base(ref)}/git`, { operationId: "getProjectGit" })).data;
    const url = checkPushUrl(g?.push?.url);
    // Yardımcı, uzak adresi kuranla aynı API'yi ve (açıkça seçildiyse) profili kullanır
    const explicitProfile = ctx.flags.profile || ctx.env.PERAFLY_PROFILE || null;
    const helper = helperCommand({ apiUrl: ctx.apiUrl === DEFAULT_API_URL ? null : ctx.apiUrl, profile: explicitProfile });
    const r = await configureRemote(ctx.cwd, name, url, helper);
    const pushHost = new URL(url);
    if (!isPeraflyTarget({ protocol: pushHost.protocol.replace(/:$/, ""), host: pushHost.host }, ctx.apiUrl)) {
        ctx.output.warn(`The push host ${pushHost.host} is not ${new URL(ctx.apiUrl).host} or its git. host, so perafly won't give Git a key for it. Use a Git credential you manage for that host.`);
    }
    const branch = typeof g?.productionBranch === "string" && g.productionBranch ? g.productionBranch : "main";
    ctx.output.success({ remote: r.remote, url: r.url }, () => [
        `${r.action === "added" ? "Added" : r.action === "updated" ? "Updated" : "Kept"} remote ${r.remote} → ${r.url}`,
        `Git asks perafly for your key when you push (credential helper for ${urlOrigin(url)} only). The key is not stored in the URL or in Git's config.`,
        "",
        `Publish:  git push ${r.remote} HEAD:${branch}`,
        `Preview:  git push ${r.remote} HEAD:<another-branch>`
    ].join("\n"));
};
