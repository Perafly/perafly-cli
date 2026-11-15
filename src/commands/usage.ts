/**
 * `usage` (README §2; backend docs/API.md §16.8): dönemin planı, kullanımı, aşımı, harcama sınırı ve ajan kredisi.
 * Yalnız okur; plan değiştirme ve satın alma panelde yapılır (CLI ve ajanlar faturayı değiştiremez).
 */
import type { Context } from "../context.js";
import { table } from "../output/index.js";

const usd = (cents: number | null | undefined) => (typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "—");
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "—");

const METER_LABEL: Record<string, string> = {
    build_seconds: "Build time", function_cpu_ms: "Function CPU", function_memory_mb_ms: "Function memory", function_invocations: "Function calls",
    bandwidth_bytes: "Bandwidth", workspace_cpu_ms: "Workspace CPU", workspace_memory_mb_ms: "Workspace memory", storage_byte_hours: "Storage",
    storage_transfer_bytes: "Storage transfer", data_requests: "Data API requests"
};

/** Ölçer miktarı okunur birimde */
export const formatQuantity = (unit: string, q: number): string => {
    const GB = 1024 ** 3;
    switch (unit) {
        case "second": return q < 120 ? `${Math.round(q)} s` : `${(q / 60).toFixed(1)} min`;
        case "millisecond": return q < 120_000 ? `${(q / 1000).toFixed(1)} s` : `${(q / 3_600_000).toFixed(2)} h`;
        case "byte": return q < GB ? `${(q / 1024 ** 2).toFixed(1)} MB` : `${(q / GB).toFixed(2)} GB`;
        case "megabyte_millisecond": return `${(q / (1024 * 3_600_000)).toFixed(2)} GB-h`;
        case "byte_hour": return `${(q / (GB * 730)).toFixed(2)} GB-mo`;
        default: return String(Math.round(q));
    }
};

export const usage = async (ctx: Context) => {
    const { client } = await ctx.requireApiKey();
    const d = (await client.get<any>("/v1/usage", { operationId: "getUsage" })).data;
    ctx.output.success(d, () => {
        const state = d.state?.blocked
            ? `New builds are paused (${d.state.reason === "spend_limit_reached" ? "spend limit reached" : "included usage used up"}). Live sites keep running.`
            : "Builds are running.";
        const summary = table([
            ["Plan", `${d.plan?.name ?? "—"} (${d.plan?.code ?? "—"})`],
            ["Period", `${day(d.period?.start)} – ${day(d.period?.end)}`],
            ["Usage", `${usd(d.usage?.totalCents)} of ${usd(d.usage?.includedCents)} included`],
            ["Overage", `${usd(d.usage?.overageCents)} (billed so far ${usd(d.usage?.billedOverageCents)})`],
            ["Spend limit", d.spendLimit ? `${usd(d.spendLimit.cents)}${d.spendLimit.isDefault ? " (default)" : ""}` : "—"],
            ["Agent credits", `${usd(d.credits?.balanceCents)} (plan ${usd(d.credits?.planCents)}, bought ${usd(d.credits?.packCents)})`],
            ["Status", state]
        ]);
        const lines = (d.usage?.lines ?? []) as any[];
        const detail = lines.length
            ? `\n\n${table(lines.map((l) => [METER_LABEL[l.meter] ?? l.meter, formatQuantity(l.unit, l.quantity), usd(l.amountCents)]), ["METER", "USED", "AMOUNT"])}`
            : "\n\nNo usage yet this period.";
        return `${summary}${detail}\n\nChange the plan or the spend limit in the Perafly panel.`;
    });
};
