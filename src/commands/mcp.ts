/**
 * `mcp`, `mcp proxy`, `mcp install`, `setup agent` (README §2.5). `mcp` ve `mcp proxy` stdout'ta MCP protokolünü
 * taşır, `--json` desteklemez.
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { resolveWorkspaceRoot } from "../mcp/files.js";
import { startLocalServer } from "../mcp/server.js";
import { defaultMcpEndpoint, startProxy } from "../mcp/proxy.js";
import { AGENTS, detectAgents, install, type AgentId, type Connection } from "../mcp/install.js";
import { table } from "../output/index.js";

export const mcpServe = async (ctx: Context, opts: { workspaceRoot?: string }) => {
    const root = await resolveWorkspaceRoot({ flag: opts.workspaceRoot, env: ctx.env, cwd: ctx.cwd });
    await startLocalServer({ root, flags: { apiUrl: ctx.flags.apiUrl, profile: ctx.flags.profile }, deps: ctx.deps });
};

export const mcpProxy = async (ctx: Context, opts: { endpoint?: string }) => {
    const key = await ctx.apiKey();
    if (!key) throw ctx.authRequired();
    const endpoint = opts.endpoint || ctx.env.PERAFLY_MCP_URL || defaultMcpEndpoint(ctx.apiUrl);
    await startProxy({ endpoint, apiUrl: ctx.apiUrl, token: key.token });
};

export interface SetupFlags {
    agent?: string[];
    local?: boolean;
    remote?: boolean;
    oauth?: boolean;
    skipMcp?: boolean;
    skipSkill?: boolean;
    scope?: string;
    force?: boolean;
    dryRun?: boolean;
}

export const setupAgent = async (ctx: Context, flags: SetupFlags, mode: "setup" | "mcp-install") => {
    const requested = (flags.agent ?? []).flatMap((a) => a.split(",")).map((a) => a.trim()).filter(Boolean);
    for (const a of requested) if (![...AGENTS, "auto", "all"].includes(a)) throw new CliError("validation_error", `Unknown agent: ${a}. Use claude-code, cursor, codex, auto or all.`, { exitCode: 2 });
    let agents: AgentId[];
    if (requested.includes("all")) agents = [...AGENTS];
    else if (!requested.length || requested.includes("auto")) agents = await detectAgents();
    else agents = requested as AgentId[];
    if (!agents.length) throw new CliError("validation_error", "No agent clients found. Pass --agent claude-code, cursor or codex.", { exitCode: 2 });
    if (flags.oauth && !flags.remote) throw new CliError("validation_error", "--oauth works only with --remote.", { exitCode: 2 });
    const connection: Connection = flags.remote ? (flags.oauth ? "oauth" : "remote") : "local";
    const scope = flags.scope === "project" ? "project" : "user";
    if (flags.scope && flags.scope !== "user" && flags.scope !== "project") throw new CliError("validation_error", "--scope must be user or project.", { exitCode: 2 });
    if (connection !== "oauth" && !(await ctx.apiKey())) ctx.output.warn("You're not signed in. The MCP server will only publish without an account until you run perafly login.");
    const steps = await install({
        agents, connection, scope, cwd: ctx.cwd, mcpUrl: ctx.env.PERAFLY_MCP_URL || defaultMcpEndpoint(ctx.apiUrl),
        skipMcp: flags.skipMcp, skipSkill: mode === "mcp-install" ? true : flags.skipSkill, force: flags.force, dryRun: flags.dryRun
    });
    ctx.output.success({ agents, connection, scope, steps }, () =>
        [table(steps.map((s) => [s.agent, s.item, s.action, s.target, s.note ?? ""]), ["AGENT", "ITEM", "RESULT", "TARGET", "NOTE"]), "", flags.dryRun ? "Dry run: nothing was written." : "Restart the agent client to load Perafly."].join("\n")
    );
};
