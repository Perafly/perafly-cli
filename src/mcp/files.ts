/**
 * Yerel MCP'nin dosya erişimi (README §6.2). GÜVENLİK SINIRI.
 *
 * Kök: `--workspace-root` / `PERAFLY_MCP_WORKSPACE_ROOT` → başlangıç klasörü. Araç yalnız kökün içindeki yolu okur:
 * kök dışındaki mutlak yol, köke kaçan yol (`..`), sembolik bağ (yolun herhangi bir bölümünde) ve düzenli olmayan dosya
 * reddedilir. Dışlama kuralları (src/publish/exclude.ts) toplamada ayrıca uygulanır.
 */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CliError } from "../errors.js";

export const resolveWorkspaceRoot = async (opts: { flag?: string; env?: NodeJS.ProcessEnv; cwd?: string }) => {
    const raw = opts.flag || opts.env?.PERAFLY_MCP_WORKSPACE_ROOT || opts.cwd || process.cwd();
    const root = await realpath(resolve(raw)).catch(() => null);
    if (!root) throw new CliError("validation_error", `Workspace root not found: ${raw}`, { exitCode: 2 });
    const st = await lstat(root);
    if (!st.isDirectory()) throw new CliError("validation_error", "The workspace root must be a folder", { exitCode: 2 });
    return root;
};

const inside = (root: string, target: string) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Araç girdisindeki yol → kökün içindeki gerçek yol. Hata mesajı kök dışını açıklamaz (yalnız reddeder).
 */
export const resolveInsideRoot = async (rootInput: string, input: unknown): Promise<string> => {
    // Kök de gerçek yoluna çevrilir (ör. macOS'ta /var → /private/var): karşılaştırma iki gerçek yol arasında
    const root = await realpath(rootInput);
    const p = input === undefined || input === null || input === "" ? "." : input;
    if (typeof p !== "string" || p.length > 1024 || p.includes("\u0000")) throw new CliError("validation_error", "path must be a relative path inside the workspace", { exitCode: 2 });
    const candidate = isAbsolute(p) ? resolve(p) : resolve(root, p);
    if (!inside(root, candidate)) throw new CliError("path_outside_workspace", "path must stay inside the workspace", { exitCode: 2 });
    // Her bölüm denetlenir: aradaki bir bağ kökün dışına çıkarabilir
    const parts = relative(root, candidate).split(sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
        if (part === "..") throw new CliError("path_outside_workspace", "path must stay inside the workspace", { exitCode: 2 });
        current = resolve(current, part);
        const st = await lstat(current).catch(() => null);
        if (!st) throw new CliError("validation_error", `Not found: ${p}`, { exitCode: 2 });
        if (st.isSymbolicLink()) throw new CliError("path_outside_workspace", "Symbolic links are not followed", { exitCode: 2 });
    }
    const real = await realpath(candidate);
    if (!inside(root, real)) throw new CliError("path_outside_workspace", "path must stay inside the workspace", { exitCode: 2 });
    const st = await lstat(real);
    if (!st.isDirectory() && !st.isFile()) throw new CliError("validation_error", "path must be a folder or a file", { exitCode: 2 });
    return real;
};
