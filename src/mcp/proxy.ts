/**
 * `perafly mcp proxy`: stdio ↔ barındırılan MCP köprüsü (README §2.5, §6.1). GÜVENLİK SINIRI.
 *
 * Kimlik CLI girişindeki `pfa_` anahtarıdır; yalnız onu veren API'nin MCP adresine (`https://api…/mcp`, üretimde
 * `https://mcp.perafly.com`) ya da yerel döngü adresine gönderilir. Başka adres reddedilir. Sahipsiz projenin anahtarı
 * (`pfc_`) köprüden gitmez.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { CliError } from "../errors.js";

const PRODUCTION_API = "https://api.perafly.com";
const PRODUCTION_MCP = "https://mcp.perafly.com";
const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

export const defaultMcpEndpoint = (apiUrl: string) => (apiUrl === PRODUCTION_API ? PRODUCTION_MCP : `${apiUrl}/mcp`);

/** Köprünün anahtarı gönderebileceği adres mi (saf) */
export const allowedMcpEndpoint = (apiUrl: string, endpoint: string): boolean => {
    let e: URL;
    let a: URL;
    try {
        e = new URL(endpoint);
        a = new URL(apiUrl);
    } catch {
        return false;
    }
    if (e.username || e.password || e.hash) return false;
    if (isLoopback(e.hostname) && (e.protocol === "http:" || e.protocol === "https:")) return true;
    if (e.protocol !== "https:") return false;
    if (e.origin === a.origin && e.pathname.replace(/\/+$/, "") === `${a.pathname.replace(/\/+$/, "")}/mcp`) return true;
    if (a.origin === PRODUCTION_API && e.origin === PRODUCTION_MCP) return true;
    return false;
};

export const startProxy = async (opts: { endpoint: string; apiUrl: string; token: string }) => {
    if (!allowedMcpEndpoint(opts.apiUrl, opts.endpoint)) {
        throw new CliError("validation_error", `The MCP endpoint must be the Perafly MCP server for ${opts.apiUrl} (https), or localhost.`, { exitCode: 2 });
    }
    if (!/^pfa_[0-9A-Za-z]{32}$/.test(opts.token)) throw new CliError("auth_required", "The bridge needs a sign-in. Run perafly login.", { exitCode: 10, recovery: "perafly login" });
    const local = new StdioServerTransport();
    const remote = new StreamableHTTPClientTransport(new URL(opts.endpoint), { requestInit: { headers: { Authorization: `Bearer ${opts.token}`, "User-Agent": "perafly-mcp-proxy" } } });
    const replyError = (msg: JSONRPCMessage, message: string) => {
        const id = (msg as any)?.id;
        if (id === undefined || id === null) return;
        void local.send({ jsonrpc: "2.0", id, error: { code: -32603, message } } as JSONRPCMessage);
    };
    local.onmessage = (msg) => {
        remote.send(msg).catch((error: any) => {
            const status = /401|Unauthorized/i.test(String(error?.message)) ? "Perafly rejected the sign-in. Run perafly login." : "Could not reach the Perafly MCP server.";
            process.stderr.write(`[perafly mcp proxy] ${status}\n`);
            replyError(msg, status);
        });
    };
    remote.onmessage = (msg) => void local.send(msg);
    remote.onerror = (error) => process.stderr.write(`[perafly mcp proxy] ${error?.message ?? error}\n`);
    let done: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => (done = resolve));
    local.onclose = () => {
        void remote.close();
        done();
    };
    remote.onclose = () => void local.close();
    process.stdin.once("end", () => done());
    await remote.start();
    await local.start();
    process.stderr.write(`Perafly MCP bridge → ${opts.endpoint}\n`);
    await closed;
};
