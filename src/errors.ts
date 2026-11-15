/**
 * CLI hata türü (README §4.1–§4.2). Bütün katmanlar bunu atar; `src/output` stderr'e `{ "error": … }` olarak yazar ve
 * çıkış kodunu `exitCode`'dan (yoksa `status`'tan) seçer. İleti İngilizcedir ve sır taşımaz.
 *
 * Paylaşılan dosya: alan eklenebilir; var olan alanların anlamı ve kurucu imzası değişmez.
 */
export type ExitCode = 0 | 1 | 2 | 10 | 20 | 30 | 40 | 50 | 130;

export interface CliErrorInit {
    status?: number | null;
    type?: string | null;
    title?: string | null;
    retryable?: boolean;
    recovery?: string | null;
    requestId?: string | null;
    suggestions?: string[];
    pointer?: string | null;
    exitCode?: ExitCode;
    /** Sunucunun RFC 9457 yanıtındaki ek alanlar (path, reason, limit, interval …); sır içermez */
    details?: Record<string, unknown>;
}

export class CliError extends Error {
    readonly code: string;
    readonly status: number | null;
    readonly type: string | null;
    readonly title: string | null;
    readonly retryable: boolean;
    readonly recovery: string | null;
    readonly requestId: string | null;
    readonly suggestions: string[];
    readonly pointer: string | null;
    readonly exitCode: ExitCode | undefined;
    readonly details: Record<string, unknown>;

    constructor(code: string, message: string, init: CliErrorInit = {}) {
        super(message);
        this.name = "CliError";
        this.code = code;
        this.status = init.status ?? null;
        this.type = init.type ?? null;
        this.title = init.title ?? null;
        this.retryable = init.retryable ?? false;
        this.recovery = init.recovery ?? null;
        this.requestId = init.requestId ?? null;
        this.suggestions = init.suggestions ?? [];
        this.pointer = init.pointer ?? null;
        this.exitCode = init.exitCode;
        this.details = init.details ?? {};
    }
}

/** HTTP durumundan çıkış kodu (README §4.2) */
export const exitCodeForStatus = (status: number | null | undefined): ExitCode => {
    if (!status) return 1;
    if (status === 401 || status === 403) return 10;
    if (status === 404 || status === 410) return 20;
    if (status === 409 || status === 402) return 30;
    if (status === 429) return 40;
    if (status === 400 || status === 413 || status === 422) return 2;
    return 1;
};

const bytesText = (n: number) => (n >= 1024 ** 3 ? `${+(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${+(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} bytes`);

/**
 * Plan sınırı (402 `plan_limit_*`, `plan_feature_unavailable`): sunucu `detail` vermediyse iletiye sınırı ve planı
 * ekler (ör. "Storage limit reached: the plan allows 10 GB. The Team plan allows more.").
 */
const planMessage = (code: string, body: any, base: string): string => {
    if (typeof body?.detail === "string" || !/^plan_(limit_|feature_unavailable)/.test(code)) return base;
    const parts = [base.replace(/\.$/, "")];
    if (typeof body?.limit === "number") parts[0] += `: the plan allows ${code.startsWith("plan_limit_storage") ? bytesText(body.limit) : body.limit}`;
    parts[0] += ".";
    if (typeof body?.upgradeTo === "string" && body.upgradeTo) parts.push(code === "plan_feature_unavailable" ? `The ${body.upgradeTo} plan includes it.` : `The ${body.upgradeTo} plan allows more.`);
    parts.push("A team admin can change the plan in Perafly.");
    return parts.join(" ");
};

/** RFC 9457 gövdesinden CliError; bilinen ek alanlar `details`'e geçer */
export const problemToError = (status: number, body: any, fallbackMessage = "Request failed"): CliError => {
    const code = typeof body?.code === "string" ? body.code : `http_${status}`;
    const message = planMessage(code, body, typeof body?.detail === "string" ? body.detail : typeof body?.title === "string" ? body.title : fallbackMessage);
    const details: Record<string, unknown> = {};
    for (const k of ["path", "reason", "limit", "field", "missingCount", "state", "interval", "retryAfterSeconds", "execution", "status", "feature", "used", "upgradeTo"]) if (body?.[k] !== undefined) details[k] = body[k];
    return new CliError(code, message, {
        status,
        type: typeof body?.type === "string" ? body.type : null,
        title: typeof body?.title === "string" ? body.title : null,
        requestId: typeof body?.requestId === "string" ? body.requestId : null,
        retryable: status === 429 || status >= 500,
        details
    });
};
