/**
 * MCP araçları OpenAPI'den (README §6.2, §7): ad = `operationId`, girdi = yol + sorgu + gövde alanları. Liste elle
 * yazılmaz. Yerel ve barındırılan MCP aynı adları taşır; buna `publish`, `operation_status`, `resume_execution` eklenir.
 * Serbest biçimli gövde (kayıt alanları) `body` nesnesidir; deepObject sorgu (`filter`) nesne olarak alınır ve istemci
 * `filter[alan][op]=…` biçiminde açar (src/api/client.ts).
 */
import openapi from "../api/openapi.json" with { type: "json" };

export interface OpSpec {
    operationId: string;
    method: string;
    path: string;
    summary: string;
    pathParams: string[];
    queryParams: string[];
    bodyKeys: string[];
    bodyNested: boolean;
    schema: Record<string, any>;
}

/** Araç olmayan işlemler: yükleme ve tamamlama `publish` aracının içinde; kimlik ve anahtar işleri ajana verilmez */
export const HIDDEN_OPERATIONS = new Set([
    "uploadFile", "finalizeVersion", "publish", "startDeviceAuthorization", "pollDeviceAuthorization", "exchangeHandoff", "logout", "getOpenApi",
    "listApiKeys", "createApiKey", "revokeApiKey",
    // Yerleşik ajan araç değildir: ajan kredisini başka bir ajan harcamaz (backend docs/API.md §17.6)
    "listAgentSessions", "startAgentSession", "getAgentSession", "listAgentEvents", "sendAgentMessage", "interruptAgentSession", "setAgentBudget", "confirmAgentTool",
    // Erişim ve alan adı değişikliği kişinin kararıdır (backend docs/API.md §19.6)
    "setProjectAccess", "createShareLink", "revokeShareLink", "setSharePassword", "clearSharePassword", "addProjectShare", "removeProjectShare", "addProjectDomain", "checkProjectDomain", "removeProjectDomain",
    // Kimlik bilgisi üretmek, ortam değişkeni yazmak ve veriyi toptan silmek kişinin işidir (backend docs/API.md §20.3,
    // §20.5, §20.7); dosya baytı ve dışa aktarma araç gövdesine sığmaz. Barındırılan MCP ile aynı (app/mcp/hosted.ts)
    "rotatePublishableKey", "createSecretKey", "revokeSecretKey", "setEnvVar", "deleteEnvVar", "createSftpAccount", "revokeSftpAccount", "deleteCollection",
    "exportCollection", "createStorageUpload", "uploadStorageFile", "downloadStorageFile",
    // Depo bağlamak ve çataldan gelen kodu (projenin ortam değişkenleriyle) derletmek kişinin kararıdır (backend
    // docs/API.md §21.1); barındırılan MCP ile aynı
    "setProjectGit", "disconnectProjectGit", "approveGitBuild"
]);

/** İşlem → gereken izin; `null` her kimlik görür. Listede olmayan işlem araç olmaz. */
export const OPERATION_PERMISSION: Record<string, string | null> = {
    getMe: null, listProjects: "projects.read", getProject: "projects.read", createProject: "projects.write", updateProject: "projects.write",
    deleteProject: "projects.delete", listProjectVersions: "projects.read", getProjectVersion: "projects.read", deleteProjectVersion: "projects.delete",
    promoteProjectVersion: "versions.promote", listVersionFiles: "projects.read", getBuildLog: "projects.read", getOperation: "projects.read",
    claimProject: "projects.write", getExecution: "projects.read", resumeExecution: null, getUsage: "usage.read",
    // Gözlem (backend docs/API.md §18.7)
    listProjectLogs: "logs.read", getProjectMetrics: "usage.read", listProjectMetrics: "usage.read",
    getProjectAccess: "projects.read", listProjectDomains: "domains.read",
    // Veri ve depolama (backend docs/API.md §20): ajan şemayı tanımlar, kayıtları yazar, ön yüzü yayınlanabilir anahtarla bağlar
    listCollections: "projects.read", getCollection: "projects.read", createCollection: "projects.write", updateCollection: "projects.write",
    listRecords: "projects.read", getRecord: "projects.read", createRecord: "projects.write", updateRecord: "projects.write", deleteRecord: "projects.write",
    getDataKeys: "projects.read", listHookDeliveries: "projects.read", listEnvVars: "env.read",
    listStorage: "projects.read", getStorageFile: "projects.read", moveStorage: "projects.write", deleteStorage: "projects.write", listSftpAccounts: "projects.read",
    // Git (backend docs/API.md §21): ajan derlemeleri ve dal adreslerini okuyup hatayı bulabilsin
    getProjectGit: "projects.read", listGitBuilds: "projects.read", listProjectBranches: "projects.read",
    // Faz 11 (backend docs/API.md §15.3, §22.3, §22.4): adresten proje (CLI `inspect`), herkese açık planlar, belge
    // araması (CLI `docs`); barındırılan MCP ile aynı (app/mcp/hosted.ts)
    listPlans: null, lookupUrl: "projects.read", searchDocs: null
};

