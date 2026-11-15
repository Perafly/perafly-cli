/**
 * Ajan istemcilerine MCP yapılandırması ve beceri kurulumu: `setup agent`, `mcp install` (README §2.5, §6.3).
 *
 *   claude-code  `claude mcp add` (varsa); beceri ~/.claude/skills/perafly (ya da projede .claude/skills/perafly)
 *   cursor       ~/.cursor/mcp.json (ya da projede .cursor/mcp.json) içinde `mcpServers.perafly`
 *   codex        ~/.codex/config.toml içinde `[mcp_servers.perafly]`
 *
 * Kimlik yapılandırmaya yazılmaz: yerel ve köprü bağlantısı CLI girişini kullanır, OAuth bağlantısını istemci kendisi
 * kurar. Değiştirilmiş beceri dosyasının üzerine `--force` olmadan yazılmaz.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.js";

export const AGENTS = ["claude-code", "cursor", "codex"] as const;
export type AgentId = (typeof AGENTS)[number];
export type Connection = "local" | "remote" | "oauth";

export interface InstallOptions {
    agents: AgentId[];
    connection: Connection;
    scope: "user" | "project";
    cwd: string;
    mcpUrl: string;
    skipMcp?: boolean;
    skipSkill?: boolean;
    force?: boolean;
    dryRun?: boolean;
    home?: string;
    /** Test: `claude` komutunu çalıştıran işlev */
    runClaude?: (args: string[]) => Promise<{ code: number; stdout: string }>;
}

export interface InstallStep { agent: AgentId; item: "mcp" | "skill"; action: "written" | "unchanged" | "skipped" | "planned" | "manual"; target: string; note?: string }

const run = (cmd: string, args: string[]): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err: any, stdout) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 127) : 0, stdout: String(stdout || "") })));

const which = async (cmd: string) => (await run(process.platform === "win32" ? "where" : "which", [cmd])).code === 0;

export const detectAgents = async (home = homedir()): Promise<AgentId[]> => {
    const found: AgentId[] = [];
    if (existsSync(join(home, ".claude")) || (await which("claude"))) found.push("claude-code");
    if (existsSync(join(home, ".cursor"))) found.push("cursor");
    if (existsSync(join(home, ".codex")) || (await which("codex"))) found.push("codex");
    return found;
};

/** Sunucu tanımı: yerel (`perafly mcp`), köprü (`perafly mcp proxy`) ya da OAuth (adres) */
export const serverSpec = (connection: Connection, mcpUrl: string) =>
    connection === "oauth" ? { url: mcpUrl } : { command: "perafly", args: connection === "remote" ? ["mcp", "proxy"] : ["mcp"] };

/** Tek dosya ikilide derlemede gömülen beceri (scripts/build-binary.mjs); npm paketinde tanımsız */
declare const __PERAFLY_EMBEDDED_SKILL__: string | undefined;

/** Paketteki beceri dosyası (dist/cli.js ya da src/mcp/install.ts'ten); ikilide gömülü kopya */
export const skillSource = async (): Promise<string> => {
    if (typeof __PERAFLY_EMBEDDED_SKILL__ === "string") return __PERAFLY_EMBEDDED_SKILL__;
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, "..", "skills", "perafly", "SKILL.md"), join(here, "..", "..", "skills", "perafly", "SKILL.md")]) {
        if (existsSync(candidate)) return readFile(candidate, "utf8");
    }
    throw new CliError("invalid_install", "The perafly skill is missing from the package. Reinstall perafly.", { exitCode: 1 });
};

const writeIfChanged = async (file: string, content: string, opts: { force?: boolean; dryRun?: boolean; protectChanges?: boolean }): Promise<InstallStep["action"]> => {
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === content) return "unchanged";
    if (current !== null && opts.protectChanges && !opts.force) return "skipped";
    if (opts.dryRun) return "planned";
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return "written";
};

const mergeJsonServer = async (file: string, spec: Record<string, unknown>, opts: { force?: boolean; dryRun?: boolean }): Promise<InstallStep["action"]> => {
    let json: any = {};
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw !== null) {
        try {
            json = JSON.parse(raw);
        } catch {
            throw new CliError("validation_error", `${file} is not valid JSON. Fix it, then run again.`, { exitCode: 2 });
        }
    }
    json.mcpServers = json.mcpServers && typeof json.mcpServers === "object" ? json.mcpServers : {};
    if (JSON.stringify(json.mcpServers.perafly) === JSON.stringify(spec)) return "unchanged";
    if (json.mcpServers.perafly && !opts.force) return "skipped";
    json.mcpServers.perafly = spec;
    return writeIfChanged(file, `${JSON.stringify(json, null, 2)}\n`, { dryRun: opts.dryRun });
};

