/**
 * `perafly` (kısa adı `pf`) — giriş noktası. Bayrak ve komut sözleşmesi README §2–§4'tedir.
 * `run(argv, deps)` testten de çağrılır; çıkış kodunu döner (süreçten çıkmaz).
 */
import { realpathSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { assertNoSecretInArgv } from "./auth/token.js";
import { CliError } from "./errors.js";
import { Context, type ContextDeps, type GlobalFlags } from "./context.js";
import { Output } from "./output/index.js";
import { VERSION } from "./version.js";
import * as auth from "./commands/auth.js";
import * as project from "./commands/project.js";
import * as versions from "./commands/versions.js";
import { publish } from "./commands/publish.js";
import * as apiKeys from "./commands/apiKeys.js";
import * as mcpCommands from "./commands/mcp.js";
import * as usageCmd from "./commands/usage.js";
import * as agentCmd from "./commands/agent.js";
import * as observe from "./commands/observe.js";
import * as accessCmd from "./commands/access.js";
import * as dataCmd from "./commands/data.js";
import * as envCmd from "./commands/env.js";
import * as storageCmd from "./commands/storage.js";
import * as sftpCmd from "./commands/sftp.js";
import * as gitCmd from "./commands/git.js";
import * as apiCmd from "./commands/api.js";
import * as inspectCmd from "./commands/inspect.js";
import * as docsCmd from "./commands/docs.js";
import * as doctorCmd from "./commands/doctor.js";
import * as gitCredential from "./git/credential.js";
import { redact } from "./auth/redact.js";
import { binaryEntryPath } from "./binary.js";

export const run = async (argv: readonly string[], deps: ContextDeps = {}): Promise<number> => {
    const env = deps.env ?? process.env;
    const jsonRequested = argv.includes("--json");
    let exitCode = 0;
    const fail = (error: unknown) => {
        exitCode = new Output({ json: jsonRequested, env, stdout: deps.stdout, stderr: deps.stderr, stdin: deps.stdin }).failure(error);
    };
    try {
        assertNoSecretInArgv(argv);
    } catch (error) {
        fail(error);
        return exitCode;
    }
    // Sürüm yalnız tek başına verildiğinde: alt komutların `--version <sürüm>` bayrağıyla (logs build, open) çakışmasın
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
        (deps.stdout ?? process.stdout).write(`${VERSION}\n`);
        return 0;
    }

    const program = new Command("perafly");
    program
        .description("Publish a folder to a live URL with Perafly.")
        .addHelpText("after", "\nRun perafly --version for the version. Docs: https://perafly.com/docs/cli")
        .option("--json", "machine-readable output")
        .option("--project <project>", "project id, name or live URL (PERAFLY_PROJECT)")
        .option("--team <team>", "team name or id (PERAFLY_TEAM)")
        .option("--api-url <url>", "API address (PERAFLY_API_URL)")
        .option("--profile <name>", "named profile (PERAFLY_PROFILE)")
        .option("-y, --yes", "confirm destructive actions (PERAFLY_YES)")
        .option("--cwd <path>", "run as if started in this folder")
        .showHelpAfterError()
        .exitOverride()
        .configureOutput({
            writeOut: (s) => (deps.stdout ?? process.stdout).write(s),
            writeErr: (s) => (deps.stderr ?? process.stderr).write(s)
        });

    /** Komut gövdesi: bağlamı kurar, hatayı çıktıya çevirir */
    const action = <A extends unknown[]>(fn: (ctx: Context, ...args: A) => Promise<void>) =>
        async (...args: unknown[]) => {
            const cmd = args[args.length - 1] as Command;
            const flags = cmd.optsWithGlobals() as GlobalFlags & Record<string, unknown>;
            try {
                const ctx = await Context.create(flags, deps);
                await fn(ctx, ...(args.slice(0, -1) as A));
            } catch (error) {
                fail(error);
            }
        };

    program.command("login").description("Sign in with your browser (device code) or a key on stdin")
        .addOption(new Option("--access <profile>", "full, agent or read").choices(["full", "agent", "read"]))
        .option("--token-stdin", "read an API key (pfa_…) from stdin")
        .option("--no-browser", "don't open the browser")
        .option("--handoff", "read a handoff link (…#pfh_…) from stdin; gives this folder an agent key for one project")
        .action(action((ctx, opts: any) => auth.login(ctx, { access: opts.access, tokenStdin: opts.tokenStdin, browser: opts.browser, handoff: opts.handoff })));
    program.command("logout").description("Revoke the CLI key and remove it from this computer").action(action((ctx) => auth.logout(ctx)));
    program.command("whoami").description("Show who you are signed in as").action(action((ctx) => auth.whoami(ctx)));
    program.command("usage").description("This period's plan, usage, overage, spend limit and agent credits").action(action((ctx) => usageCmd.usage(ctx)));
    program.command("teams").description("Teams").command("ls").description("List teams you are signed in to").action(action((ctx) => auth.teamsLs(ctx)));
    program.command("profiles").description("List profiles").action(action((ctx) => auth.profilesLs(ctx)));
    program.command("switch [team]").description("Make the profile for this team the default").action(action((ctx, team?: string) => auth.switchTeam(ctx, team)));

    program.command("init").description("Write perafly.jsonc; with --create, create and link a project")
        .option("--create", "create a project and link this folder")
        .option("-n, --name <name>", "project name")
        .action(action((ctx, opts: any) => project.init(ctx, { create: opts.create, name: opts.name })));
    program.command("link [project]").description("Link this folder to a project").action(action((ctx, ref?: string) => project.link(ctx, ref)));
    program.command("unlink").description("Remove this folder's project link").action(action((ctx) => project.unlink(ctx, { yes: ctx.flags.yes })));
    program.command("status").description("Sign-in, linked project and live version").action(action((ctx) => project.status(ctx)));
    program.command("open").description("Open the live URL").option("--version <version>", "open a version URL instead")
        .action(action((ctx, opts: any) => project.open(ctx, { version: opts.version })));

    program.command("publish [dir]").description("Publish a folder, an HTML file or a .zip / .tar.gz archive")
        .option("-n, --name <name>", "name of a new project")
        .option("-m, --message <text>", "version note (default: last git commit message)")
        .addOption(new Option("--target <target>", "live or preview (default: live; with a branch, the project's branch rule decides)").choices(["live", "preview"]))
        .addOption(new Option("--publish-mode <mode>", "snapshot or additive").choices(["snapshot", "additive"]).default("snapshot"))
        .option("--branch <name>", "Git branch of this build (detected in GitHub Actions, GitLab CI, Bitbucket and CircleCI)")
        .option("--commit <sha>", "Git commit of this build (detected in CI)")
        .option("--prebuilt", "ready-made output; don't apply .gitignore rules")
        .addOption(new Option("--access <access>", "first access of a new project: private or public (only when publishing creates the project)").choices(["private", "public"]))
        .option("--dry-run", "show what would be published; upload nothing")
        .option("--no-wait", "return before the version is ready")
        .option("--wait-timeout <seconds>", "give up waiting after this long (exit 50)", "900")
        .action(action((ctx, dir: string | undefined, opts: any) => publish(ctx, dir, opts)));

    const v = program.command("versions").description("Versions of the project");
    v.command("ls").description("List versions").option("--state <state>").option("--limit <n>").option("--cursor <cursor>")
        .action(action((ctx, opts: any) => versions.versionsLs(ctx, opts)));
    v.command("get <version>").description("Show a version (vN or ver_…)").action(action((ctx, ver: string) => versions.versionsGet(ctx, ver)));
    v.command("rm <version>").description("Delete a version that is not live").action(action((ctx, ver: string) => versions.versionsRm(ctx, ver, { yes: ctx.flags.yes })));
    program.command("promote <version>").description("Make a ready version live (no rebuild); with an agent login it waits for approval")
        .option("--no-wait", "don't wait for approval (exit 2 with approval_required)").option("--wait-timeout <seconds>", "", "900")
        .action(action((ctx, ver: string, opts: any) => versions.promote(ctx, ver, { wait: opts.wait, waitTimeout: Number(opts.waitTimeout) })));
    program.command("rollback <version>").description("Move live back to an earlier version (asks for confirmation)")
        .option("--no-wait", "don't wait for approval").option("--wait-timeout <seconds>", "", "900")
        .action(action((ctx, ver: string, opts: any) => versions.promote(ctx, ver, { yes: ctx.flags.yes, rollback: true, wait: opts.wait, waitTimeout: Number(opts.waitTimeout) })));

    const ops = program.command("operations").description("Long-running operations");
    ops.command("get <id>").description("Show an operation").action(action((ctx, id: string) => versions.operationsGet(ctx, id, {})));
    ops.command("resume <id>").description("Result of an action a teammate approved (exe_…); waits for the decision")
        .option("--no-wait", "don't wait for the decision").option("--wait-timeout <seconds>", "", "900")
        .action(action((ctx, id: string, opts: any) => versions.operationsResume(ctx, id, { wait: opts.wait, timeout: Number(opts.waitTimeout) })));
    ops.command("wait <id>").description("Wait until an operation finishes").option("--wait-timeout <seconds>", "", "900")
        .action(action((ctx, id: string, opts: any) => versions.operationsGet(ctx, id, { wait: true, timeout: Number(opts.waitTimeout) })));

    const projects = program.command("projects").description("Projects");
    projects.command("ls").description("List projects").option("-q, --query <text>").option("--limit <n>").option("--cursor <cursor>")
        .action(action((ctx, opts: any) => project.projectsLs(ctx, { q: opts.query, limit: opts.limit, cursor: opts.cursor })));
    projects.command("get [project]").description("Show a project").action(action((ctx, ref?: string) => project.projectsGet(ctx, ref)));
    projects.command("create").description("Create an empty project").option("-n, --name <name>").option("--title <title>").option("--link", "link this folder")
        .action(action((ctx, opts: any) => project.projectsCreate(ctx, opts)));
    projects.command("update [project]").description("Rename, retitle or change the publish rule").option("-n, --name <name>").option("--title <title>").option("--publish-rule <rule>", "auto or manual")
        .action(action((ctx, ref: string | undefined, opts: any) => project.projectsUpdate(ctx, ref, opts)));
    projects.command("rm [project]").description("Delete a project and all its versions").action(action((ctx, ref: string | undefined) => project.projectsRm(ctx, ref, { yes: ctx.flags.yes })));
    projects.command("claim").description("Move the project published without an account into your team")
        .option("--keep-publishing", "give the publishing agent a key limited to this project")
        .action(action((ctx, opts: any) => project.projectsClaim(ctx, { keepPublishing: opts.keepPublishing })));

    const keys = program.command("api-keys").description("Team API keys (needs a full sign-in; agents can't create keys)");
    keys.command("ls").description("List API keys").action(action((ctx) => apiKeys.ls(ctx)));
    keys.command("create <name>").description("Create an API key; the secret is shown once")
        .option("--out <file>", "write the secret to this file (0600) instead of the screen")
        .action(action((ctx, name: string, opts: any) => apiKeys.create(ctx, name, { out: opts.out })));
    keys.command("revoke <key>").description("Revoke an API key (key_…)").action(action((ctx, id: string) => apiKeys.revoke(ctx, id, { yes: ctx.flags.yes })));

    const agent = program.command("agent").description("Perafly's built-in agent: describe a site, it builds and publishes a preview (full sign-in; spends agent credits)")
        .argument("[brief...]", "what to build, in quotes (- reads it from stdin); with --session, the message to send")
        .option("--project <project>", "work on an existing project (id or name)")
        .option("--budget <dollars>", "session budget in US dollars (default 5)")
        .option("--session <session>", "continue this session (ags_…): send the brief as a message and follow; without a brief, follow")
        .option("--new", "start a new session (the default)")
        .option("--detach", "send, print the session id and return without following (same as --no-wait)")
        .option("--no-wait", "start and return without following the agent")
        .option("--wait-timeout <seconds>", "stop following after this long (exit 50)", "3600")
        // `--project` genel bayrak olarak da tanımlı: Commander onu üst komuta verir, ikisine de bakılır
        .action(action((ctx, brief: string[] | undefined, opts: any) => agentCmd.agent(ctx, (brief ?? []).join(" "), {
            project: opts.project ?? ctx.flags.project, budget: opts.budget, session: opts.session, new: opts.new, detach: opts.detach, wait: opts.wait, waitTimeout: Number(opts.waitTimeout)
        })));
    agent.command("ls").description("List agent sessions").option("--project <project>", "only this project").action(action((ctx, opts: any) => agentCmd.ls(ctx, { project: opts.project ?? ctx.flags.project })));
    agent.command("attach <session>").description("Follow an agent session (ags_…)").option("--wait-timeout <seconds>", "", "3600")
        .action(action((ctx, id: string, opts: any) => agentCmd.attach(ctx, id, { waitTimeout: Number(opts.waitTimeout) })));
    agent.command("say <session> <message...>").description("Send a message to the agent and follow it").option("--no-wait", "return after sending").option("--wait-timeout <seconds>", "", "3600")
        .action(action((ctx, id: string, message: string[], opts: any) => agentCmd.say(ctx, id, message.join(" "), { wait: opts.wait, waitTimeout: Number(opts.waitTimeout) })));
    agent.command("stop <session>").description("Stop what the agent is doing").action(action((ctx, id: string) => agentCmd.stop(ctx, id)));
    agent.command("budget <session> <dollars>").description("Change the session budget; a paused session continues").action(action((ctx, id: string, dollars: string) => agentCmd.budget(ctx, id, dollars)));
    agent.command("allow <session> <event>").description("Allow a command the agent is waiting on").action(action((ctx, id: string, ev: string) => agentCmd.decide(ctx, id, ev, true, {})));
    agent.command("deny <session> <event>").description("Deny a command the agent is waiting on").option("--message <text>", "tell the agent why")
        .action(action((ctx, id: string, ev: string, opts: any) => agentCmd.decide(ctx, id, ev, false, { message: opts.message })));

    const collect = (v: string, prev: string[] = []) => [...prev, v];
    const setupOptions = (cmd: Command) =>
        cmd.option("--agent <id>", "claude-code, cursor, codex, auto or all (repeatable)", collect, [])
            .option("--local", "local server: perafly mcp (default)")
            .option("--remote", "hosted server through the bridge: perafly mcp proxy")
            .option("--oauth", "with --remote: connect the client to the hosted server with OAuth")
            .option("--scope <scope>", "user or project", "user")
            .option("--force", "replace an existing configuration or a changed skill")
            .option("--dry-run", "show what would be written");
    setupOptions(program.command("setup").description("Connect agent clients").command("agent").description("Find agent clients, write their MCP configuration and install the perafly skill"))
        .option("--skip-mcp", "only install the skill").option("--skip-skill", "only write the MCP configuration")
        .action(action((ctx, opts: any) => mcpCommands.setupAgent(ctx, opts, "setup")));
    const mcp = program.command("mcp").description("Local MCP server over stdio (stdout carries the protocol)")
        .option("--workspace-root <dir>", "folder the publish tool may read (PERAFLY_MCP_WORKSPACE_ROOT)")
        .action(action((ctx, opts: any) => mcpCommands.mcpServe(ctx, { workspaceRoot: opts.workspaceRoot })));
    mcp.command("proxy").description("Bridge stdio to the hosted MCP server with your CLI sign-in")
        .option("--endpoint <url>", "hosted MCP URL, https only (PERAFLY_MCP_URL)")
        .action(action((ctx, opts: any) => mcpCommands.mcpProxy(ctx, { endpoint: opts.endpoint })));
    setupOptions(mcp.command("install").description("Write only the MCP configuration for agent clients"))
        .action(action((ctx, opts: any) => mcpCommands.setupAgent(ctx, opts, "mcp-install")));

    const logsCmd = program.command("logs [kind]").description("Logs of the project, newest last: access (requests), runtime (your code) or build; all when omitted")
        .addOption(new Option("--level <level>", "this level and above").choices(["info", "warn", "error"]))
        .option("--since <time>", "15m, 2h, 3d or an ISO date")
        .option("--search <text>", "only lines containing this text")
        .option("--version <version>", "only this version (ver_… or v7)")
        .option("--limit <n>", "how many recent lines (max 500)", "100")
        .option("-f, --follow", "keep printing new lines (Ctrl-C to stop)")
        .option("--follow-timeout <seconds>", "stop following after this many seconds")
        .action(action((ctx, kind: string | undefined, opts: any) => observe.logs(ctx, kind, {
            level: opts.level, since: opts.since, search: opts.search, version: opts.version, limit: opts.limit, follow: opts.follow, followTimeout: opts.followTimeout
        })));
    // `--version` üst komutta da tanımlı: Commander onu üst komuta verebilir, ikisine de bakılır
    logsCmd.command("build").description("Build log of a version (from the hosting provider)").option("--version <version>")
        .action(action((ctx, opts: any) => versions.logsBuild(ctx, { version: opts.version ?? logsCmd.opts().version })));
    const share = program.command("share").description("Who can open the project: access, share link, password, people")
        .action(action((ctx) => accessCmd.shareStatus(ctx)));
    share.command("public").description("Make the project public (asks to confirm)").action(action((ctx) => accessCmd.shareMode(ctx, "public", { yes: ctx.flags.yes })));
    share.command("private").description("Make the project private: team, shared people, link or password").action(action((ctx) => accessCmd.shareMode(ctx, "private", {})));
    share.command("link").description("Create a share link (shown once; replaces the earlier link)").option("--revoke", "turn the share link off")
        .action(action((ctx, opts: any) => accessCmd.shareLink(ctx, { revoke: opts.revoke })));
    share.command("password").description("Set the visitor password from stdin").option("--clear", "remove the password")
        .action(action((ctx, opts: any) => accessCmd.sharePassword(ctx, { clear: opts.clear })));
    share.command("add <email>").description("Share with a person (they sign in to Perafly with that email)").action(action((ctx, email: string) => accessCmd.shareAdd(ctx, email)));
    share.command("rm <email>").description("Stop sharing with a person").action(action((ctx, who: string) => accessCmd.shareRemove(ctx, who)));
    const domains = program.command("domains").description("Custom domains");
    domains.command("ls").description("List custom domains and their DNS records").action(action((ctx) => accessCmd.domainsLs(ctx)));
    domains.command("add <domain>").description("Connect a custom domain and show the DNS record to set").action(action((ctx, name: string) => accessCmd.domainsAdd(ctx, name)));
    domains.command("check <domain>").description("Check verification and DNS now").action(action((ctx, name: string) => accessCmd.domainsCheck(ctx, name)));
    domains.command("rm <domain>").description("Disconnect a custom domain (asks to confirm)").action(action((ctx, name: string) => accessCmd.domainsRm(ctx, name, { yes: ctx.flags.yes })));
    program.command("metrics").description("Traffic and runtime metrics of a project: requests, visitors, errors, duration, CPU and memory")
        .addOption(new Option("--range <range>", "time range").choices(["1h", "24h", "7d", "30d"]).default("24h"))
        .action(action((ctx, opts: any) => observe.metrics(ctx, { range: opts.range })));
    program.command("top").description("The team's projects ranked by traffic, with errors, bandwidth and build time")
        .addOption(new Option("--range <range>", "time range").choices(["1h", "24h", "7d", "30d"]).default("1h"))
        .option("-w, --watch", "refresh until Ctrl-C")
        .option("--interval <seconds>", "refresh interval with --watch", "5")
        .option("--count <n>", "with --watch: stop after this many refreshes")
        .action(action((ctx, opts: any) => observe.top(ctx, { range: opts.range, watch: opts.watch, interval: opts.interval, count: opts.count })));

    // Faz 9: veri, ortam değişkenleri, depolama, SFTP (backend docs/API.md §20)
    const data = program.command("data").description("Headless data of the project: collections, records, keys and change hooks");
    const collections = data.command("collections").description("List collections (show, create, update, rm below)")
        .action(action((ctx) => dataCmd.collectionsLs(ctx)));
    collections.command("ls").description("List collections with field and record counts, rules and hook").action(action((ctx) => dataCmd.collectionsLs(ctx)));
    collections.command("show <name>").description("Show a collection's fields, rules and change hook").action(action((ctx, name: string) => dataCmd.collectionsShow(ctx, name)));
    collections.command("create <name>").description("Create a collection from a JSON schema { fields, rules?, hook? }")
        .requiredOption("--schema <file>", "schema file, or - for stdin")
        .action(action((ctx, name: string, opts: any) => dataCmd.collectionsCreate(ctx, name, { schema: opts.schema })));
    collections.command("update <name>").description("Change fields (the full list), rules or the hook from a JSON schema")
        .requiredOption("--schema <file>", "schema file, or - for stdin")
        .action(action((ctx, name: string, opts: any) => dataCmd.collectionsUpdate(ctx, name, { schema: opts.schema })));
    collections.command("rm <name>").description("Delete a collection and all its records (asks to confirm)").action(action((ctx, name: string) => dataCmd.collectionsRm(ctx, name, { yes: ctx.flags.yes })));
    data.command("ls <collection>").description("List records")
        .option("--filter <expr>", "field=value or field:op=value (op: eq, ne, gt, gte, lt, lte, in); repeatable", collect, [])
        .option("--sort <fields>", "e.g. -createdAt (at most two, comma-separated)")
        .option("--limit <n>", "records per page (1–100)")
        .option("--cursor <cursor>", "next page")
        .action(action((ctx, collection: string, opts: any) => dataCmd.recordsLs(ctx, collection, { filter: opts.filter, sort: opts.sort, limit: opts.limit, cursor: opts.cursor })));
    data.command("get <collection> <id>").description("Show a record").action(action((ctx, collection: string, id: string) => dataCmd.recordsGet(ctx, collection, id)));
    data.command("add <collection>").description("Add a record from JSON (a file or stdin)").option("--file <file>", "record JSON file, or - for stdin (default: stdin)")
        .action(action((ctx, collection: string, opts: any) => dataCmd.recordsAdd(ctx, collection, { file: opts.file })));
    data.command("update <collection> <id>").description("Change some fields of a record from JSON (null removes a field)").option("--file <file>", "JSON file, or - for stdin (default: stdin)")
        .action(action((ctx, collection: string, id: string, opts: any) => dataCmd.recordsUpdate(ctx, collection, id, { file: opts.file })));
    data.command("rm <collection> <id>").description("Delete a record (asks to confirm)").action(action((ctx, collection: string, id: string) => dataCmd.recordsRm(ctx, collection, id, { yes: ctx.flags.yes })));
    data.command("export <collection>").description("Export every record as CSV or JSON to a file or stdout")
        .addOption(new Option("--format <format>", "file format").choices(["csv", "json"]).default("csv"))
        .option("--out <file>", "write to this file (required with --json)")
        .action(action((ctx, collection: string, opts: any) => dataCmd.recordsExport(ctx, collection, { format: opts.format, out: opts.out })));
    data.command("keys").description("The publishable key and whether a secret key and webhook secret exist")
        .option("--create-secret", "create or replace the secret key (pfk_…); shown once")
        .option("--rotate-publishable", "replace the publishable key (asks to confirm)")
        .option("--revoke-secret", "revoke the secret key (asks to confirm)")
        .action(action((ctx, opts: any) => dataCmd.keys(ctx, { createSecret: opts.createSecret, rotatePublishable: opts.rotatePublishable, revokeSecret: opts.revokeSecret, yes: ctx.flags.yes })));
    data.command("hooks").description("The last 50 change hook deliveries").option("--collection <name>", "only this collection")
        .action(action((ctx, opts: any) => dataCmd.hooks(ctx, { collection: opts.collection })));

    const envGroup = program.command("env").description("Environment variables of the project; changes apply from the next version");
    envGroup.command("ls").description("List variables (sensitive values are never shown)").action(action((ctx) => envCmd.ls(ctx)));
    envGroup.command("set <name>").description("Add or change a variable; the value is read from stdin or a hidden prompt, never from arguments")
        .option("--plain", "not sensitive: the value stays visible to the team")
        .action(action((ctx, name: string, opts: any) => envCmd.set(ctx, name, { plain: opts.plain })));
    envGroup.command("rm <name>").description("Remove a variable (asks to confirm)").action(action((ctx, name: string) => envCmd.rm(ctx, name, { yes: ctx.flags.yes })));

    const storage = program.command("storage").description("Project storage: files under public/ (served at /_files/) and private/");
    storage.command("ls [prefix]").description("List folders and files under a prefix").option("--limit <n>", "files per page (1–1000)").option("--cursor <cursor>", "next page")
        .action(action((ctx, prefix: string | undefined, opts: any) => storageCmd.ls(ctx, prefix, { limit: opts.limit, cursor: opts.cursor })));
    storage.command("put <file> <path>").description("Upload a file (a path ending in / keeps the file name)").option("--content-type <type>", "for extensions Perafly doesn't know")
        .action(action((ctx, file: string, path: string, opts: any) => storageCmd.put(ctx, file, path, { contentType: opts.contentType })));
    storage.command("get <path> [file]").description("Download a file (to the file name here, a folder, or - for stdout)")
        .action(action((ctx, path: string, file: string | undefined) => storageCmd.get(ctx, path, file)));
    storage.command("mv <from> <to>").description("Move or rename a file, or a folder when <from> ends with /").option("--overwrite", "replace files that already exist")
        .action(action((ctx, from: string, to: string, opts: any) => storageCmd.mv(ctx, from, to, { overwrite: opts.overwrite })));
    storage.command("rm <path>").description("Delete a file, or a folder when the path ends with / (asks to confirm)").action(action((ctx, path: string) => storageCmd.rm(ctx, path, { yes: ctx.flags.yes })));
    storage.command("sync <dir> <prefix>").description("Upload files that are missing or differ in size under a prefix; deletes nothing").option("--dry-run", "show what would be uploaded")
        .action(action((ctx, dir: string, prefix: string, opts: any) => storageCmd.sync(ctx, dir, prefix, { dryRun: opts.dryRun })));

    const sftp = program.command("sftp").description("SFTP accounts for project storage (paid plans; a person's sign-in)");
    sftp.command("ls").description("Accounts, the server to connect to and whether the plan includes SFTP").action(action((ctx) => sftpCmd.ls(ctx)));
    sftp.command("add <label>").description("Open an account with an SSH public key or a generated password (shown once)")
        .option("--key <file>", "SSH public key file (.pub)")
        .option("--password", "generate a password (pfs_…) instead")
        .option("--readonly", "read and list only")
        .option("--folder <folder>", "read and write only this folder, e.g. public/uploads")
        .option("--ip <cidr>", "allow sign-in only from this address range; repeatable", collect, [])
        .option("--expires <date>", "ISO date when the account stops working")
        .action(action((ctx, label: string, opts: any) => sftpCmd.add(ctx, label, { key: opts.key, password: opts.password, readonly: opts.readonly, folder: opts.folder, ip: opts.ip, expires: opts.expires })));
    sftp.command("rm <account>").description("Revoke an account (sfa_… or its label; asks to confirm)").action(action((ctx, who: string) => sftpCmd.rm(ctx, who, { yes: ctx.flags.yes })));

    // Faz 10: Git ve CI (backend docs/API.md §21)
    const gitGroup = program.command("git").description("Git: GitHub connection, direct push remote, builds (status when no subcommand)")
        .action(action((ctx) => gitCmd.status(ctx)));
    gitGroup.command("status").description("GitHub connection, production branch, automatic deploys, push URL and the last 5 builds").action(action((ctx) => gitCmd.status(ctx)));
    gitGroup.command("remote").description("Add the project's push URL as a remote of this repository and let Git ask perafly for the key (never touches origin)")
        .option("--name <name>", "remote name", "perafly")
        .action(action((ctx, opts: any) => gitCmd.remote(ctx, { name: opts.name })));
    // Git'in kimlik yardımcısı: hata atmaz, çıkış hep 0 (Git sıradaki yolu dener); stdout'a yalnız yanıt satırları
    gitGroup.command("credential [operation]").description("Git credential helper (get, store, erase); Git runs it after perafly git remote")
        .action(async (operation: string | undefined, _opts: unknown, cmd: Command) => {
            try {
                const ctx = await Context.create(cmd.optsWithGlobals() as GlobalFlags, deps);
                await gitCredential.credentialHelper(ctx, operation);
            } catch (error) {
                (deps.stderr ?? process.stderr).write(`perafly: ${redact(error instanceof Error ? error.message : String(error))}\n`);
            }
        });
    gitGroup.command("set").description("Connect a GitHub repository or change the production branch and automatic deploys")
        .option("--production-branch <branch>", "branch that publishes to live")
        .addOption(new Option("--auto-production <on|off>", "publish the production branch to live automatically (turning on needs versions.promote)").choices(["on", "off"]))
        .addOption(new Option("--auto-previews <on|off>", "build other branches as branch previews").choices(["on", "off"]))
        .option("--repository <owner/name>", "GitHub repository from the team's installations")
        .option("--installation <id>", "with --repository: the GitHub installation to look in (default: all of the team's)")
        .action(action((ctx, opts: any) => gitCmd.set(ctx, { productionBranch: opts.productionBranch, autoProduction: opts.autoProduction, autoPreviews: opts.autoPreviews, repository: opts.repository, installation: opts.installation })));
    gitGroup.command("disconnect").description("Disconnect the GitHub repository (asks to confirm); versions and branch previews stay").action(action((ctx) => gitCmd.disconnect(ctx, { yes: ctx.flags.yes })));
    gitGroup.command("builds").description("The last 50 Git builds")
        .addOption(new Option("--status <status>", "only this status").choices(["queued", "running", "succeeded", "failed", "superseded", "awaiting_approval", "canceled"]))
        .action(action((ctx, opts: any) => gitCmd.builds(ctx, { status: opts.status })));
    gitGroup.command("approve <build>").description("Build a pull request from a fork (gbd_…); its code gets the project's environment variables (asks to confirm)")
        .action(action((ctx, build: string) => gitCmd.approve(ctx, build, { yes: ctx.flags.yes })));
    program.command("branches").description("Branch preview addresses and the version each one serves").action(action((ctx) => gitCmd.branches(ctx)));

    // Faz 11: yardımcılar (backend docs/API.md §15.3, §22.4)
    program.command("api <method> <path>").description("Raw request to the public API with this CLI's sign-in: GET, POST, PUT, PATCH or DELETE /v1/… (DELETE asks to confirm)")
        .option("-d, --data <json>", "JSON body: the value, @file or - for stdin")
        .option("-i, --include", "print the HTTP status and response headers to stderr")
        .addHelpText("after", "\nThe output is the response body (pretty JSON; one line with --json). The path stays on the configured API: full URLs are refused.\nExamples:\n  perafly api GET /v1/me\n  perafly api GET '/projects?q=site'\n  perafly api PATCH /v1/projects/my-site --data '{\"title\":\"My site\"}'")
        .action(action((ctx, method: string, path: string, opts: any) => apiCmd.api(ctx, method, path, { data: opts.data, include: opts.include })));
    program.command("inspect <address>").description("Which project and version a Perafly address belongs to (live, version, branch preview, custom domain, storage file)")
        .action(action((ctx, address: string) => inspectCmd.inspect(ctx, address)));
    program.command("docs <query...>").description("Search the Perafly docs (no sign-in needed)")
        .addOption(new Option("--lang <lang>", "en or tr (default: the system language, else en)").choices(["en", "tr"]))
        .option("--limit <n>", "how many results (1–20, default 8)")
        .action(action((ctx, words: string[], opts: any) => docsCmd.docs(ctx, words, { lang: opts.lang, limit: opts.limit })));
    // Yapılandırma okunamasa da rapor yazılsın: bağlamı doctor kendisi kurar
    program.command("doctor").description("Check this computer's setup: Node.js, API, sign-in, project link, perafly.jsonc, Git remote, agent clients")
        .action(async (_opts: unknown, cmd: Command) => {
            try {
                await doctorCmd.doctor(cmd.optsWithGlobals() as GlobalFlags, deps);
            } catch (error) {
                fail(error);
            }
        });

    // Çıplak `perafly` = status
    program.action(action((ctx) => project.status(ctx)));

    try {
        await program.parseAsync(["node", "perafly", ...argv]);
    } catch (error) {
        if (error instanceof CommanderError) {
            if (error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.code === "commander.help") return 0;
            // Commander iletisini zaten yazdı; JSON kipinde hata nesnesi de verilir
            if (jsonRequested) fail(new CliError("validation_error", error.message.replace(/^error:\s*/i, ""), { exitCode: 2 }));
            return 2;
        }
        fail(error);
    }
    return exitCode;
};

