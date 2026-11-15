/**
 * Çıktı ve çıkış kodları (README §4.1–§4.3).
 *
 *   --json      stdout'a yalnız `{ "data": … }` (liste `{ data, pagination }`), hata stderr'e `{ "error": … }`
 *   insan       stdout'a sonuç, stderr'e ilerleme ve ipucu
 *
 * Ajan kipi (`PERAFLY_AGENT` = 1|true|yes ya da `CI`) `--json`'u açar ve soruları kapatır; `--yes` anlamına gelmez.
 * `--json` çıktısı ve her hata nesnesi `redactDeep`'ten geçer: anahtar, imzalı adres ve cihaz kodu yazılmaz.
 */
import { createInterface } from "node:readline/promises";
import { redact, redactDeep } from "../auth/redact.js";
import { CliError, exitCodeForStatus, type ExitCode } from "../errors.js";

const truthy = (v: string | undefined) => !!v && ["1", "true", "yes"].includes(v.toLowerCase());

export interface OutputOptions {
    json?: boolean;
    env?: NodeJS.ProcessEnv;
    stdout?: NodeJS.WritableStream & { isTTY?: boolean };
    stderr?: NodeJS.WritableStream & { isTTY?: boolean };
    stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

export interface ErrorObject {
    code: string;
    message: string;
    status: number | null;
    type: string | null;
    title: string | null;
    retryable: boolean;
    recovery: string | null;
    requestId: string | null;
    suggestions: string[];
    pointer: string | null;
    details?: Record<string, unknown>;
}

export const isAgentMode = (env: NodeJS.ProcessEnv = process.env) => truthy(env.PERAFLY_AGENT) || !!env.CI;
export const yesFromEnv = (env: NodeJS.ProcessEnv = process.env) => truthy(env.PERAFLY_YES);

export const toErrorObject = (error: unknown): ErrorObject => {
    const e = error instanceof CliError ? error : new CliError("unknown", error instanceof Error ? error.message : String(error));
    const obj: ErrorObject = {
        code: e.code,
        message: e.message,
        status: e.status,
        type: e.type,
        title: e.title,
        retryable: e.retryable,
        recovery: e.recovery,
        requestId: e.requestId,
        suggestions: e.suggestions,
        pointer: e.pointer
    };
    if (Object.keys(e.details).length) obj.details = e.details;
    return redactDeep(obj);
};

export const exitCodeOf = (error: unknown): ExitCode => {
    if (error instanceof CliError) return error.exitCode ?? exitCodeForStatus(error.status);
    return 1;
};

export class Output {
    readonly json: boolean;
    readonly agent: boolean;
    readonly interactive: boolean;
    readonly color: boolean;
    private readonly out: NodeJS.WritableStream;
    private readonly err: NodeJS.WritableStream;
    private readonly input: NodeJS.ReadableStream & { isTTY?: boolean };

    constructor(opts: OutputOptions = {}) {
        const env = opts.env ?? process.env;
        const stdout = opts.stdout ?? process.stdout;
        const stderr = opts.stderr ?? process.stderr;
        const stdin = opts.stdin ?? process.stdin;
        this.agent = isAgentMode(env);
        this.json = !!opts.json || this.agent;
        this.interactive = !this.json && !env.PERAFLY_NON_INTERACTIVE && !!stdin.isTTY && !!stdout.isTTY;
        this.color = env.FORCE_COLOR ? env.FORCE_COLOR !== "0" : !env.NO_COLOR && !!stdout.isTTY;
        this.out = stdout;
        this.err = stderr;
        this.input = stdin;
    }

    /** Başarı: `--json`'da `{ data }` (ek alanlar, ör. pagination, köke), insan kipinde `human()` çıktısı */
    success(data: unknown, human?: () => string | void, extra: Record<string, unknown> = {}) {
        if (this.json) {
            this.out.write(`${JSON.stringify(redactDeep({ data, ...extra }))}\n`);
            return;
        }
        const text = human ? human() : undefined;
        if (typeof text === "string" && text) this.out.write(text.endsWith("\n") ? text : `${text}\n`);
    }