const resolveRefs = (schema: any, components: any, depth = 0): any => {
    if (!schema || typeof schema !== "object" || depth > 8) return schema;
    if (schema.$ref) return resolveRefs(components[String(schema.$ref).split("/").pop()!], components, depth + 1);
    if (Array.isArray(schema)) return schema.map((s) => resolveRefs(s, components, depth + 1));
    const out: any = {};
    for (const [k, v] of Object.entries(schema)) out[k] = resolveRefs(v, components, depth + 1);
    return out;
};

let cached: OpSpec[] | null = null;

export const operationSpecs = (doc: any = openapi): OpSpec[] => {
    if (cached && doc === openapi) return cached;
    const components = doc.components?.schemas ?? {};
    const specs: OpSpec[] = [];
    for (const [path, item] of Object.entries<any>(doc.paths)) {
        for (const method of ["get", "post", "patch", "delete", "put"]) {
            const op = item[method];
            if (!op?.operationId || HIDDEN_OPERATIONS.has(op.operationId) || !(op.operationId in OPERATION_PERMISSION)) continue;
            const params = [...(item.parameters || []), ...(op.parameters || [])].filter((p: any) => p.in === "path" || p.in === "query");
            const properties: Record<string, any> = {};
            const required: string[] = [];
            for (const p of params) {
                properties[p.name] = { ...(resolveRefs(p.schema, components) || { type: "string" }), ...(p.description ? { description: p.description } : {}) };
                if (p.in === "path" || p.required) required.push(p.name);
            }
            const bodySchema = resolveRefs(op.requestBody?.content?.["application/json"]?.schema, components);
            let bodyKeys: string[] = [];
            let bodyNested = false;
            if (bodySchema?.type === "object" && !bodySchema.properties && bodySchema.additionalProperties) {
                // Serbest biçimli gövde (kayıt alanları): araçta `body` nesnesi (barındırılan MCP ile aynı)
                bodyNested = true;
                properties.body = { type: "object", additionalProperties: true, description: "The record's fields" };
                if (op.requestBody?.required) required.push("body");
            } else if (bodySchema?.properties) {
                bodyKeys = Object.keys(bodySchema.properties);
                if (bodyKeys.some((k) => k in properties)) {
                    bodyNested = true;
                    properties.body = bodySchema;
                    if (op.requestBody?.required) required.push("body");
                } else {
                    Object.assign(properties, bodySchema.properties);
                    for (const r of bodySchema.required || []) required.push(r);
                }
            }
            specs.push({
                operationId: op.operationId, method: method.toUpperCase(), path, summary: op.summary || op.operationId,
                pathParams: params.filter((p: any) => p.in === "path").map((p: any) => p.name),
                queryParams: params.filter((p: any) => p.in === "query").map((p: any) => p.name),
                bodyKeys, bodyNested,
                schema: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties: false }
            });
        }
    }
    if (doc === openapi) cached = specs;
    return specs;
};

export const AGENT_RULES = [
    "Perafly publishes websites and keeps every version.",
    "Read a tool's input schema before calling it. After a write, read it back (getProject, getProjectVersion) before reporting success.",
    "Publishing over the live version or promoting with an agent login needs a teammate's approval: you get approval_required with an execution id and approvalUrl. Tell the user the URL, then call resume_execution. Never start a second action instead of the waiting one.",
    "Prefer target: preview while iterating; the version URL shows it without changing the live site.",
    "Given a Perafly address (live, version, branch preview, custom domain or storage file), call lookupUrl to find its project. For how-to questions and error codes, call searchDocs before guessing.",
    "Never add --yes or other confirmations on the user's behalf. You can't delete projects, manage keys, billing or members."
].join("\n");
