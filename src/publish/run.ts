/**
 * `publish` düzenleyicisi (README §2.1; backend docs/API.md §15.4, §15.6).
 *
 *   kimlik ve hedef → perafly.jsonc doğrulaması → topla (collect) → hesapsız ön denetim → özetle (hash) → bildir
 *   (POST /v1/publish) → [hesapsız: anahtarı .perafly/state.json'a yaz] → eksikleri yükle (PUT) → tamamla
 *   (POST /v1/versions/{id}/finalize) → 202 ise işlemi bekle → sonuç
 *
 * Hesapsız projenin anahtarı yüklemeden ÖNCE saklanır: yükleme yarıda kalsa da proje kaybolmaz. Saklanamazsa hiçbir şey
 * yüklenmez. CLI derleme çalıştırmaz.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "../errors.js";
import { newIdempotencyKey, type ApiClient } from "../api/client.js";
import { readPeraflyConfig } from "../config/jsonc.js";
import { writeProjectLink } from "../config/index.js";
import type { Context } from "../context.js";
import { collect, type CollectResult } from "./collect.js";
import { hashFiles } from "./hash.js";
import { saveAnonymousProject } from "./state.js";
import { approvalRequired, resume, waitForApproval } from "../approval.js";
import type { PublishGit } from "../git/ci.js";

/** Hesapsız yayının sınırları ve dosya kuralları (backend publish/service.ts ile aynı; sunucu ayrıca denetler) */
export const ANONYMOUS_LIMITS = { maxFiles: 1000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 };
const ANONYMOUS_TYPES = /\.(html?|css|m?js|json|txt|md|xml|csv|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|ogg|wav|m4a|mp4|webm|mov|pdf|webmanifest|map|wasm)$/i;
const ANONYMOUS_RESERVED = /^(api\/|\.vercel\/|\.well-known\/|vercel\.json$|now\.json$|package\.json$|middleware\.[a-z]+$|_middleware\.[a-z]+$|_redirects$|_headers$)/i;

export const anonymousBlockReason = (path: string): string | null => {
    if (ANONYMOUS_RESERVED.test(path)) return "code or hosting configuration is not allowed without an account";
    if (!ANONYMOUS_TYPES.test(path)) return "file type not allowed without an account";
    return null;
};

export interface PublishOptions {
    dir: string;
    name?: string;
    message?: string;
    /** Verilmezse `live`; `git` varken verilmezse gönderilmez (dal kuralını sunucu uygular, backend docs/API.md §21.6) */
    target?: "live" | "preview";
    /** CI ya da `--branch`/`--commit`: yalnız takım yayınında gönderilir */
    git?: PublishGit | null;
    /** `git` bayraktan geldiyse hesapsız yayında sessizce düşmez, hata verir */
    gitFromFlags?: boolean;
    mode?: "snapshot" | "additive";
    /** Yeni takım projesinin ilk erişimi (backend docs/API.md §15.4); var olan projede ve hesapsız yayında istemcide reddedilir */
    access?: "private" | "public";
    prebuilt?: boolean;
    dryRun?: boolean;
    wait: boolean;
    waitTimeoutSeconds: number;
    /** false: onay bekleyen yayında beklemeden `approval_required` atılır (MCP aracı; ajan resume_execution çağırır) */
    approvalWait?: boolean;
    onProgress?: (line: string) => void;
}

export interface PublishResult {
    noop: boolean;
    dryRun: boolean;
    kind: "team" | "projectKey" | "anonymous";
    project: any | null;
    version: any | null;
    live: boolean;
    operation: any | null;
    files: { total: number; uploaded: number; reused: number; ignored: number; bytes: number };
    skipped: { path: string; reason: string }[];
    durationMs: number;
    /** Yalnız yeni hesapsız projede; insan çıktısı bağlantıyı gösterir, `--json` göstermez */
    claim: { claimUrl: string; expiresAt: string | null; claimDeadline: string | null } | null;
    /** Hesapsız projeye sonraki yayınlarda bitiş */
    anonymous: { expiresAt: string | null; claimDeadline: string | null } | null;
    /** Yalnız `--dry-run`: yayınlanacak dosyalar */
    plannedFiles?: { path: string; size: number }[];
    /** Gönderilen Git bilgisi (takım yayınında, dal biliniyorsa) */
    git?: PublishGit | null;
    /** Sürümün yayınlandığı dal adresi (`<ad>--br-<dal>`), sunucunun `version.git.branchUrl`'i; canlı ve üretim dalında null */
    branchUrl?: string | null;
}

