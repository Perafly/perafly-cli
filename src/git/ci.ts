/**
 * CI'dan yayının Git bilgisi (backend docs/API.md §21.6): `POST /v1/publish` gövdesindeki `git: { branch, commit,
 * message?, author? }`. Hedef verilmemişse dal kuralını sunucu uygular (üretim dalı canlıya, diğerleri önizlemeye).
 *
 *   detectCi(env)              GitHub Actions, GitLab CI, Bitbucket Pipelines, CircleCI; başka ortamda null
 *   resolvePublishGit(…)       `--branch` / `--commit` bayrakları CI'ın önüne geçer; dal bilinmiyorsa null (git gönderilmez)
 *
 * Etiket derlemesinde dal yoktur (etiket dal sayılmaz). Yazar e-postası gönderilmez (yalnız ad). CI'dan gelen geçersiz
 * dal ya da işleme sessizce düşer; bayrakla verilen geçersiz değer `validation_error`.
 */
import { CliError } from "../errors.js";
import { isCommitSha, isValidBranch } from "./rules.js";

export type CiProvider = "github" | "gitlab" | "bitbucket" | "circleci";

export interface CiGit {
    provider: CiProvider;
    branch: string | null;
    commit: string | null;
    message: string | null;
    author: string | null;
}

export interface PublishGit {
    branch: string;
    commit?: string;
    message?: string;
    author?: string;
}

const val = (v: string | undefined): string | null => {
    const s = v?.trim();
    return s ? s : null;
};

/** İletinin ilk satırı (sunucu da yalnız ilk satırı saklar) */
export const firstLine = (message: string | null | undefined, max = 200): string | null => {
    const s = (message ?? "").split(/\r?\n/)[0]!.trim().slice(0, max);
    return s || null;
};

/** `Ada Lovelace <ada@example.com>` → `Ada Lovelace`: e-posta gönderilmez */
export const authorName = (author: string | null | undefined, max = 100): string | null => {
    const s = (author ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);
    return s || null;
};

export const detectCi = (env: NodeJS.ProcessEnv): CiGit | null => {
    if (env.GITHUB_ACTIONS === "true") {
        // Çekme isteğinde GITHUB_HEAD_REF kaynak daldır; GITHUB_REF_NAME orada `<n>/merge`, etikette etiket adıdır
        const head = val(env.GITHUB_HEAD_REF);
        const ref = env.GITHUB_REF_TYPE === "tag" ? null : val(env.GITHUB_REF_NAME);
        return { provider: "github", branch: head ?? ref, commit: val(env.GITHUB_SHA), message: null, author: null };
    }
    if (env.GITLAB_CI === "true") {
        return {
            provider: "gitlab",
            branch: val(env.CI_COMMIT_TAG) ? null : val(env.CI_COMMIT_REF_NAME),
            commit: val(env.CI_COMMIT_SHA),
            message: firstLine(env.CI_COMMIT_MESSAGE),
            author: authorName(env.CI_COMMIT_AUTHOR)
        };
    }
    if (env.BITBUCKET_BUILD_NUMBER || env.BITBUCKET_COMMIT) {
        return { provider: "bitbucket", branch: val(env.BITBUCKET_BRANCH), commit: val(env.BITBUCKET_COMMIT), message: null, author: null };
    }
    if (env.CIRCLECI === "true") {
        return { provider: "circleci", branch: val(env.CIRCLE_BRANCH), commit: val(env.CIRCLE_SHA1), message: null, author: null };
    }
    return null;
};

export interface ResolvedPublishGit {
    git: PublishGit;
    /** `flag`: dal `--branch`'ten; değilse CI sağlayıcısı */
    source: "flag" | CiProvider;
}

/**
 * Yayının Git bilgisi. Dal: `--branch` → CI. İşleme: `--commit` → CI. İleti ve yazar yalnız CI'ın işlemesi
 * kullanılıyorsa CI'dan gelir (yerel depodan doldurma `commitInfo` ile komutta yapılır).
 */
export const resolvePublishGit = (opts: { env: NodeJS.ProcessEnv; branch?: string; commit?: string }): ResolvedPublishGit | null => {
    if (opts.branch !== undefined && !isValidBranch(opts.branch)) {
        throw new CliError("validation_error", `--branch "${opts.branch}" is not a valid Git branch name.`, { exitCode: 2 });
    }
    if (opts.commit !== undefined && !isCommitSha(opts.commit)) {
        throw new CliError("validation_error", "--commit must be a commit SHA (7 to 64 hex characters).", { exitCode: 2 });
    }
    const ci = detectCi(opts.env);
    const ciBranch = ci?.branch && isValidBranch(ci.branch) ? ci.branch : null;
    const ciCommit = ci?.commit && isCommitSha(ci.commit) ? ci.commit.toLowerCase() : null;
    const branch = opts.branch ?? ciBranch;
    if (!branch) return null;
    const commit = opts.commit?.toLowerCase() ?? ciCommit;
    const fromCi = !!commit && commit === ciCommit;
    const message = fromCi ? firstLine(ci?.message) : null;
    const author = fromCi ? authorName(ci?.author) : null;
    return {
        git: { branch, ...(commit ? { commit } : {}), ...(message ? { message } : {}), ...(author ? { author } : {}) },
        source: opts.branch !== undefined ? "flag" : ci!.provider
    };
};
