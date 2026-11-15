/**
 * `perafly publish [DIR]` (README §1, §2.1). Akış src/publish/run.ts'tedir; burada bayraklar ve çıktı.
 * İnsan çıktısı hesapsız projede sahiplenme bağlantısını bilerek gösterir; `--json` göstermez (anahtar URL parçasında).
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { runPublish, type PublishResult } from "../publish/run.js";
import { formatBytes, table } from "../output/index.js";
import { authorName, firstLine, resolvePublishGit, type PublishGit } from "../git/ci.js";
import { commitInfo } from "../git/repo.js";

export interface PublishFlags {
    name?: string;
    message?: string;
    target?: string;
    publishMode?: string;
    prebuilt?: boolean;
    dryRun?: boolean;
    wait?: boolean;
    waitTimeout?: string;
    branch?: string;
    commit?: string;
    access?: string;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const CI_NAMES: Record<string, string> = { github: "GitHub Actions", gitlab: "GitLab CI", bitbucket: "Bitbucket Pipelines", circleci: "CircleCI" };

/**
 * Yayının Git bilgisi (backend docs/API.md §21.6): `--branch`/`--commit` ya da CI ortamı; dal bilinmiyorsa null. İleti
 * ve yazar ortamda yoksa işleme yerel depoda aranır (CI'ın çektiği depo).
 */
const publishGit = async (ctx: Context, flags: PublishFlags) => {
    const resolved = resolvePublishGit({ env: ctx.env, branch: flags.branch, commit: flags.commit });
    if (!resolved) {
        if (flags.commit !== undefined) ctx.output.info(ctx.output.paint("dim", "--commit is ignored without a branch: pass --branch too."));
        return null;
    }
    const git: PublishGit = { ...resolved.git };
    if (git.commit && (!git.message || !git.author)) {
        const info = await commitInfo(ctx.cwd, git.commit);
        const message = git.message ?? firstLine(info.message);
        const author = git.author ?? authorName(info.author);
        if (message) git.message = message;
        if (author) git.author = author;
    }
    return { git, fromFlags: resolved.source === "flag" || flags.commit !== undefined, source: resolved.source };
};

type PublishFlagsAccess = "private" | "public";

/**
 * 403 `access_change_forbidden` (backend docs/API.md §15.4, §20.5): takım yeni siteleri özel açıyor ve bu kimlik herkese
 * açamıyor (`--access public` ya da `perafly.jsonc` `access: "public"`). Kod ve durum korunur, ileti yol gösterir.
 */
const accessForbidden = (error: unknown): unknown => {
    if (!(error instanceof CliError) || error.code !== "access_change_forbidden") return error;
    return new CliError(error.code, "This team keeps new sites private, and making one public needs a person with sharing permission and a full sign-in. Publish it private (--access private, or remove \"access\" from perafly.jsonc), then change its access in Perafly.", {
        status: error.status, type: error.type, title: error.title, requestId: error.requestId, details: error.details, recovery: "perafly publish --access private"
    });
};

export const jsonResult = (r: PublishResult) => ({
    project: r.project ? { id: r.project.id, name: r.project.name ?? null, teamId: r.project.teamId ?? null, urls: r.project.urls ?? null } : null,
    version: r.version ? { id: r.version.id, number: r.version.number ?? null, state: r.version.state, target: r.version.target ?? null, url: r.version.url ?? null, live: !!r.version.live, ...(r.version.git ? { git: r.version.git } : {}) } : null,
    ...(r.branchUrl ? { branchUrl: r.branchUrl } : {}),
    live: r.live,
    noop: r.noop,
    dryRun: r.dryRun,
    operation: r.operation ? { id: r.operation.id, status: r.operation.status } : null,
    files: r.files,
    skipped: r.skipped,
    durationMs: r.durationMs,
    ...(r.plannedFiles ? { plannedFiles: r.plannedFiles } : {}),
    ...(r.claim || r.anonymous ? { claim: { expiresAt: r.claim?.expiresAt ?? r.anonymous?.expiresAt ?? null, claimDeadline: r.claim?.claimDeadline ?? r.anonymous?.claimDeadline ?? null, command: "perafly projects claim" } } : {})
});