    /**
     * Akış satırı (`logs --follow`, `top --watch`): `--json`'da her kayıt ayrı bir JSON satırıdır (NDJSON, `{ data }`),
     * insan kipinde metin satırı. İkisi de stdout'a.
     */
    stream(data: unknown, human: () => string) {
        if (this.json) {
            this.out.write(`${JSON.stringify(redactDeep({ data }))}\n`);
            return;
        }
        const text = human();
        if (text) this.out.write(text.endsWith("\n") ? text : `${text}\n`);
    }

    /** Hata: `--json`'da stderr'e `{ error }`, değilse okunur ileti; çıkış kodunu döner */
    failure(error: unknown): ExitCode {
        const obj = toErrorObject(error);
        if (this.json) {
            this.err.write(`${JSON.stringify({ error: obj })}\n`);
        } else {
            const lines = [`${this.paint("red", "Error:")} ${obj.message}`];
            if (obj.details?.path) lines.push(`  Path: ${obj.details.path}`);
            if (obj.recovery) lines.push(`  Next: ${obj.recovery}`);
            if (obj.requestId) lines.push(`  Request ID: ${obj.requestId}`);
            this.err.write(`${redact(lines.join("\n"))}\n`);
        }
        return exitCodeOf(error);
    }

    /** İlerleme ve ipucu: yalnız insan kipinde, stderr'e */
    info(message: string) {
        if (!this.json) this.err.write(`${message}\n`);
    }

    /** Ajan ve `--json` kipinde de stderr'e giden uyarı (stdout temiz kalır) */
    warn(message: string) {
        this.err.write(`${this.json ? "" : `${this.paint("yellow", "Warning:")} `}${redact(message)}\n`);
    }

    /** Kullanıcının mutlaka görmesi gereken yönerge (ör. giriş kodu): her kipte stderr'e, önek yok */
    notice(message: string) {
        this.err.write(`${redact(message)}\n`);
    }

    /** Sahiplenme bağlantısı gibi bilerek gösterilen değer: karartılmaz, yalnız insan kipinde yazılır */
    raw(text: string) {
        if (!this.json) this.out.write(`${text}\n`);
    }

    paint(color: "red" | "green" | "yellow" | "dim" | "bold" | "cyan", text: string) {
        if (!this.color) return text;
        const codes = { red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39], dim: [2, 22], bold: [1, 22] }[color];
        return `\u001b[${codes[0]}m${text}\u001b[${codes[1]}m`;
    }

    /** Evet/hayır sorusu (varsayılan hayır). Etkileşimsiz kipte asla sorulmaz. */
    async confirm(question: string): Promise<boolean> {
        if (!this.interactive) return false;
        const rl = createInterface({ input: this.input, output: this.err });
        try {
            const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
            return answer === "y" || answer === "yes";
        } finally {
            rl.close();
        }
    }
}

/**
 * Yıkıcı uzak işlem kapısı (README §4.3): açık `--yes` (ya da `PERAFLY_YES`) yoksa etkileşimli terminalde sorulur;
 * ajan ve etkileşimsiz kipte `confirmation_required` (çıkış 2). Ajan kipi asla onay yerine geçmez.
 */
export const requireConfirmation = async (output: Output, opts: { yes?: boolean; env?: NodeJS.ProcessEnv }, question: string, recovery: string) => {
    if (opts.yes || yesFromEnv(opts.env)) return;
    if (output.interactive && (await output.confirm(question))) return;
    if (output.interactive) throw new CliError("cancelled", "Cancelled", { exitCode: 130 });
    throw new CliError("confirmation_required", `${question.replace(/\?$/, "")} needs confirmation. Run again with --yes.`, { exitCode: 2, recovery });
};

/** Tablo: sütunları en uzun değere göre hizalar (insan kipi) */
export const table = (rows: string[][], header?: string[]) => {
    const all = header ? [header, ...rows] : rows;
    if (!all.length) return "";
    const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
    return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
};

export const formatBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