const tomlSection = (spec: { url?: string; command?: string; args?: string[] }) =>
    spec.url ? `[mcp_servers.perafly]\nurl = ${JSON.stringify(spec.url)}\n` : `[mcp_servers.perafly]\ncommand = ${JSON.stringify(spec.command)}\nargs = ${JSON.stringify(spec.args)}\n`;

/** TOML'daki `[mcp_servers.perafly]` bölümü: başlıktan bir sonraki `[` ile başlayan satıra dek (dizideki `[` sayılmaz) */
const findSection = (raw: string): { start: number; end: number } | null => {
    const lines = raw.split("\n");
    const head = lines.findIndex((l) => l.trim() === "[mcp_servers.perafly]");
    if (head < 0) return null;
    let end = head + 1;
    while (end < lines.length && !lines[end]!.trim().startsWith("[")) end++;
    return { start: head, end };
};

const mergeToml = async (file: string, spec: any, opts: { force?: boolean; dryRun?: boolean }): Promise<InstallStep["action"]> => {
    const raw = (await readFile(file, "utf8").catch(() => null)) ?? "";
    const section = tomlSection(spec);
    const found = findSection(raw);
    if (found) {
        const lines = raw.split("\n");
        const current = lines.slice(found.start, found.end).join("\n");
        if (current.trim() === section.trim()) return "unchanged";
        if (!opts.force) return "skipped";
        const next = [...lines.slice(0, found.start), ...section.trimEnd().split("\n"), "", ...lines.slice(found.end)].join("\n");
        return writeIfChanged(file, next, { dryRun: opts.dryRun });
    }
    return writeIfChanged(file, `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}${raw ? "\n" : ""}${section}`, { dryRun: opts.dryRun });
};

export const install = async (opts: InstallOptions): Promise<InstallStep[]> => {
    const home = opts.home ?? homedir();
    const spec = serverSpec(opts.connection, opts.mcpUrl);
    const steps: InstallStep[] = [];
    const runClaude = opts.runClaude ?? ((args: string[]) => run("claude", args));
    for (const agent of opts.agents) {
        if (!opts.skipMcp) {
            if (agent === "claude-code") {
                const scope = opts.scope === "project" ? "project" : "user";
                const args = spec.url ? ["mcp", "add", "--scope", scope, "--transport", "http", "perafly", spec.url] : ["mcp", "add", "--scope", scope, "perafly", "--", spec.command!, ...spec.args!];
                if (opts.dryRun) steps.push({ agent, item: "mcp", action: "planned", target: `claude ${args.join(" ")}` });
                else {
                    const existing = await runClaude(["mcp", "get", "perafly"]);
                    if (existing.code === 127) steps.push({ agent, item: "mcp", action: "manual", target: `claude ${args.join(" ")}`, note: "claude is not on PATH: run this command" });
                    else if (existing.code === 0 && !opts.force) steps.push({ agent, item: "mcp", action: "skipped", target: "claude mcp (perafly exists)", note: "use --force to replace" });
                    else {
                        if (existing.code === 0) await runClaude(["mcp", "remove", "--scope", scope, "perafly"]);
                        const r = await runClaude(args);
                        steps.push({ agent, item: "mcp", action: r.code === 0 ? "written" : "manual", target: `claude ${args.join(" ")}`, ...(r.code === 0 ? {} : { note: "the command failed: run it yourself" }) });
                    }
                }
            } else if (agent === "cursor") {
                const file = opts.scope === "project" ? join(opts.cwd, ".cursor", "mcp.json") : join(home, ".cursor", "mcp.json");
                steps.push({ agent, item: "mcp", action: await mergeJsonServer(file, spec, opts), target: file });
            } else if (agent === "codex") {
                const file = join(home, ".codex", "config.toml");
                steps.push({ agent, item: "mcp", action: await mergeToml(file, spec, opts), target: file });
            }
        }
        if (!opts.skipSkill) {
            if (agent === "claude-code") {
                const base = opts.scope === "project" ? join(opts.cwd, ".claude") : join(home, ".claude");
                const file = join(base, "skills", "perafly", "SKILL.md");
                const action = await writeIfChanged(file, await skillSource(), { force: opts.force, dryRun: opts.dryRun, protectChanges: true });
                steps.push({ agent, item: "skill", action, target: file, ...(action === "skipped" ? { note: "the file was changed: use --force to replace" } : {}) });
            } else {
                steps.push({ agent, item: "skill", action: "skipped", target: "-", note: "no skill format for this client; the MCP server carries the same rules" });
            }
        }
    }
    return steps;
};