const pool = async <T>(items: readonly T[], n: number, worker: (item: T) => Promise<void>) => {
    let next = 0;
    const run = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            await worker(items[i]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
};

const lastCommitMessage = async (cwd: string): Promise<string | undefined> => {
    try {
        const { execFile } = await import("node:child_process");
        const out = await new Promise<string>((resolve, reject) =>
            execFile("git", ["log", "-1", "--pretty=%s"], { cwd, timeout: 3000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
        );
        const msg = out.trim().slice(0, 500);
        return msg || undefined;
    } catch {
        return undefined;
    }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


export const runPublish = async (ctx: Context, opts: PublishOptions): Promise<PublishResult> => {
    const started = Date.now();
    const progress = opts.onProgress ?? (() => undefined);
    // Yol `--cwd`'ye göre çözülür (sürecin klasörüne göre değil)
    opts = { ...opts, dir: resolve(ctx.cwd, opts.dir) };
    const target = await ctx.projectTarget();
    const apiKey = await ctx.apiKey();

    let kind: PublishResult["kind"];
    let client: ApiClient;
    if (target?.anonymous) {
        kind = "projectKey";
        client = ctx.client(target.projectKey.token);
        if (apiKey) ctx.output.info("This folder publishes to a project without an account. Run perafly projects claim to move it to your team.");
    } else if (apiKey) {
        kind = "team";
        client = ctx.client(apiKey.token);
    } else if (target) {
        throw ctx.authRequired();
    } else {
        kind = "anonymous";
        client = ctx.client(null);
    }

    if (kind !== "team") {
        if (opts.target === "preview") throw new CliError("validation_error", "Preview versions need an account. Run perafly login.", { exitCode: 2, recovery: "perafly login" });
        if (opts.git && opts.gitFromFlags) throw new CliError("validation_error", "Branch publishing (--branch, --commit) needs an account. Run perafly login.", { exitCode: 2, recovery: "perafly login" });
        if (opts.name) throw new CliError("validation_error", "Projects published without an account get a generated name. Run perafly login to choose one.", { exitCode: 2, recovery: "perafly login" });
    }
    if (opts.name && target) throw new CliError("validation_error", "--name only applies when a new project is created. Rename with perafly projects update --name.", { exitCode: 2 });
    if (opts.access) {
        if (target) throw new CliError("validation_error", "--access applies only when publishing creates a new project. Change the access of an existing project with perafly share public|private, or in Perafly.", { exitCode: 2, recovery: "perafly share" });
        if (kind !== "team") throw new CliError("validation_error", "--access needs a sign-in: projects published without an account are public until claimed. Run perafly login.", { exitCode: 2, recovery: "perafly login" });
    }

    // perafly.jsonc: çalışma klasöründe ve yayınlanan klasörde (varsa) yüklemeden önce doğrulanır
    await readPeraflyConfig(ctx.cwd);
    const dirStat = await stat(opts.dir).catch(() => null);
    if (dirStat?.isDirectory()) await readPeraflyConfig(opts.dir);

    progress("Collecting files…");
    const collected: CollectResult = await collect(opts.dir, { respectGitignore: !opts.prebuilt, maxArchiveBytes: kind === "team" ? undefined : ANONYMOUS_LIMITS.maxTotalBytes });
    try {
        if (!collected.files.length) throw new CliError("validation_error", "No files to publish.", { exitCode: 2 });
        if (kind !== "team") {
            const blocked = collected.files.map((f) => ({ path: f.path, reason: anonymousBlockReason(f.path) })).filter((f) => f.reason);
            if (blocked.length) {
                const first = blocked[0]!;
                throw new CliError("path_blocked", `${first.path} can't be published without an account (${first.reason}).${blocked.length > 1 ? ` ${blocked.length - 1} more file(s) too.` : ""} Run perafly login to publish it.`, { exitCode: 2, recovery: "perafly login", details: { path: first.path, reason: first.reason } });
            }
            if (collected.files.length > ANONYMOUS_LIMITS.maxFiles) throw new CliError("too_many_files", `More than ${ANONYMOUS_LIMITS.maxFiles} files. Sign in to publish more.`, { exitCode: 2, recovery: "perafly login" });
            const big = collected.files.find((f) => f.size > ANONYMOUS_LIMITS.maxFileBytes);
            if (big) throw new CliError("file_too_large", `${big.path} is larger than 50 MB. Sign in to publish it.`, { exitCode: 2, recovery: "perafly login" });
            if (collected.totalBytes > ANONYMOUS_LIMITS.maxTotalBytes) throw new CliError("version_too_large", "The folder is larger than 100 MB. Sign in to publish it.", { exitCode: 2, recovery: "perafly login" });
        }

        const base = {
            kind,
            files: { total: collected.files.length, uploaded: 0, reused: 0, ignored: collected.skipped.length, bytes: collected.totalBytes },
            skipped: collected.skipped
        };
        if (opts.dryRun) {
            return {
                ...base, noop: false, dryRun: true, project: target ? { id: target.ref } : null, version: null, live: false, operation: null,
                durationMs: Date.now() - started, claim: null, anonymous: null, plannedFiles: collected.files.map((f) => ({ path: f.path, size: f.size }))
            };
        }

        progress(`Hashing ${collected.files.length} files…`);
        const hashed = await hashFiles(collected.files);
        const note = opts.message ?? (await lastCommitMessage(ctx.cwd));
        // Git bilgisi yalnız takım yayınında (sahipsiz projede sunucu yok sayar); varken hedef açıkça verilmediyse
        // gönderilmez: dal kuralı karar verir (backend docs/API.md §21.6)
        const git = kind === "team" && opts.git ? opts.git : null;
        const body: Record<string, unknown> = {
            files: hashed.map(({ path, sha256, size }) => ({ path, sha256, size })),
            source: "cli",
            ...(opts.target ? { target: opts.target } : git ? {} : { target: "live" }),
            ...(git ? { git } : {}),
            mode: opts.mode ?? "snapshot",
            ...(opts.access && !target ? { access: opts.access } : {}),
            ...(note ? { note } : {}),
            ...(target ? { project: target.ref } : {}),
            ...(!target && opts.name ? { name: opts.name } : {})
        };
        progress("Declaring files…");
        const declared = await client.post<any>("/v1/publish", { operationId: "publish", body, idempotencyKey: newIdempotencyKey() });
        const d = declared.data;
        let finalClient = client;
        let claim: PublishResult["claim"] = null;
        if (d.projectKey) {
            // Anahtar yüklemeden önce saklanır; yazılamazsa yükleme yapılmaz
            try {
                await saveAnonymousProject(ctx.cwd, {
                    projectId: d.project.id, projectName: d.project.name ?? null, projectKey: d.projectKey, apiUrl: ctx.apiUrl,
                    liveUrl: d.project.urls?.live ?? null, expiresAt: d.expiresAt ?? null, claimDeadline: d.claimDeadline ?? null
                });
            } catch (error) {
                throw new CliError("state_write_failed", `Could not save the project key to .perafly/state.json (${(error as Error).message}). Nothing was uploaded.`, { exitCode: 1 });
            }
            finalClient = ctx.client(d.projectKey);
            claim = { claimUrl: d.claimUrl, expiresAt: d.expiresAt ?? null, claimDeadline: d.claimDeadline ?? null };
        }
        if (d.noop) {
            return { ...base, noop: true, dryRun: false, project: d.project, version: d.version, live: !!d.version?.live, operation: null, durationMs: Date.now() - started, claim, anonymous: d.project?.anonymous ?? null, files: { ...base.files, reused: hashed.length } };
        }

        const uploads: any[] = Array.isArray(d.uploads) ? d.uploads : [];
        const bySha = new Map(hashed.map((f) => [f.sha256, f]));
        let done = 0;
        if (uploads.length) progress(`Uploading ${uploads.length} file(s)…`);
        await pool(uploads, 6, async (u) => {
            const f = bySha.get(u.sha256);
            if (!f) throw new CliError("invalid_response", "The API asked for a file that was not declared", { exitCode: 1 });
            const bytes = await readFile(f.absPath);
            if (createHash("sha256").update(bytes).digest("hex") !== f.sha256) {
                throw new CliError("validation_error", `${f.path} changed while publishing. Wait for the build to finish, then publish again.`, { exitCode: 2 });
            }
            await client.upload(u.url, bytes);
            done++;
            if (uploads.length > 20 && done % 20 === 0) progress(`Uploaded ${done}/${uploads.length}`);
        });

        progress(opts.wait ? "Going live…" : "Finalizing…");
        const fin = await finalClient.post<any>(`/v1/versions/${encodeURIComponent(d.version.id)}/finalize`, {
            operationId: "finalizeVersion",
            query: opts.wait ? { wait: 30 } : { async: 1 },
            idempotencyKey: newIdempotencyKey()
        });
        const uploadedShas = new Set(uploads.map((u) => u.sha256));
        const reused = hashed.filter((f) => !uploadedShas.has(f.sha256)).length;
        let project = fin.data.project ?? d.project;
        let version = fin.data.version;
        let operation = fin.data.operation ?? null;
        if (fin.status === 202 && opts.wait && operation?.id) {
            const deadline = started + opts.waitTimeoutSeconds * 1000;
            for (;;) {
                if (Date.now() > deadline) {
                    throw new CliError("wait_timeout", `Still deploying after ${opts.waitTimeoutSeconds}s. It continues on the server.`, { exitCode: 50, recovery: `perafly operations wait ${operation.id}` });
                }
                await (ctx.deps.sleep ?? sleep)(2000);
                const op = await finalClient.get<any>(`/v1/operations/${encodeURIComponent(operation.id)}`, { operationId: "getOperation" });
                operation = op.data;
                if (operation.status !== "running") break;
            }
            const v = await finalClient.get<any>(`/v1/projects/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(version.id)}`, { operationId: "getProjectVersion" });
            version = v.data;
            const p = await finalClient.get<any>(`/v1/projects/${encodeURIComponent(project.id)}`, { operationId: "getProject" });
            project = p.data;
        }
        // Ajan profiliyle canlının üzerine yayın: sürüm hazır, canlı onay bekler (docs/API.md §15.9)
        if (version?.approval?.executionId && version.approval.status === "pending") {
            const brief = { id: version.approval.executionId, status: "pending", approvalUrl: version.approval.approvalUrl, expiresAt: version.approval.expiresAt };
            if (!opts.wait || opts.approvalWait === false) throw approvalRequired(brief);
            await waitForApproval(finalClient, brief, { output: ctx.output, timeoutSeconds: Math.max(1, opts.waitTimeoutSeconds - Math.floor((Date.now() - started) / 1000)), sleep: ctx.deps.sleep });
            const done = await resume(finalClient, brief.id);
            project = done.project ?? project;
            version = done.version ?? version;
        }
        if (version?.state === "failed") {
            const label = version.number ? `v${version.number}` : version.id;
            throw new CliError(version.error?.code || "build_failed", `${label} failed: ${version.error?.message || "the build failed"}`, { exitCode: 1, recovery: `perafly logs build --version ${version.id}` });
        }
        if (kind === "team" && !target && !ctx.settings.link) {
            await writeProjectLink(ctx.cwd, { projectId: project.id, projectName: project.name, teamId: project.teamId ?? null, apiUrl: ctx.apiUrl });
        }
        // Dal adresi yalnız sunucudan (backend docs/API.md §21.3): null ise yazılmaz, tahmin edilmez
        const branchUrl = typeof version?.git?.branchUrl === "string" && version.git.branchUrl ? version.git.branchUrl : null;
        return {
            ...base,
            noop: false,
            dryRun: false,
            project,
            version,
            live: !!version?.live,
            operation: fin.status === 202 ? operation : null,
            files: { ...base.files, uploaded: hashed.length - reused, reused },
            durationMs: Date.now() - started,
            claim,
            anonymous: project?.anonymous ?? null,
            git,
            branchUrl
        };
    } finally {
        await collected.cleanup();
    }
};