/** Tek dosya ikilide (scripts/build-binary.mjs, Node SEA) derlemede `true`; npm paketinde tanımsız */
declare const __PERAFLY_BINARY__: boolean | undefined;
const isBinary = typeof __PERAFLY_BINARY__ === "boolean" && __PERAFLY_BINARY__;

/* Doğrudan çalıştırıldıysa (dist/cli.js) ya da ikiliyse (giriş her zaman bu dosyadır) */
const isMain = (() => {
    if (isBinary) return true;
    try {
        const self = new URL(import.meta.url).pathname;
        const entry = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : "";
        return entry === self || /(^|[\\/])(perafly|pf|cli\.js)$/.test(process.argv[1] ?? "");
    } catch {
        return false;
    }
})();

if (isMain && !process.env.VITEST) {
    // İkilide `argv[1]` ham `argv[0]`'dır; Git kimlik yardımcısı mutlak yol yazsın (src/binary.ts)
    if (isBinary) {
        process.argv[1] = binaryEntryPath({
            argv1: process.argv[1], execPath: process.execPath, pathEnv: process.env.PATH, platform: process.platform, cwd: process.cwd(),
            realpath: (p) => {
                try {
                    return realpathSync(p);
                } catch {
                    return null;
                }
            }
        });
    }
    const ac = new AbortController();
    process.on("SIGINT", () => {
        ac.abort();
        process.exit(130);
    });
    run(process.argv.slice(2)).then((code) => process.exit(code));
}