export const publish = async (ctx: Context, dir: string | undefined, flags: PublishFlags) => {
    // Hedef verilmezse `live`; CI'da ya da `--branch` ile dal kuralı karar verir (gövdeye konmaz)
    const target = flags.target;
    if (target !== undefined && target !== "live" && target !== "preview") throw new CliError("validation_error", "--target must be live or preview", { exitCode: 2 });
    const mode = flags.publishMode ?? "snapshot";
    if (mode !== "snapshot" && mode !== "additive") throw new CliError("validation_error", "--publish-mode must be snapshot or additive", { exitCode: 2 });
    if (flags.access !== undefined && flags.access !== "private" && flags.access !== "public") throw new CliError("validation_error", "--access must be private or public", { exitCode: 2 });
    const waitTimeout = flags.waitTimeout === undefined ? 900 : Number(flags.waitTimeout);
    if (!Number.isInteger(waitTimeout) || waitTimeout < 1 || waitTimeout > 86_400) throw new CliError("validation_error", "--wait-timeout must be a number of seconds", { exitCode: 2 });
    const out = ctx.output;
    const git = await publishGit(ctx, flags);
    if (git) out.info(out.paint("dim", `Branch ${git.git.branch}${git.git.commit ? ` @ ${git.git.commit.slice(0, 7)}` : ""}${git.source !== "flag" ? ` (${CI_NAMES[git.source]})` : ""}${target ? "" : ": the project's branch rule picks live or preview"}`));
    let r: PublishResult;
    try {
        r = await runPublish(ctx, {
            dir: dir ?? ".",
            name: flags.name,
            message: flags.message,
            target,
            git: git?.git ?? null,
            gitFromFlags: git?.fromFlags ?? false,
            mode,
            access: flags.access as PublishFlagsAccess | undefined,
            prebuilt: flags.prebuilt,
            dryRun: flags.dryRun,
            wait: flags.wait !== false,
            waitTimeoutSeconds: waitTimeout,
            onProgress: (line) => out.info(out.paint("dim", line))
        });
    } catch (error) {
        throw accessForbidden(error);
    }
    const data = jsonResult(r);
    out.success(data, () => {
        if (r.dryRun) {
            const lines = [`Dry run: ${r.files.total} file(s), ${formatBytes(r.files.bytes)}${r.project ? ` → ${r.project.id}` : r.kind === "anonymous" ? " → new project without an account" : " → new project"}`];
            for (const f of r.plannedFiles ?? []) lines.push(`  ${f.path}  ${formatBytes(f.size)}`);
            if (r.skipped.length) {
                lines.push("", `Skipped (${r.skipped.length}):`);
                for (const s of r.skipped) lines.push(`  ${s.path}  ${s.reason}`);
            }
            return lines.join("\n");
        }
        if (r.noop) return `No changes: ${r.project?.urls?.live ?? r.project?.name} already serves these files.`;
        const live = r.project?.urls?.live ?? "";
        const head = r.version?.target === "preview" ? `Preview ready: ${r.version?.url ?? ""}` : r.live ? `Published: ${live}` : `Ready: ${r.version?.url ?? ""} (not live${r.project?.publishRule === "manual" ? ": the project publishes manually" : ""}; run perafly promote v${r.version?.number})`;
        const rows: string[][] = [
            ["Live URL", live || "—"],
            ["Version URL", r.version?.url ?? "—"],
            ...(r.branchUrl ? [["Branch URL", r.branchUrl]] : []),
            ...(r.version?.git?.branch ? [["Branch", `${r.version.git.branch}${r.version.git.commit?.sha ? ` @ ${String(r.version.git.commit.sha).slice(0, 7)}` : ""}`]] : []),
            ["Project", `${r.project?.name ?? "?"} (${r.project?.id ?? "?"})`],
            ["Version", `${r.version?.number ? `v${r.version.number}` : r.version?.id} (${r.version?.state}${r.operation?.status === "running" ? ", still deploying" : ""})`],
            ["Files", `${r.files.uploaded} uploaded, ${r.files.reused} reused (${r.files.ignored} ignored)`],
            ["Duration", seconds(r.durationMs)]
        ];
        const expires = r.claim?.expiresAt ?? r.anonymous?.expiresAt;
        if (expires) rows.push(["Expires", `${expires} (24 hours after the last publish)`]);
        const deadline = r.claim?.claimDeadline ?? r.anonymous?.claimDeadline;
        if (deadline) rows.push(["Claim before", deadline]);
        return `${head}\n\n${table(rows).replace(/^/gm, "  ")}`;
    });
    if (r.claim && !out.json) {
        // Bilerek karartılmadan: kullanıcının tarayıcıda açacağı tek yol bu bağlantıdır (anahtar URL parçasında)
        out.raw(`\n  Claim URL    ${r.claim.claimUrl}`);
        out.raw("\nAnyone with the claim URL can take this project. Keep it private.");
        out.raw("Published without an account. Run perafly projects claim to keep it.");
    }
    if (!r.claim && r.anonymous && !out.json) out.raw("\nPublished without an account. Run perafly projects claim to keep it.");
};
