/**
 * `perafly.jsonc` okuma ve doğrulama (README §5). Satır ve blok yorumları ile sondaki virgüller kabul edilir. Doğrulama
 * `schemas/perafly.json` ile aynı kurallardır; hata `validation_error` ve RFC 6901 `pointer` taşır.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";

export const PERAFLY_JSONC = "perafly.jsonc";
export const SCHEMA_URL = "https://perafly.com/schemas/perafly.json";

/** Dizelerin dışındaki yorumları ve sondaki virgülleri atar (satır sayısı korunur) */
export const stripJsonc = (text: string): string => {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text[i]!;
        const next = text[i + 1];
        if (inString) {
            out += c;
            if (c === "\\") {
                out += next ?? "";
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
                if (text[i] === "\n") out += "\n";
                i++;
            }
            i += 2;
            continue;
        }
        if (c === ",") {
            // Sondaki virgül: ardından (boşluk ve yorumlar atlanınca) `}` ya da `]` geliyorsa yazılmaz
            let j = i + 1;
            for (;;) {
                while (j < text.length && /\s/.test(text[j]!)) j++;
                if (text[j] === "/" && text[j + 1] === "/") {
                    while (j < text.length && text[j] !== "\n") j++;
                    continue;
                }
                if (text[j] === "/" && text[j + 1] === "*") {
                    j += 2;
                    while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
                    j += 2;
                    continue;
                }
                break;
            }
            if (text[j] === "}" || text[j] === "]") {
                i++;
                continue;
            }
        }
        out += c;
        i++;
    }
    return out;
};

const fail = (pointer: string, message: string) => new CliError("validation_error", `${PERAFLY_JSONC}: ${message}`, { exitCode: 2, pointer });
const esc = (k: string | number) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const onlyKeys = (v: Record<string, unknown>, allowed: string[], at: string) => {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) throw fail(`${at}/${esc(k)}`, `unknown key "${k}" at ${at || "/"}`);
};
const str = (v: unknown, at: string, { optional = false, nullable = false, max = 2048 } = {}) => {
    if (v === undefined && optional) return;
    if (v === null && nullable) return;
    if (typeof v !== "string" || !v || v.length > max) throw fail(at, `${at} must be a non-empty string`);
};
const arr = (v: unknown, at: string, max = 1024): unknown[] => {
    if (!Array.isArray(v)) throw fail(at, `${at} must be an array`);
    if (v.length > max) throw fail(at, `${at} has more than ${max} items`);
    return v;
};

export interface PeraflyConfig {
    $schema?: string;
    build?: { rootDirectory?: string | null; installCommand?: string | null; buildCommand?: string | null; outputDirectory?: string | null; framework?: string | null };
    redirects?: { source: string; destination: string; permanent?: boolean; statusCode?: number }[];
    rewrites?: { source: string; destination: string }[];
    headers?: { source: string; headers: { key: string; value: string }[] }[];
    crons?: { path: string; schedule: string }[];
    access?: "private" | "public";
}

export const validatePeraflyConfig = (value: unknown): PeraflyConfig => {
    if (!isObj(value)) throw fail("", "the file must contain a JSON object");
    onlyKeys(value, ["$schema", "build", "redirects", "rewrites", "headers", "crons", "access"], "");
    str(value.$schema, "/$schema", { optional: true });
    if (value.build !== undefined) {
        if (!isObj(value.build)) throw fail("/build", "/build must be an object");
        const keys = ["rootDirectory", "installCommand", "buildCommand", "outputDirectory", "framework"];
        onlyKeys(value.build, keys, "/build");
        for (const k of keys) str(value.build[k], `/build/${k}`, { optional: true, nullable: true });
    }
    if (value.redirects !== undefined) {
        arr(value.redirects, "/redirects").forEach((r, i) => {
            const at = `/redirects/${i}`;
            if (!isObj(r)) throw fail(at, `${at} must be an object`);
            onlyKeys(r, ["source", "destination", "permanent", "statusCode"], at);
            str(r.source, `${at}/source`);
            str(r.destination, `${at}/destination`);
            if (r.permanent !== undefined && typeof r.permanent !== "boolean") throw fail(`${at}/permanent`, `${at}/permanent must be true or false`);
            if (r.statusCode !== undefined && ![301, 302, 307, 308].includes(r.statusCode as number)) throw fail(`${at}/statusCode`, `${at}/statusCode must be 301, 302, 307 or 308`);
        });
    }
    if (value.rewrites !== undefined) {
        arr(value.rewrites, "/rewrites").forEach((r, i) => {
            const at = `/rewrites/${i}`;
            if (!isObj(r)) throw fail(at, `${at} must be an object`);
            onlyKeys(r, ["source", "destination"], at);
            str(r.source, `${at}/source`);
            str(r.destination, `${at}/destination`);
        });
    }
    if (value.headers !== undefined) {
        arr(value.headers, "/headers").forEach((h, i) => {
            const at = `/headers/${i}`;
            if (!isObj(h)) throw fail(at, `${at} must be an object`);
            onlyKeys(h, ["source", "headers"], at);
            str(h.source, `${at}/source`);
            arr(h.headers, `${at}/headers`, 64).forEach((kv, j) => {
                const p = `${at}/headers/${j}`;
                if (!isObj(kv)) throw fail(p, `${p} must be an object`);
                onlyKeys(kv, ["key", "value"], p);
                str(kv.key, `${p}/key`, { max: 256 });
                if (typeof kv.value !== "string" || kv.value.length > 4096) throw fail(`${p}/value`, `${p}/value must be a string`);
            });
        });
    }
    if (value.crons !== undefined) {
        arr(value.crons, "/crons", 100).forEach((c, i) => {
            const at = `/crons/${i}`;
            if (!isObj(c)) throw fail(at, `${at} must be an object`);
            onlyKeys(c, ["path", "schedule"], at);
            str(c.path, `${at}/path`);
            if (typeof c.path === "string" && !c.path.startsWith("/")) throw fail(`${at}/path`, `${at}/path must start with /`);
            str(c.schedule, `${at}/schedule`, { max: 128 });
            if (typeof c.schedule === "string" && c.schedule.trim().split(/\s+/).length !== 5) throw fail(`${at}/schedule`, `${at}/schedule must have 5 fields`);
        });
    }
    if (value.access !== undefined && value.access !== "private" && value.access !== "public") throw fail("/access", "/access must be private or public");
    return value as PeraflyConfig;
};

export const parsePeraflyConfig = (text: string): PeraflyConfig => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonc(text));
    } catch (error) {
        throw fail("", `invalid JSON (${(error as Error).message})`);
    }
    return validatePeraflyConfig(parsed);
};

/** Klasördeki `perafly.jsonc`; yoksa null */
export const readPeraflyConfig = async (dir: string): Promise<PeraflyConfig | null> => {
    let text: string;
    try {
        text = await readFile(join(dir, PERAFLY_JSONC), "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
    return parsePeraflyConfig(text);
};

export const defaultPeraflyConfig = () => `{
  "$schema": "${SCHEMA_URL}"
  // "build": { "outputDirectory": "dist" },
  // "redirects": [{ "source": "/old", "destination": "/new", "permanent": true }],
  // "headers": [{ "source": "/assets/(.*)", "headers": [{ "key": "Cache-Control", "value": "max-age=31536000" }] }]
}
`;
