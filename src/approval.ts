/**
 * Onay bekleyen iş (README §4.3; backend docs/API.md §15.9). Ajan profilli kimliğin riskli işi bir yürütme (`exe_…`)
 * açar; bir takım arkadaşı panelden ya da mobilden onaylar. CLI `--wait` ile kararı bekler; `--no-wait` ile
 * `approval_required` (çıkış 2) ve sürdürme komutunu verir. Bekleyen işin yerine ikinci iş başlatılmaz.
 */
import { CliError } from "./errors.js";
import type { ApiClient } from "./api/client.js";
import type { Output } from "./output/index.js";

export interface ExecutionBrief {
    id: string;
    status: string;
    kind?: string;
    approvalUrl?: string | null;
    expiresAt?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `--no-wait` hatası: yürütme kimliği, onay adresi ve sürdürme komutu */
export const approvalRequired = (e: ExecutionBrief) =>
    new CliError("approval_required", `A teammate must approve this in Perafly${e.approvalUrl ? `: ${e.approvalUrl}` : ""}. Then run perafly operations resume ${e.id}.`, {
        exitCode: 2,
        status: 403,
        recovery: `perafly operations resume ${e.id}`,
        details: { execution: e }
    });

/**
 * Kararı bekler. Onaylanıp yürütülünce son yürütme nesnesini döner; reddedilirse `approval_declined` (çıkış 10),
 * süresi dolarsa `approval_expired` (çıkış 20), bekleme süresi aşılırsa `wait_timeout` (çıkış 50).
 */
export const waitForApproval = async (client: ApiClient, e: ExecutionBrief, opts: { output: Output; timeoutSeconds: number; sleep?: (ms: number) => Promise<void> }) => {
    opts.output.notice(`Waiting for a teammate to approve${e.approvalUrl ? ` at ${e.approvalUrl}` : " in Perafly"} (expires ${e.expiresAt ?? "in 10 minutes"}).`);
    const deadline = Date.now() + opts.timeoutSeconds * 1000;
    const wait = opts.sleep ?? sleep;
    for (;;) {
        const r = await client.get<any>(`/v1/executions/${encodeURIComponent(e.id)}`, { operationId: "getExecution" });
        const ex = r.data;
        if (ex.status === "succeeded") return ex;
        if (ex.status === "failed") throw new CliError(ex.error?.code || "execution_failed", `Approved, but the action failed: ${ex.error?.message || "unknown error"}`, { exitCode: 1 });
        if (ex.status === "denied") throw new CliError("approval_declined", `A teammate declined the request${ex.reason ? `: ${ex.reason}` : ""}.`, { exitCode: 10 });
        if (ex.status === "expired") throw new CliError("approval_expired", "Nobody approved the request within 10 minutes. Run the command again if it's still needed.", { exitCode: 20 });
        if (Date.now() > deadline) throw new CliError("wait_timeout", "Still waiting for approval. The request stays open in Perafly.", { exitCode: 50, recovery: `perafly operations resume ${e.id}` });
        await wait(3000);
    }
};

/** Onaylanmış işin sonucu (`POST /v1/executions/{id}/resume`) */
export const resume = (client: ApiClient, id: string) => client.post<any>(`/v1/executions/${encodeURIComponent(id)}/resume`, { operationId: "resumeExecution" }).then((r) => r.data);
