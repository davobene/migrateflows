/*
 * flowise core: converts Flowise chatflows and agentflows into n8n workflows.
 * Runs in the browser (window.flowmigra) and in Node (require). No network access, no data leaves the machine.
 *
 * Input:  a map { "path/inside/upload": "file text" } (single chatflow exports, Flowise "Export all" files, or both).
 * Output: { workflows: [{ name, fileName, n8n, report, coverage }], summary, reportMarkdown(lang) }
 *
 * Flowise is Apache-2.0; this file contains only our own code.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.flowmigra = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LC = "@n8n/n8n-nodes-langchain.";
  const NB = "n8n-nodes-base.";
  let uid = 0;
  const newId = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    uid += 1;
    return "00000000-0000-4000-8000-" + String(uid).padStart(12, "0");
  };

  // ------------------------------------------------------------------ small helpers

  const str = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : String(v));
  const num = (v) => {
    if (v === "" || v === undefined || v === null || typeof v === "boolean") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const bool = (v) => v === true || v === "true";
  function clean(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
      out[k] = v;
    }
    return out;
  }
  function parseJSON(v, fallback) {
    if (v && typeof v === "object") return v;
    if (typeof v !== "string" || !v.trim()) return fallback;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }
  function slug(s) {
    return str(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "flow";
  }
  // Flowise v2 stores rich text as HTML (TipTap); variables are spans with {{ name }}.
  function htmlToText(s) {
    let t = str(s);
    if (!/<[a-z][\s\S]*>/i.test(t)) return t;
    t = t.replace(/<span[^>]*data-type="mention"[^>]*>([\s\S]*?)<\/span>/gi, "$1")
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n").replace(/<\/(h\d|li|div)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    return t.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ------------------------------------------------------------------ messages (es / en)

  const MSG = {
    es: {
      title: "Informe de conversión Flowise → n8n",
      intro: "Cada flujo de Flowise se convirtió en uno o más flujos de n8n listos para importar (Workflows → Import from File). Abajo, lo que quedó hecho y lo que falta revisar.",
      creds: "Credenciales para crear en n8n",
      ok: "Hecho", adjust: "Revisar", manual: "A mano",
      coverage: "Cobertura",
      none: "Nada pendiente.",
      nodes: "nodos",
      ingest: "carga de documentos",
      generated: "Flujos generados",
      note: "Nota de Flowise",
    },
    en: {
      title: "Flowise → n8n conversion report",
      intro: "Each Flowise flow was converted into one or more n8n workflows ready to import (Workflows → Import from File). Below is what was done and what still needs a look.",
      creds: "Credentials to create in n8n",
      ok: "Done", adjust: "Review", manual: "Manual",
      coverage: "Coverage",
      none: "Nothing pending.",
      nodes: "nodes",
      ingest: "document loading",
      generated: "Generated workflows",
      note: "Flowise note",
    },
  };

  // Notes are stored as keys + args so the report can be rendered in both languages.
  const NOTE = {
    mapped: { es: (a) => `${a.from} → ${a.to}`, en: (a) => `${a.from} → ${a.to}` },
    unsupported: { es: (a) => `"${a.label}" (${a.name}) no tiene equivalente directo en n8n; quedó fuera.`, en: (a) => `"${a.label}" (${a.name}) has no direct n8n equivalent; left out.` },
    unreachable: { es: (a) => `"${a.label}" no está conectado al inicio del flujo en Flowise; no se convirtió.`, en: (a) => `"${a.label}" is not connected to the flow's start in Flowise; not converted.` },
    unknownNode: { es: (a) => `Nodo "${a.label}" (${a.name}) no reconocido; quedó fuera.`, en: (a) => `Unrecognised node "${a.label}" (${a.name}); left out.` },
    credential: { es: (a) => `Crear credencial "${a.cred}" y elegirla en "${a.node}".`, en: (a) => `Create a "${a.cred}" credential and select it in "${a.node}".` },
    crqa: { es: () => "La cadena conversacional de preguntas sobre documentos pasó a un Agente de IA con la base vectorial como herramienta. El agente decide cuándo buscar; el mensaje de sistema le pide buscar siempre.", en: () => "The conversational retrieval QA chain became an AI Agent with the vector store as a tool. The agent decides when to search; the system message tells it to always search." },
    rephraseDropped: { es: () => "El prompt de reformulación de Flowise no se usa: el agente reformula solo.", en: () => "Flowise's rephrase prompt is not used: the agent rephrases on its own." },
    inMemory: { es: (a) => `La base vectorial "${a.label}" era en memoria o local (${a.name}). En n8n pasó a "Simple Vector Store" con la clave "${a.key}": primero corré el flujo de carga de documentos. Se borra al reiniciar n8n; para producción conviene Qdrant, Pinecone, Supabase o Postgres.`, en: (a) => `Vector store "${a.label}" was in-memory or local (${a.name}). In n8n it became "Simple Vector Store" with key "${a.key}": run the document loading workflow first. It is cleared when n8n restarts; for production use Qdrant, Pinecone, Supabase or Postgres.` },
    persistentStore: { es: (a) => `La base vectorial "${a.label}" sigue apuntando a ${a.where}. Si es la misma base, los documentos ya cargados se usan sin volver a cargarlos (con el mismo modelo de embeddings).`, en: (a) => `Vector store "${a.label}" still points to ${a.where}. If it is the same database, documents already loaded are used without reloading (with the same embeddings model).` },
    ingestBuilt: { es: (a) => `Se generó el flujo "${a.name}" para cargar documentos en la base vectorial.`, en: (a) => `Generated workflow "${a.name}" to load documents into the vector store.` },
    fileReupload: { es: (a) => `"${a.label}": subí el archivo de nuevo desde el formulario del flujo de carga (Flowise guarda los archivos en su propio almacenamiento).`, en: (a) => `"${a.label}": upload the file again through the loading workflow's form (Flowise keeps files in its own storage).` },
    fileInline: { es: (a) => `"${a.label}": el contenido del archivo ${a.file} venía dentro del export y quedó en un nodo Code del flujo de carga.`, en: (a) => `"${a.label}": the content of ${a.file} was inside the export and now lives in a Code node of the loading workflow.` },
    docStore: { es: (a) => `"${a.label}" usa un Document Store de Flowise y este export no lo trae. Exportá con Settings → Export → All (marcando Document Stores) y convertí ese archivo, o volvé a subir los documentos con el flujo de carga.`, en: (a) => `"${a.label}" uses a Flowise Document Store that this export does not include. Export with Settings → Export → All (with Document Stores checked) and convert that file, or upload the documents again with the loading workflow.` },
    docStoreMemory: { es: (a) => `El Document Store "${a.label}" no tenía base vectorial propia en Flowise; en n8n pasó a "Simple Vector Store" con la clave "${a.key}" (${a.n} fragmentos). Corré primero su flujo de carga.`, en: (a) => `Document Store "${a.label}" had no vector database in Flowise; in n8n it became "Simple Vector Store" with key "${a.key}" (${a.n} chunks). Run its loading workflow first.` },
    docStoreNoEmb: { es: (a) => `El Document Store "${a.label}" no tenía modelo de embeddings configurado; se puso OpenAI. Usá el mismo con el que se cargaron los datos.`, en: (a) => `Document Store "${a.label}" had no embeddings model configured; OpenAI was used. Use the same one the data was loaded with.` },
    docStoreChunks: { es: (a) => `Los ${a.n} fragmentos del Document Store "${a.label}" venían en el export y quedaron en el flujo "${a.name}".`, en: (a) => `The ${a.n} chunks of Document Store "${a.label}" were in the export and now live in workflow "${a.name}".` },
    webLoader: { es: (a) => `"${a.label}" bajaba ${a.url}. En n8n lo hace un nodo HTTP Request; el HTML llega sin limpiar.`, en: (a) => `"${a.label}" fetched ${a.url}. In n8n an HTTP Request node does it; HTML arrives uncleaned.` },
    customToolCode: { es: (a) => `Herramienta "${a.name}": el código pasó a un nodo Code Tool. Los parámetros llegan en "query" y se copiaron a las variables $nombre de Flowise. Probala con un mensaje real.`, en: (a) => `Tool "${a.name}": the code moved to a Code Tool node. Parameters arrive in "query" and were copied into Flowise's $name variables. Test it with a real message.` },
    customToolMissing: { es: (a) => `La herramienta personalizada "${a.label}" no trae su código en este export (Flowise la guarda aparte). Exportá con "Export all" desde Configuración de Flowise y convertí ese archivo, o pegá el código en el nodo "${a.node}".`, en: (a) => `Custom tool "${a.label}" has no code in this export (Flowise stores it separately). Use "Export all" from Flowise settings and convert that file, or paste the code into node "${a.node}".` },
    requireOther: { es: (a) => `Herramienta "${a.name}": el código usa require() de otros módulos. n8n Cloud no lo permite; en n8n propio se habilita con NODE_FUNCTION_ALLOW_EXTERNAL.`, en: (a) => `Tool "${a.name}": the code uses require() for other modules. n8n Cloud does not allow it; self-hosted n8n enables it with NODE_FUNCTION_ALLOW_EXTERNAL.` },
    vars: { es: () => "El código usa $vars (variables de Flowise). En n8n son $vars (planes con Variables) o reemplazalas por valores.", en: () => "The code uses $vars (Flowise variables). In n8n they are $vars (plans with Variables) or replace them with values." },
    flowVar: { es: () => "El código usa $flow (sessionId, chatId, input). Se armó un $flow mínimo con la sesión y el mensaje del chat.", en: () => "The code uses $flow (sessionId, chatId, input). A minimal $flow was built with the chat session and message." },
    httpTool: { es: (a) => `"${a.label}" pasó a una herramienta HTTP Request que el agente completa sola. Revisá la URL y cargá la credencial ${a.cred}.`, en: (a) => `"${a.label}" became an HTTP Request tool the agent fills in. Check the URL and add the ${a.cred} credential.` },
    mcpStdio: { es: (a) => `"${a.label}" corre un servidor MCP local por comando (stdio). n8n solo se conecta por URL (HTTP o SSE): exponelo con un puente como supergateway y poné la URL.`, en: (a) => `"${a.label}" runs a local MCP server by command (stdio). n8n only connects by URL (HTTP or SSE): expose it with a bridge such as supergateway and set the URL.` },
    assistant: { es: () => "OpenAI apagó la API de Assistants. El asistente pasó a un Agente de IA con modelo de OpenAI: copiá las instrucciones del asistente al mensaje de sistema.", en: () => "OpenAI shut down the Assistants API. The assistant became an AI Agent with an OpenAI model: copy the assistant's instructions into the system message." },
    moderation: { es: (a) => `"${a.label}" (moderación de entrada) no se convirtió. En n8n podés agregar el nodo Guardrails antes del agente.`, en: (a) => `"${a.label}" (input moderation) was not converted. In n8n you can add the Guardrails node before the agent.` },
    cache: { es: (a) => `"${a.label}" (caché del modelo) no tiene equivalente; se omitió.`, en: (a) => `"${a.label}" (model cache) has no equivalent; omitted.` },
    zodParsed: { es: () => "El esquema zod del parser se tradujo a JSON Schema.", en: () => "The parser's zod schema was translated to JSON Schema." },
    zodFailed: { es: () => "No se pudo traducir el esquema zod del parser; quedó un ejemplo vacío para completar.", en: () => "The parser's zod schema could not be translated; an empty example was left to fill in." },
    autofix: { es: () => "Flowise tenía la autocorrección del parser activa. En n8n se activa con \"Auto-Fix Format\" y un modelo conectado al parser.", en: () => "Flowise had parser auto-fix on. In n8n enable \"Auto-Fix Format\" and connect a model to the parser." },
    llamaIndex: { es: (a) => `"${a.label}" es de LlamaIndex; se tradujo al equivalente de LangChain en n8n.`, en: (a) => `"${a.label}" is a LlamaIndex node; translated to n8n's LangChain equivalent.` },
    subQuestion: { es: () => "El motor de sub-preguntas pasó a un agente con cada base como herramienta: el agente divide la pregunta solo.", en: () => "The sub-question engine became an agent with each index as a tool: the agent splits the question on its own." },
    noEnding: { es: () => "No se encontró el nodo final (cadena o agente) del flujo.", en: () => "The flow's ending node (chain or agent) was not found." },
    multiEnding: { es: (a) => `El flujo tiene ${a.n} nodos finales; cada uno quedó conectado al disparador de chat.`, en: (a) => `The flow has ${a.n} ending nodes; each one is connected to the chat trigger.` },
    supervisor: { es: () => "El equipo supervisor + trabajadores pasó a un Agente de IA principal con cada trabajador como sub-agente (AI Agent Tool).", en: () => "The supervisor + workers team became a main AI Agent with each worker as a sub-agent (AI Agent Tool)." },
    seqAgents: { es: () => "Los agentes secuenciales (Agentflow v1) todavía no se convierten solos: usá el informe para rearmarlos o pedinos la migración.", en: () => "Sequential agents (Agentflow v1) are not converted automatically yet: use the report to rebuild them or ask us to migrate them." },
    promptVars: { es: (a) => `Variables del prompt sin valor en Flowise: ${a.vars}. Quedaron como texto; completalas.`, en: (a) => `Prompt variables with no value in Flowise: ${a.vars}. Left as text; fill them in.` },
    sessionId: { es: () => "La memoria usa la sesión del chat de n8n (sessionId).", en: () => "Memory uses n8n's chat session (sessionId)." },
    sql: { es: () => "La cadena SQL pasó a un agente; agregá la herramienta de tu base (Postgres, MySQL…) y su credencial.", en: () => "The SQL chain became an agent; add your database tool (Postgres, MySQL…) and its credential." },
    v2Approx: { es: (a) => `"${a.label}" (${a.name}) se aproximó: ${a.how}.`, en: (a) => `"${a.label}" (${a.name}) was approximated: ${a.how}.` },
    v2State: { es: () => "El estado del flujo ($flow.state) se guarda en un nodo Set al inicio; las actualizaciones posteriores se leen del nodo que las produjo.", en: () => "Flow state ($flow.state) is kept in a Set node at the start; later updates are read from the node that produced them." },
    v2Loop: { es: (a) => `El bucle vuelve a "${a.to}" hasta ${a.max} veces con un contador.`, en: (a) => `The loop goes back to "${a.to}" up to ${a.max} times with a counter.` },
    v2Human: { es: () => "La aprobación humana pasó a un nodo Wait con formulario: el flujo se pausa hasta que alguien responde.", en: () => "Human approval became a Wait node with a form: the flow pauses until someone answers." },
    v2Tool: { es: (a) => `Herramienta "${a.tool}" del nodo "${a.label}": buscá en n8n el nodo de ${a.tool} y conectalo al agente.`, en: (a) => `Tool "${a.tool}" in node "${a.label}": find n8n's ${a.tool} node and connect it to the agent.` },
    v2DocStore: { es: (a) => `"${a.label}" usa Document Stores de Flowise; conectá la base vectorial donde estén esos documentos.`, en: (a) => `"${a.label}" uses Flowise Document Stores; connect the vector store holding those documents.` },
    executeFlow: { es: (a) => `"${a.label}" llama a otro flujo de Flowise; en n8n elegí el flujo convertido en el nodo Execute Workflow.`, en: (a) => `"${a.label}" calls another Flowise flow; in n8n pick the converted workflow in the Execute Workflow node.` },
    customFunction: { es: (a) => `"${a.label}": el código JavaScript pasó a un nodo Code. Las variables $nombre se leen del item de entrada.`, en: (a) => `"${a.label}": the JavaScript moved to a Code node. $name variables are read from the input item.` },
  };

  // ------------------------------------------------------------------ reading inputs

  function flowKind(nodes) {
    const cats = new Set(nodes.map((n) => n.data && n.data.category));
    if (cats.has("Agent Flows")) return "agentflowv2";
    if (cats.has("Sequential Agents")) return "sequential";
    if (cats.has("Multi Agents")) return "multiagent";
    return "chatflow";
  }

  function readFlows(files) {
    const flows = [];
    const tools = {};
    const docStores = {};
    for (const path of Object.keys(files).sort()) {
      if (!/\.json$/i.test(path)) continue;
      const d = parseJSON(files[path], null);
      if (!d) continue;
      const base = path.split("/").pop().replace(/\.json$/i, "").replace(/ (Chatflow|Agentflow|AgentFlow)$/i, "");
      const pushFlow = (name, fd, extra) => {
        const flow = parseJSON(fd, null);
        if (!flow || !Array.isArray(flow.nodes)) return;
        flows.push(Object.assign({ name: name || base, nodes: flow.nodes, edges: flow.edges || [], source: path, kind: flowKind(flow.nodes) }, extra || {}));
      };
      if (Array.isArray(d.nodes)) { pushFlow(d.name || base, d); continue; }
      // Flowise "Export all" (Settings → Export): arrays keyed by entity
      const lists = ["ChatFlow", "AgentFlow", "AgentFlowV2", "AssistantFlow", "MultiAgent", "chatflows", "agentflows"];
      let found = false;
      for (const k of lists) if (Array.isArray(d[k])) { found = true; for (const cf of d[k]) pushFlow(cf.name, cf.flowData, { flowiseId: cf.id }); }
      for (const k of ["Tool", "tools"]) if (Array.isArray(d[k])) for (const t of d[k]) tools[t.id] = t;
      if (Array.isArray(d.DocumentStore)) for (const s of d.DocumentStore) {
        docStores[s.id] = Object.assign(docStores[s.id] || { chunks: [] }, { id: s.id, name: str(s.name), description: str(s.description),
          vs: parseJSON(s.vectorStoreConfig, null), emb: parseJSON(s.embeddingConfig, null) });
      }
      if (Array.isArray(d.DocumentStoreFileChunk)) for (const c of d.DocumentStoreFileChunk) {
        (docStores[c.storeId] = docStores[c.storeId] || { id: c.storeId, name: c.storeId, chunks: [] }).chunks.push({ n: c.chunkNo, text: str(c.pageContent), meta: parseJSON(c.metadata, {}) });
      }
      if (!found && Array.isArray(d)) for (const cf of d) if (cf && cf.flowData) pushFlow(cf.name, cf.flowData, { flowiseId: cf.id });
    }
    for (const s of Object.values(docStores)) s.chunks.sort((a, b) => a.n - b.n);
    return { flows, tools, docStores };
  }

  // ------------------------------------------------------------------ Flowise Document Stores

  // "id:name" or "id" → store from an "Export all" file (or null)
  function findStore(ctx, ref) {
    const id = str(ref).split(":")[0];
    return (ctx.docStores && ctx.docStores[id]) || null;
  }

  // Adds a retrieval node for a document store to builder b. mode: "retrieve-as-tool" | "retrieve" | "load".
  // Returns { node, ingest } where ingest is an extra Builder (loading workflow) or null.
  function storeRetrieval(b, ctx, store, mode, extra, onCred, onNote) {
    const vsName = store.vs && store.vs.name;
    const vs = vsName && VSTORES[vsName];
    const embName = store.emb && store.emb.name;
    const embF = EMBEDDINGS[embName] || EMBEDDINGS.openAIEmbeddings;
    const key = "flowise_ds_" + slug(store.name).toLowerCase();
    const base = clean(Object.assign({ mode }, extra || {}));
    let node;
    if (vs) {
      node = b.add(extra && extra.name ? extra.name : store.name, LC + vs.type, 1.3, clean(Object.assign(base, vs.params(store.vs.config || {}, mode))));
      delete node.parameters.name;
      onCred(vs.cred, node.name);
      onNote("ok", "persistentStore", { label: store.name, where: vs.where(store.vs.config || {}) });
    } else {
      node = b.add(extra && extra.name ? extra.name : store.name, LC + "vectorStoreInMemory", 1.3, Object.assign(base, { memoryKey: rl(key) }));
      delete node.parameters.name;
      onNote("adjust", "docStoreMemory", { label: store.name, key, n: store.chunks.length });
    }
    const e = embF((store.emb && store.emb.config) || {});
    const en = b.add(e.label, LC + e.type, e.v, e.params);
    onCred(e.cred, en.name);
    b.link(en, node, "ai_embedding");
    if (!embName) onNote("adjust", "docStoreNoEmb", { label: store.name });
    let ingest = null;
    if (!vs && store.chunks.length) {
      ingest = new Builder(`${store.name} – ${ctx.t.ingest}`);
      const trig = ingest.add("Load documents", NB + "manualTrigger", 1, {});
      const code = ingest.add("Document Store chunks", NB + "code", 2, { jsCode: "return " + JSON.stringify(store.chunks.map((c) => ({ json: { text: c.text, source: str(c.meta && (c.meta.source || c.meta.filename)) } })), null, 1) + ";" });
      const ins = ingest.add(store.name, LC + "vectorStoreInMemory", 1.3, { mode: "insert", memoryKey: rl(key) });
      const loader = ingest.add("Default Data Loader", LC + "documentDefaultDataLoader", 1.1, { dataType: "json", jsonMode: "expressionData", jsonData: "={{ $json.text }}", textSplittingMode: "custom" });
      const split = ingest.add("Keep Flowise chunks", LC + "textSplitterRecursiveCharacterTextSplitter", 1, { chunkSize: 100000, chunkOverlap: 0 });
      const ie = embF((store.emb && store.emb.config) || {});
      ingest.link(ingest.add(ie.label, LC + ie.type, ie.v, ie.params), ins, "ai_embedding");
      ingest.link(split, loader, "ai_textSplitter");
      ingest.link(loader, ins, "ai_document");
      ingest.link(trig, code);
      ingest.link(code, ins);
      onNote("ok", "docStoreChunks", { label: store.name, n: store.chunks.length, name: ingest.name });
    }
    return { node, ingest };
  }

  // ------------------------------------------------------------------ n8n workflow builder

  class Builder {
    constructor(name) {
      this.name = name;
      this.nodes = [];
      this.conns = {};
      this.names = new Set();
    }
    uniq(n) {
      let name = str(n).replace(/[\r\n]+/g, " ").trim().slice(0, 80) || "Node";
      if (!this.names.has(name)) { this.names.add(name); return name; }
      for (let i = 2; ; i++) if (!this.names.has(`${name} ${i}`)) { this.names.add(`${name} ${i}`); return `${name} ${i}`; }
    }
    add(name, type, typeVersion, parameters, extra) {
      const node = Object.assign({ parameters: parameters || {}, type, typeVersion, position: [0, 0], id: newId(), name: this.uniq(name) }, extra || {});
      this.nodes.push(node);
      return node;
    }
    link(from, to, type, outIndex, inIndex) {
      type = type || "main";
      const byType = (this.conns[from.name] = this.conns[from.name] || {});
      const outs = (byType[type] = byType[type] || []);
      const oi = outIndex || 0;
      while (outs.length <= oi) outs.push([]);
      if (!outs[oi].some((c) => c.node === to.name && c.index === (inIndex || 0))) outs[oi].push({ node: to.name, type, index: inIndex || 0 });
    }
    // Lays out main nodes left to right and AI sub-nodes in a tree below their parent.
    layout() {
      const byName = Object.fromEntries(this.nodes.map((n) => [n.name, n]));
      const children = {};
      const mainNext = {};
      const hasMainIn = new Set();
      for (const [src, types] of Object.entries(this.conns)) {
        for (const [type, outs] of Object.entries(types)) for (const out of outs) for (const c of out) {
          if (type === "main") { (mainNext[src] = mainNext[src] || []).push(c.node); hasMainIn.add(c.node); }
          else (children[c.node] = children[c.node] || []).push(src);
        }
      }
      const placed = new Set();
      const width = (n, seen) => {
        seen = seen || new Set();
        if (seen.has(n)) return 1;
        seen.add(n);
        const ch = (children[n] || []).filter((c) => !placed.has(c));
        return Math.max(1, ch.reduce((s, c) => s + width(c, seen), 0));
      };
      const placeSub = (n, x, y) => {
        const ch = (children[n] || []).filter((c) => !placed.has(c));
        let cx = x - ((width(n) - 1) * 180) / 2;
        for (const c of ch) {
          const w = width(c);
          const px = cx + ((w - 1) * 180) / 2;
          placed.add(c);
          byName[c].position = [Math.round(px), y];
          placeSub(c, px, y + 200);
          cx += w * 180;
        }
      };
      let x = 0, row = 0;
      const placeMain = (n, y) => {
        if (placed.has(n)) return;
        placed.add(n);
        byName[n].position = [x, y];
        placeSub(n, x + 40, y + 220);
        x += Math.max(260, width(n) * 180);
        (mainNext[n] || []).forEach((m, i) => placeMain(m, y + i * 140));
      };
      const roots = this.nodes.filter((n) => !hasMainIn.has(n.name) && !Object.values(children).some((cs) => cs.includes(n.name)) && n.type !== NB + "stickyNote");
      for (const r of roots) { placeMain(r.name, row); row += 0; }
      let sx = 0;
      for (const n of this.nodes) if (!placed.has(n.name)) {
        if (n.type === NB + "stickyNote") { n.position = [sx, -420]; sx += 320; }
        else { n.position = [x, 0]; x += 220; }
      }
    }
    json() {
      this.layout();
      return { name: this.name, nodes: this.nodes, connections: this.conns, pinData: {}, settings: { executionOrder: "v1" }, active: false, meta: { templateCredsSetupCompleted: false, convertedFrom: "flowise", converter: "MigrateFlows" } };
    }
  }

  // ------------------------------------------------------------------ catalogue of Flowise → n8n mappings

  const rl = (value) => ({ __rl: true, mode: "list", value: str(value) });

  // Chat models and LLMs. Each returns { type, v, params, cred }.
  const MODELS = {
    chatOpenAI: (i) => ({ type: "lmChatOpenAi", v: 1.2, cred: "OpenAI", label: "OpenAI Chat Model",
      params: { model: rl(i.modelName || "gpt-4o-mini"), options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP), frequencyPenalty: num(i.frequencyPenalty), presencePenalty: num(i.presencePenalty), timeout: num(i.timeout), baseURL: str(i.basepath) || undefined }) } }),
    chatOpenAICustom: (i) => ({ type: "lmChatOpenAi", v: 1.2, cred: "OpenAI (base URL propia)", label: "OpenAI-compatible Chat Model",
      params: { model: { __rl: true, mode: "id", value: str(i.modelName) }, options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP), baseURL: str(i.basepath) || undefined }) } }),
    chatLocalAI: (i) => ({ type: "lmChatOpenAi", v: 1.2, cred: "OpenAI (base URL LocalAI)", label: "LocalAI Chat Model",
      params: { model: { __rl: true, mode: "id", value: str(i.modelName) }, options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP), baseURL: str(i.basePath) || undefined }) } }),
    chatTogetherAI: (i) => ({ type: "lmChatOpenAi", v: 1.2, cred: "OpenAI (clave de Together AI)", label: "Together AI Chat Model",
      params: { model: { __rl: true, mode: "id", value: str(i.modelName) }, options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP), baseURL: "https://api.together.xyz/v1" }) } }),
    chatFireworks: (i) => ({ type: "lmChatOpenAi", v: 1.2, cred: "OpenAI (clave de Fireworks)", label: "Fireworks Chat Model",
      params: { model: { __rl: true, mode: "id", value: str(i.modelName) }, options: clean({ temperature: num(i.temperature), baseURL: "https://api.fireworks.ai/inference/v1" }) } }),
    azureChatOpenAI: (i) => ({ type: "lmChatAzureOpenAi", v: 1, cred: "Azure OpenAI", label: "Azure OpenAI Chat Model",
      params: { model: str(i.modelName || i.azureOpenAIApiDeploymentName), options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP), frequencyPenalty: num(i.frequencyPenalty), presencePenalty: num(i.presencePenalty), timeout: num(i.timeout) }) } }),
    chatAnthropic: (i) => ({ type: "lmChatAnthropic", v: 1.3, cred: "Anthropic", label: "Anthropic Chat Model",
      params: { model: rl(i.modelName || "claude-3-5-sonnet-latest"), options: clean({ maxTokensToSample: num(i.maxTokensToSample || i.maxTokens), temperature: num(i.temperature), topK: num(i.topK), topP: num(i.topP) }) } }),
    chatGoogleGenerativeAI: (i) => ({ type: "lmChatGoogleGemini", v: 1, cred: "Google Gemini (PaLM) API", label: "Google Gemini Chat Model",
      params: { modelName: "models/" + str(i.customModelName || i.modelName || "gemini-2.0-flash").replace(/^models\//, ""), options: clean({ maxOutputTokens: num(i.maxOutputTokens), temperature: num(i.temperature), topK: num(i.topK), topP: num(i.topP) }) } }),
    chatMistralAI: (i) => ({ type: "lmChatMistralCloud", v: 1, cred: "Mistral Cloud", label: "Mistral Cloud Chat Model",
      params: { model: str(i.modelName || "mistral-small-latest"), options: clean({ maxTokens: num(i.maxOutputTokens || i.maxTokens), temperature: num(i.temperature), topP: num(i.topP), randomSeed: num(i.randomSeed), safeMode: i.safeMode === "" ? undefined : bool(i.safeMode) || undefined }) } }),
    chatOllama: (i) => ({ type: "lmChatOllama", v: 1, cred: "Ollama" + (i.baseUrl ? ` (${i.baseUrl})` : ""), label: "Ollama Chat Model",
      params: { model: str(i.modelName || "llama3.2"), options: clean({ temperature: num(i.temperature), topK: num(i.topK), topP: num(i.topP), numCtx: num(i.numCtx), numGpu: num(i.numGpu), numThread: num(i.numThread), repeatPenalty: num(i.repeatPenalty) }) } }),
    groqChat: (i) => ({ type: "lmChatGroq", v: 1, cred: "Groq", label: "Groq Chat Model",
      params: { model: str(i.modelName || "llama-3.3-70b-versatile"), options: clean({ temperature: num(i.temperature), maxTokensToSample: num(i.maxTokens) }) } }),
    chatDeepseek: (i) => ({ type: "lmChatDeepSeek", v: 1, cred: "DeepSeek", label: "DeepSeek Chat Model",
      params: { model: str(i.modelName || "deepseek-chat"), options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP) }) } }),
    chatOpenRouter: (i) => ({ type: "lmChatOpenRouter", v: 1, cred: "OpenRouter", label: "OpenRouter Chat Model",
      params: { model: str(i.modelName), options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP) }) } }),
    chatXAI: (i) => ({ type: "lmChatXAiGrok", v: 1, cred: "xAI", label: "xAI Grok Chat Model",
      params: { model: str(i.modelName || "grok-3"), options: clean({ temperature: num(i.temperature), maxTokens: num(i.maxTokens) }) } }),
    chatCohere: (i) => ({ type: "lmChatCohere", v: 1, cred: "Cohere", label: "Cohere Chat Model",
      params: { model: str(i.modelName || "command-r-plus"), options: clean({ temperature: num(i.temperature) }) } }),
    awsChatBedrock: (i) => ({ type: "lmChatAwsBedrock", v: 1.1, cred: "AWS", label: "AWS Bedrock Chat Model",
      params: { model: str(i.customModel || i.model || i.modelName), options: clean({ temperature: num(i.temperature), maxTokensToSample: num(i.max_tokens_to_sample || i.maxTokens) }) } }),
    huggingFaceInference_LLMs: (i) => ({ type: "lmOpenHuggingFaceInference", v: 1, cred: "Hugging Face", label: "Hugging Face Inference Model",
      params: { model: str(i.model), options: clean({ endpointUrl: str(i.endpoint) || undefined, temperature: num(i.temperature), maxTokens: num(i.maxTokens), topP: num(i.topP), topK: num(i.hfTopK), frequencyPenalty: num(i.frequencyPenalty) }) } }),
    ollama: (i) => ({ type: "lmOllama", v: 1, cred: "Ollama" + (i.baseUrl ? ` (${i.baseUrl})` : ""), label: "Ollama Model",
      params: { model: str(i.modelName || "llama3.2"), options: clean({ temperature: num(i.temperature), topK: num(i.topK), topP: num(i.topP) }) } }),
  };
  MODELS.openAI = MODELS.chatOpenAI; // text-completion models: n8n uses the chat model node
  MODELS.chatOpenAI_LlamaIndex = MODELS.chatOpenAI;
  MODELS.azureChatOpenAI_LlamaIndex = MODELS.azureChatOpenAI;
  MODELS.chatAnthropic_LlamaIndex = MODELS.chatAnthropic;
  MODELS.chatMistral_LlamaIndex = MODELS.chatMistralAI;
  MODELS.chatOllama_LlamaIndex = MODELS.chatOllama;
  MODELS.chatGroq_LlamaIndex = MODELS.groqChat;
  MODELS.chatGoogleVertexAI = (i) => Object.assign(MODELS.chatGoogleGenerativeAI(i), { cred: "Google Gemini (PaLM) API (Flowise usaba Vertex)" });

  const EMBEDDINGS = {
    openAIEmbeddings: (i) => ({ type: "embeddingsOpenAi", v: 1.2, cred: "OpenAI", label: "Embeddings OpenAI",
      params: { model: str(i.modelName || "text-embedding-3-small"), options: clean({ dimensions: num(i.dimensions), batchSize: num(i.batchSize), stripNewLines: i.stripNewLines === "" ? undefined : bool(i.stripNewLines), timeout: num(i.timeout), baseURL: str(i.basepath) || undefined }) } }),
    openAIEmbeddingsCustom: (i) => ({ type: "embeddingsOpenAi", v: 1.2, cred: "OpenAI (base URL propia)", label: "Embeddings OpenAI-compatible",
      params: { model: str(i.modelName), options: clean({ dimensions: num(i.dimensions), baseURL: str(i.basepath) || undefined }) } }),
    localAIEmbeddings: (i) => ({ type: "embeddingsOpenAi", v: 1.2, cred: "OpenAI (base URL LocalAI)", label: "Embeddings LocalAI",
      params: { model: str(i.modelName), options: clean({ baseURL: str(i.basePath) || undefined }) } }),
    azureOpenAIEmbeddings: (i) => ({ type: "embeddingsAzureOpenAi", v: 1, cred: "Azure OpenAI", label: "Embeddings Azure OpenAI",
      params: { model: str(i.modelName || i.azureOpenAIApiDeploymentName), options: clean({ batchSize: num(i.batchSize), timeout: num(i.timeout) }) } }),
    cohereEmbeddings: (i) => ({ type: "embeddingsCohere", v: 1, cred: "Cohere", label: "Embeddings Cohere", params: { modelName: str(i.modelName || "embed-english-v3.0") } }),
    googleGenerativeAiEmbeddings: (i) => ({ type: "embeddingsGoogleGemini", v: 1, cred: "Google Gemini (PaLM) API", label: "Embeddings Google Gemini",
      params: { modelName: "models/" + str(i.modelName || "text-embedding-004").replace(/^models\//, "") } }),
    ollamaEmbedding: (i) => ({ type: "embeddingsOllama", v: 1, cred: "Ollama" + (i.baseUrl ? ` (${i.baseUrl})` : ""), label: "Embeddings Ollama", params: { model: str(i.modelName || "nomic-embed-text") } }),
    mistralAIEmbeddings: (i) => ({ type: "embeddingsMistralCloud", v: 1, cred: "Mistral Cloud", label: "Embeddings Mistral Cloud",
      params: { model: str(i.modelName || "mistral-embed"), options: clean({ batchSize: num(i.batchSize), stripNewLines: i.stripNewLines === "" ? undefined : bool(i.stripNewLines) }) } }),
    huggingFaceInferenceEmbeddings: (i) => ({ type: "embeddingsHuggingFaceInference", v: 1, cred: "Hugging Face", label: "Embeddings Hugging Face", params: { modelName: str(i.modelName) } }),
  };
  EMBEDDINGS.openAIEmbedding_LlamaIndex = EMBEDDINGS.openAIEmbeddings;
  EMBEDDINGS.azureOpenAIEmbedding_LlamaIndex = EMBEDDINGS.azureOpenAIEmbeddings;

  // Vector stores: where(i) describes the target for the report; params(i, mode) builds n8n parameters.
  const VSTORES = {
    pinecone: { type: "vectorStorePinecone", cred: "Pinecone", where: (i) => `el índice "${i.pineconeIndex}" de Pinecone`,
      params: (i, mode) => clean({ pineconeIndex: rl(i.pineconeIndex), options: clean({ pineconeNamespace: str(i.pineconeNamespace) || undefined }) }) },
    qdrant: { type: "vectorStoreQdrant", cred: "Qdrant", where: (i) => `la colección "${i.qdrantCollection}" de Qdrant`,
      params: (i, mode) => clean({ qdrantCollection: rl(i.qdrantCollection), options: mode === "insert" ? {} : clean({ searchFilterJson: parseJSON(i.qdrantFilter, undefined) }) }) },
    supabase: { type: "vectorStoreSupabase", cred: "Supabase", where: (i) => `la tabla "${i.tableName}" de Supabase`,
      params: (i, mode) => clean({ tableName: rl(i.tableName || "documents"), options: clean({ queryName: str(i.queryName) || undefined }) }) },
    postgres: { type: "vectorStorePGVector", cred: "Postgres", where: (i) => `la tabla "${i.tableName || "documents"}" de Postgres (pgvector)`,
      params: (i, mode) => clean({ tableName: str(i.tableName || "documents") }) },
    chroma: { type: "vectorStoreChromaDB", cred: "ChromaDB", where: (i) => `la colección "${i.collectionName}" de Chroma`,
      params: (i, mode) => clean({ chromaCollection: rl(i.collectionName) }) },
    milvus: { type: "vectorStoreMilvus", cred: "Milvus", where: (i) => `la colección "${i.milvusCollection}" de Milvus`,
      params: (i, mode) => clean({ milvusCollection: rl(i.milvusCollection) }) },
    weaviate: { type: "vectorStoreWeaviate", cred: "Weaviate", where: (i) => `el índice "${i.weaviateIndex}" de Weaviate`,
      params: (i, mode) => clean({ weaviateCollection: rl(i.weaviateIndex) }) },
    redis: { type: "vectorStoreRedis", cred: "Redis", where: (i) => `el índice "${i.indexName}" de Redis`,
      params: (i, mode) => clean({ redisIndex: str(i.indexName) }) },
    mongoDBAtlas: { type: "vectorStoreMongoDBAtlas", cred: "MongoDB", where: (i) => `la colección "${i.collectionName}" de MongoDB Atlas`,
      params: (i, mode) => clean({ mongoCollection: rl(i.collectionName), vectorIndexName: str(i.indexName) }) },
  };
  VSTORES.pineconeLlamaIndex = VSTORES.pinecone;
  VSTORES.pineconeExistingIndex = VSTORES.pinecone;
  VSTORES.pineconeUpsert = VSTORES.pinecone;
  VSTORES.qdrantExistingIndex = VSTORES.qdrant;
  VSTORES.supabaseExistingIndex = VSTORES.supabase;
  VSTORES.chromaExistingIndex = VSTORES.chroma;
  VSTORES.postgresExistingIndex = VSTORES.postgres;
  const MEMORY_STORES = new Set(["memoryVectorStore", "faiss", "simpleStore", "simpleStoreLlamaIndex", "inMemoryVectorStore", "faissExistingIndex", "faissUpsert", "vectara"]);

  const SPLITTERS = {
    recursiveCharacterTextSplitter: (i) => ({ type: "textSplitterRecursiveCharacterTextSplitter", v: 1, params: clean({ chunkSize: num(i.chunkSize) ?? 1000, chunkOverlap: num(i.chunkOverlap) ?? 0 }) }),
    markdownTextSplitter: (i) => ({ type: "textSplitterRecursiveCharacterTextSplitter", v: 1, params: clean({ chunkSize: num(i.chunkSize) ?? 1000, chunkOverlap: num(i.chunkOverlap) ?? 0, options: { splitCode: "markdown" } }) }),
    htmlToMarkdownTextSplitter: (i) => ({ type: "textSplitterRecursiveCharacterTextSplitter", v: 1, params: clean({ chunkSize: num(i.chunkSize) ?? 1000, chunkOverlap: num(i.chunkOverlap) ?? 0, options: { splitCode: "markdown" } }) }),
    codeTextSplitter: (i) => ({ type: "textSplitterRecursiveCharacterTextSplitter", v: 1, params: clean({ chunkSize: num(i.chunkSize) ?? 1000, chunkOverlap: num(i.chunkOverlap) ?? 0, options: i.language ? { splitCode: str(i.language) } : undefined }) }),
    characterTextSplitter: (i) => ({ type: "textSplitterCharacterTextSplitter", v: 1, params: clean({ separator: str(i.separator) || undefined, chunkSize: num(i.chunkSize) ?? 1000, chunkOverlap: num(i.chunkOverlap) ?? 0 }) }),
    tokenTextSplitter: (i) => ({ type: "textSplitterTokenSplitter", v: 1, params: clean({ chunkSize: num(i.chunkSize) ?? 1000, chunkOverlap: num(i.chunkOverlap) ?? 0 }) }),
  };

  const MEMORIES = {
    bufferMemory: (i) => ({ type: "memoryBufferWindow", v: 1.3, params: { contextWindowLength: 10 } }),
    bufferWindowMemory: (i) => ({ type: "memoryBufferWindow", v: 1.3, params: { contextWindowLength: num(i.k) || 5 } }),
    conversationSummaryMemory: (i) => ({ type: "memoryBufferWindow", v: 1.3, params: { contextWindowLength: 10 } }),
    conversationSummaryBufferMemory: (i) => ({ type: "memoryBufferWindow", v: 1.3, params: { contextWindowLength: 10 } }),
    RedisBackedChatMemory: (i) => ({ type: "memoryRedisChat", v: 1.5, cred: "Redis", params: clean({ sessionTTL: num(i.sessionTTL), contextWindowLength: num(i.windowSize) || 10 }) }),
    UpstashRedisBackedChatMemory: (i) => ({ type: "memoryRedisChat", v: 1.5, cred: "Redis (datos de Upstash)", params: clean({ sessionTTL: num(i.sessionTTL), contextWindowLength: 10 }) }),
    postgresChatMemory: (i) => ({ type: "memoryPostgresChat", v: 1.3, cred: "Postgres", params: clean({ tableName: str(i.tableName) || undefined, contextWindowLength: 10 }) }),
    agentMemory: (i) => ({ type: "memoryBufferWindow", v: 1.3, params: { contextWindowLength: 10 } }),
  };

  // ------------------------------------------------------------------ zod (as text) → JSON Schema

  function zodToJsonSchema(code) {
    const mk = (schema) => {
      const o = { _s: schema };
      o.describe = (d) => { schema.description = d; return o; };
      o.optional = () => { o._opt = true; return o; };
      o.nullable = () => { schema.type = [].concat(schema.type, "null"); return o; };
      o.int = () => { schema.type = "integer"; return o; };
      o.array = () => mk({ type: "array", items: schema });
      o.or = (other) => mk({ anyOf: [schema, other._s] });
      for (const m of ["min", "max", "positive", "negative", "nonnegative", "email", "url", "uuid", "length", "default", "regex", "trim", "nonempty"]) o[m] = () => o;
      return o;
    };
    const z = {
      string: () => mk({ type: "string" }),
      number: () => mk({ type: "number" }),
      boolean: () => mk({ type: "boolean" }),
      date: () => mk({ type: "string", format: "date-time" }),
      any: () => mk({}),
      unknown: () => mk({}),
      literal: (v) => mk({ const: v }),
      enum: (vals) => mk({ type: "string", enum: vals }),
      array: (item) => mk({ type: "array", items: item._s }),
      object: (shape) => {
        const props = {}, req = [];
        for (const [k, v] of Object.entries(shape)) { props[k] = v._s; if (!v._opt) req.push(k); }
        return mk({ type: "object", properties: props, required: req });
      },
      union: (opts) => mk({ anyOf: opts.map((x) => x._s) }),
      record: (a, b) => mk({ type: "object", additionalProperties: (b || a)._s }),
    };
    z.coerce = z;
    // eslint-disable-next-line no-new-func
    const res = new Function("z", `"use strict"; return (
${str(code).trim().replace(/;\s*$/, "")}
);`)(z);
    if (!res || !res._s) throw new Error("not a zod schema");
    return res._s;
  }

  // ------------------------------------------------------------------ prompt templates

  // Flowise templates use {var}; promptValues maps vars to "{{question}}", node outputs or literals.
  function convertTemplate(tpl, promptValues, inputExpr, resolveRef) {
    const values = parseJSON(promptValues, {}) || {};
    const missing = [];
    const t = str(tpl).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, v) => {
      const val = values[v];
      if (val === undefined) {
        if (["question", "input", "text", "query", "human_input", "user_input", "userInput"].includes(v)) return `{{ ${inputExpr} }}`;
        if (["chat_history", "history", "context", "agent_scratchpad", "tools", "tool_names"].includes(v)) return m;
        missing.push(v);
        return m;
      }
      if (/^\{\{\s*question\s*\}\}$/.test(str(val))) return `{{ ${inputExpr} }}`;
      const ref = /^\{\{([^.}]+)\.data\.instance\}\}$/.exec(str(val));
      if (ref) { const e = resolveRef && resolveRef(ref[1]); if (e) return `{{ ${e} }}`; missing.push(v); return m; }
      return str(val);
    });
    return { text: t, missing, usesInput: t.includes(inputExpr) };
  }
  const expr = (t) => (t.includes("{{") ? "=" + t : t);

  // ------------------------------------------------------------------ chatflow conversion

  function graphOf(flow) {
    const nodes = {};
    for (const n of flow.nodes) nodes[n.id] = n;
    const inputs = {}; // targetId -> { inputName: [sourceId] }
    const outgoing = {};
    for (const e of flow.edges || []) {
      if (!nodes[e.source] || !nodes[e.target]) continue;
      const m = /-input-([^-]+)-/.exec(str(e.targetHandle));
      const inName = m ? m[1] : "unknown";
      ((inputs[e.target] = inputs[e.target] || {})[inName] = inputs[e.target][inName] || []).push(e.source);
      (outgoing[e.source] = outgoing[e.source] || []).push(e.target);
    }
    // Fallback to {{id.data.instance}} references when edges are missing.
    for (const n of flow.nodes) {
      for (const [k, v] of Object.entries((n.data && n.data.inputs) || {})) {
        for (const ref of [].concat(v)) {
          const m = /^\{\{([^.}]+)\.data\.instance\}\}$/.exec(str(ref));
          if (!m || !nodes[m[1]]) continue;
          const arr = ((inputs[n.id] = inputs[n.id] || {})[k] = inputs[n.id][k] || []);
          if (!arr.includes(m[1])) { arr.push(m[1]); (outgoing[m[1]] = outgoing[m[1]] || []).push(n.id); }
        }
      }
    }
    return { nodes, inputs, outgoing };
  }

  const ENDING_CATS = new Set(["Chains", "Agents", "Engine", "Multi Agents"]);

  function convertChatflow(flow, ctx) {
    const g = graphOf(flow);
    const b = new Builder(flow.name);
    const report = [];
    const creds = new Map();
    const note = (level, key, args) => report.push({ level, key, args: args || {} });
    const done = new Set();
    let total = 0, mapped = 0;
    const ins = (id, name) => ((g.inputs[id] || {})[name] || []);
    const inp = (n) => (n.data && n.data.inputs) || {};
    const label = (n) => str(n.data && n.data.label) || n.id;
    const real = flow.nodes.filter((n) => n.data && !/stickyNote/.test(n.data.name));
    total = real.length;
    const memKey = "flowise_" + slug(flow.name).toLowerCase();
    const extraWorkflows = [];
    const chatInput = "$('When chat message received').item.json.chatInput";
    const built = {};
    const OUT_FIELD = { chainLlm: "text", chainRetrievalQa: "response", agent: "output" };

    const addCred = (cred, nodeName) => { if (cred) { creds.set(cred + "|" + nodeName, { cred, node: nodeName }); } };
    const markDone = (n) => { if (!done.has(n.id)) { done.add(n.id); mapped++; } };

    function buildModel(id, parent, type) {
      const n = g.nodes[id];
      const f = MODELS[n.data.name];
      if (!f) { note("manual", "unsupported", { label: label(n), name: n.data.name }); return null; }
      if (/LlamaIndex/.test(n.data.name)) note("adjust", "llamaIndex", { label: label(n) });
      const m = f(inp(n));
      const node = b.add(m.label, LC + m.type, m.v, m.params);
      addCred(m.cred, node.name);
      for (const c of ins(id, "cache")) { note("adjust", "cache", { label: label(g.nodes[c]) }); markDone(g.nodes[c]); }
      markDone(n);
      if (parent) b.link(node, parent, type || "ai_languageModel");
      return node;
    }
    function firstModel(ids, parent) { for (const id of ids) { const m = buildModel(id, parent); if (m) return m; } return null; }

    function buildEmbeddings(id, parent) {
      const n = g.nodes[id];
      const f = EMBEDDINGS[n.data.name];
      if (!f) { note("manual", "unsupported", { label: label(n), name: n.data.name }); return null; }
      const e = f(inp(n));
      const node = b.add(e.label, LC + e.type, e.v, e.params);
      addCred(e.cred, node.name);
      markDone(n);
      if (parent) b.link(node, parent, "ai_embedding");
      return node;
    }

    function buildMemory(id, parent) {
      const n = g.nodes[id];
      const f = MEMORIES[n.data.name];
      if (!f) { note("manual", "unsupported", { label: label(n), name: n.data.name }); return null; }
      const m = f(inp(n));
      const node = b.add(label(n) || "Memory", LC + m.type, m.v, m.params);
      addCred(m.cred, node.name);
      markDone(n);
      b.link(node, parent, "ai_memory");
      return node;
    }

    // Vector store used for retrieval. mode: "retrieve" (feeds a retriever) or "retrieve-as-tool".
    function buildVectorStore(id, mode, toolInfo) {
      const n = g.nodes[id];
      const name = n.data.name;
      const i = inp(n);
      let node;
      if (name === "documentStoreVS") {
        markDone(n);
        const store = findStore(ctx, i.selectedStore);
        if (!store) { note("manual", "docStore", { label: label(n) }); return null; }
        const r = storeRetrieval(b, ctx, store, mode, toolInfo ? { name: toolInfo.name, toolDescription: toolInfo.description } : { topK: undefined }, addCred, note);
        if (r.ingest && !ctx.storeIngests[store.id]) { ctx.storeIngests[store.id] = true; extraWorkflows.push(r.ingest); }
        return r.node;
      }
      if (MEMORY_STORES.has(name)) {
        node = b.add(toolInfo ? toolInfo.name : label(n), LC + "vectorStoreInMemory", 1.3,
          clean({ mode, memoryKey: rl(memKey), toolDescription: toolInfo ? toolInfo.description : undefined, topK: mode === "retrieve-as-tool" ? num(i.topK) : undefined }));
        note("adjust", "inMemory", { label: label(n), name, key: memKey });
      } else if (VSTORES[name]) {
        const vs = VSTORES[name];
        node = b.add(toolInfo ? toolInfo.name : label(n), LC + vs.type, 1.3,
          clean(Object.assign({ mode, toolDescription: toolInfo ? toolInfo.description : undefined, topK: mode === "retrieve-as-tool" ? num(i.topK) : undefined }, vs.params(i, mode))));
        addCred(vs.cred, node.name);
        note("ok", "persistentStore", { label: label(n), where: vs.where(i) });
      } else {
        note("manual", "unsupported", { label: label(n), name });
        return null;
      }
      if (/LlamaIndex/.test(name)) note("adjust", "llamaIndex", { label: label(n) });
      markDone(n);
      for (const e of ins(id, "embeddings")) buildEmbeddings(e, node);
      // LlamaIndex stores carry their own model input; not needed for retrieval in n8n
      for (const mId of ins(id, "model")) markDone(g.nodes[mId]);
      buildIngestion(n, node);
      return node;
    }

    // Separate workflow that loads documents into the same vector store.
    const ingested = new Set();
    function buildIngestion(n, retrieveNode) {
      const docs = ins(n.id, "document");
      if (!docs.length || ingested.has(n.id)) return;
      ingested.add(n.id);
      const wb = new Builder(`${flow.name} – ${ctx.t.ingest}`);
      const name = n.data.name;
      const i = inp(n);
      let store;
      if (MEMORY_STORES.has(name)) store = wb.add(label(n), LC + "vectorStoreInMemory", 1.3, { mode: "insert", memoryKey: rl(memKey) });
      else {
        const vs = VSTORES[name];
        store = wb.add(label(n), LC + vs.type, 1.3, clean(Object.assign({ mode: "insert" }, vs.params(i, "insert"))));
      }
      for (const e of ins(n.id, "embeddings")) {
        const en = g.nodes[e], f = EMBEDDINGS[en.data.name];
        if (f) { const ee = f(inp(en)); wb.link(wb.add(ee.label, LC + ee.type, ee.v, ee.params), store, "ai_embedding"); }
      }
      const trigger = wb.add("Subir documentos", NB + "formTrigger", 2.2, {
        formTitle: `Cargar documentos – ${flow.name}`,
        formFields: { values: [{ fieldLabel: "Archivos", fieldType: "file", multipleFiles: true, requiredField: false }] },
        options: {},
      }, { webhookId: newId() });
      let sources = 0;
      let lastMain = trigger;
      const addLoader = (dataType, extra, splitterIds) => {
        const loader = wb.add("Default Data Loader", LC + "documentDefaultDataLoader", 1.1, Object.assign({ dataType, textSplittingMode: splitterIds.length ? "custom" : "simple" }, extra));
        wb.link(loader, store, "ai_document");
        for (const sId of splitterIds) {
          const sn = g.nodes[sId], f = SPLITTERS[sn.data.name];
          if (f) { const s = f(inp(sn)); wb.link(wb.add(label(sn), LC + s.type, s.v, s.params), loader, "ai_textSplitter"); markDone(sn); }
        }
        return loader;
      };
      for (const dId of docs) {
        const dn = g.nodes[dId];
        const di = inp(dn);
        const dname = dn.data.name;
        const splitters = ins(dId, "textSplitter");
        markDone(dn);
        if (dname === "documentStore" || dname === "documentStoreVS") {
          const store = findStore(ctx, di.selectedStore);
          if (!store || !store.chunks.length) { note("manual", "docStore", { label: label(dn) }); continue; }
          const code = wb.add(store.name, NB + "code", 2, { jsCode: "return " + JSON.stringify(store.chunks.map((c) => ({ json: { text: c.text } })), null, 1) + ";" });
          wb.link(lastMain, code);
          lastMain = code;
          addLoader("json", { jsonMode: "expressionData", jsonData: "={{ $json.text }}" }, splitters);
          note("ok", "docStoreChunks", { label: store.name, n: store.chunks.length, name: wb.name });
          sources++;
          continue;
        }
        if (dname === "github") {
          const gl = wb.add(label(dn), LC + "documentGithubLoader", 1.1, clean({ repository: str(di.repoLink), branch: str(di.branch) || "main", options: clean({ recursive: bool(di.recursive), ignorePaths: str(di.ignorePath) || undefined }) }));
          wb.link(gl, store, "ai_document");
          for (const sId of splitters) {
            const sn = g.nodes[sId], f = SPLITTERS[sn.data.name];
            if (f) { const s = f(inp(sn)); wb.link(wb.add(label(sn), LC + s.type, s.v, s.params), gl, "ai_textSplitter"); markDone(sn); }
          }
          addCred("GitHub", gl.name);
          sources++;
          continue;
        }
        if (/WebScraper|cheerio|puppeteer|playwright|apify|spider|firecrawl/i.test(dname)) {
          const url = str(di.url);
          const http = wb.add(label(dn), NB + "httpRequest", 4.2, { url, options: { response: { response: { responseFormat: "text" } } } });
          wb.link(lastMain, http);
          lastMain = http;
          addLoader("json", { jsonMode: "expressionData", jsonData: "={{ $json.data }}" }, splitters);
          note("adjust", "webLoader", { label: label(dn), url });
          sources++;
          continue;
        }
        if (dname === "plainText") {
          const code = wb.add(label(dn), NB + "code", 2, { jsCode: `return [{ json: { text: ${JSON.stringify(str(di.text))} } }];` });
          wb.link(lastMain, code);
          lastMain = code;
          addLoader("json", { jsonMode: "expressionData", jsonData: "={{ $json.text }}" }, splitters);
          sources++;
          continue;
        }
        // File loaders: content may be inline as data URIs ("data:...;base64,...,filename:x.txt")
        const fileField = Object.keys(di).find((k) => /File$|^file$/i.test(k) && typeof di[k] === "string" && di[k]);
        const raw = fileField ? di[fileField] : (Object.values(dn.data.inputs || {}).find((v) => typeof v === "string" && /^data:|^\[?"data:/.test(v)) || "");
        const inline = [];
        for (const part of str(raw).replace(/^\[|\]$/g, "").split(/","|",\s*"/)) {
          const m = /data:([^;]+);base64,([A-Za-z0-9+/=]+),filename:(.+?)"?$/.exec(part.replace(/^"/, ""));
          if (m) inline.push({ mime: m[1], b64: m[2], file: m[3] });
        }
        if (inline.length && inline.every((f) => /text|json|csv|markdown|xml|html/.test(f.mime))) {
          const decoded = inline.map((f) => ({ file: f.file, text: decodeB64(f.b64) }));
          const code = wb.add(label(dn), NB + "code", 2, { jsCode: `return ${JSON.stringify(decoded.map((d) => ({ json: { text: d.text, file: d.file } })), null, 1)};` });
          wb.link(lastMain, code);
          lastMain = code;
          addLoader("json", { jsonMode: "expressionData", jsonData: "={{ $json.text }}" }, splitters);
          note("ok", "fileInline", { label: label(dn), file: decoded.map((d) => d.file).join(", ") });
        } else {
          addLoader("binary", { binaryMode: "allInputData", loader: "auto" }, splitters);
          note("adjust", "fileReupload", { label: label(dn) });
        }
        sources++;
      }
      if (!sources) return;
      wb.link(lastMain, store);
      extraWorkflows.push(wb);
      note("ok", "ingestBuilt", { name: wb.name });
    }

    function buildRetriever(id, parent) {
      const vs = buildVectorStore(id, "retrieve");
      if (!vs) return;
      const r = b.add("Vector Store Retriever", LC + "retrieverVectorStore", 1, clean({ topK: num(inp(g.nodes[id]).topK) || 4 }));
      b.link(vs, r, "ai_vectorStore");
      b.link(r, parent, "ai_retriever");
    }

    // ---- tools
    function buildTool(id, agent) {
      const n = g.nodes[id];
      const name = n.data.name;
      const i = inp(n);
      markDone(n);
      if (name === "calculator") return b.link(b.add("Calculator", LC + "toolCalculator", 1, {}), agent, "ai_tool");
      if (name === "serpAPI") { const t = b.add("SerpAPI", LC + "toolSerpApi", 1, { options: {} }); addCred("SerpAPI", t.name); return b.link(t, agent, "ai_tool"); }
      if (name === "wikipedia" || name === "wikipediaTool") return b.link(b.add("Wikipedia", LC + "toolWikipedia", 1, {}), agent, "ai_tool");
      if (name === "retrieverTool") {
        const toolName = slug(i.name || "search_documents");
        for (const vsId of ins(id, "retriever")) {
          const vs = buildVectorStore(vsId, "retrieve-as-tool", { name: toolName, description: str(i.description) || "Search the knowledge base" });
          if (vs) b.link(vs, agent, "ai_tool");
        }
        return;
      }
      if (name === "customTool") return buildCustomTool(n, agent);
      if (name === "currentDateTime") return b.link(b.add("Current date and time", LC + "toolCode", 1.1, { name: "current_date_time", description: "Returns the current date and time", language: "javaScript", jsCode: "return new Date().toISOString();" }), agent, "ai_tool");
      const search = {
        googleCustomSearch: { url: "https://www.googleapis.com/customsearch/v1", q: "q", cred: "Google Custom Search (clave + cx como query)" },
        serper: { url: "https://google.serper.dev/search", q: "q", cred: "Header Auth X-API-KEY (Serper)", post: true },
        searchAPI: { url: "https://www.searchapi.io/api/v1/search", q: "q", cred: "Query Auth api_key (SearchAPI)" },
        braveSearchAPI: { url: "https://api.search.brave.com/res/v1/web/search", q: "q", cred: "Header Auth X-Subscription-Token (Brave)" },
        tavilyAPI: { url: "https://api.tavily.com/search", q: "query", cred: "Header Auth Authorization: Bearer (Tavily)", post: true },
        exaSearch: { url: "https://api.exa.ai/search", q: "query", cred: "Header Auth x-api-key (Exa)", post: true },
      }[name];
      if (search) {
        const p = { toolDescription: `Search the web with ${label(n)}. Input: the search query.`, method: search.post ? "POST" : "GET", url: search.url, authentication: "genericCredentialType", genericAuthType: /Query Auth/.test(search.cred) ? "httpQueryAuth" : "httpHeaderAuth", options: {} };
        if (search.post) Object.assign(p, { sendBody: true, specifyBody: "json", jsonBody: `={ "${search.q}": "{{ $fromAI('query', 'search query', 'string') }}" }` });
        else Object.assign(p, { sendQuery: true, queryParameters: { parameters: [{ name: search.q, value: "={{ $fromAI('query', 'search query', 'string') }}" }] } });
        const t = b.add(label(n), NB + "httpRequestTool", 4.2, p);
        note("adjust", "httpTool", { label: label(n), cred: search.cred });
        return b.link(t, agent, "ai_tool");
      }
      if (name === "requestsGet" || name === "requestsPost") {
        const post = name === "requestsPost";
        const p = { toolDescription: str(i.description) || `${post ? "POST" : "GET"} request to ${str(i.url) || "a URL"}`, method: post ? "POST" : "GET", url: str(i.url) || "={{ $fromAI('url', 'URL to call', 'string') }}", options: {} };
        if (post) Object.assign(p, { sendBody: true, specifyBody: "json", jsonBody: str(i.body) || "={{ $fromAI('body', 'JSON body', 'string') }}" });
        const t = b.add(label(n), NB + "httpRequestTool", 4.2, p);
        note("adjust", "httpTool", { label: label(n), cred: "—" });
        return b.link(t, agent, "ai_tool");
      }
      if (/MCP$/i.test(name) || name === "customMCP") {
        const cfg = parseJSON(i.mcpServerConfig, {}) || {};
        const url = str(cfg.url || i.url || i.endpoint);
        const t = b.add(label(n), LC + "mcpClientTool", 1.2, clean({ endpointUrl: url || "http://localhost:8000/mcp", serverTransport: /sse/i.test(url) ? "sse" : "httpStreamable", include: "all" }));
        if (!url) note("manual", "mcpStdio", { label: label(n) });
        return b.link(t, agent, "ai_tool");
      }
      if (name === "chatflowTool" || name === "agentflowTool") {
        const t = b.add(label(n), LC + "toolWorkflow", 2.1, { description: str(i.description) || str(i.name), workflowId: { __rl: true, mode: "list", value: "" } });
        note("manual", "executeFlow", { label: label(n) });
        return b.link(t, agent, "ai_tool");
      }
      note("manual", "unsupported", { label: label(n), name });
    }

    function buildCustomTool(n, agent) {
      const i = inp(n);
      const stored = ctx.tools[str(i.selectedTool)] || {};
      const toolName = slug(i.customToolName || stored.name || label(n));
      const desc = str(i.customToolDesc || stored.description) || toolName;
      const schemaArr = parseJSON(i.customToolSchema || stored.schema, []) || [];
      const func = str(i.customToolFunc || stored.func);
      const params = { name: toolName, description: desc, language: "javaScript" };
      if (!func) {
        params.jsCode = `// TODO: pegar acá el código de la herramienta "${toolName}" de Flowise\nreturn "sin implementar";`;
        const node = b.add(toolName, LC + "toolCode", 1.1, params);
        note("manual", "customToolMissing", { label: label(n), node: node.name });
        return b.link(node, agent, "ai_tool");
      }
      const props = {}, required = [];
      for (const p of schemaArr) {
        if (!p || !p.property) continue;
        const ty = { number: "number", boolean: "boolean", date: "string", string: "string" }[str(p.type).toLowerCase()] || "string";
        props[p.property] = { type: ty, description: str(p.description) };
        if (p.required) required.push(p.property);
      }
      const names = Object.keys(props);
      let pre = "";
      if (names.length) pre += `const __in = typeof query === "string" ? (() => { try { return JSON.parse(query); } catch (e) { return { input: query }; } })() : (query || {});\n` + names.map((p) => `const $${p} = __in[${JSON.stringify(p)}];`).join("\n") + "\n";
      else pre += "const $input = query;\n";
      if (/\$flow\b/.test(func)) { pre += "const $flow = { sessionId: '', chatId: '', input: typeof query === 'string' ? query : JSON.stringify(query) };\n"; note("adjust", "flowVar"); }
      if (/\$vars\b/.test(func)) note("adjust", "vars");
      // node-fetch / axios are not allowed in n8n's sandbox: use the built-in fetch instead
      let body = func.replace(/^\s*(const|let|var)\s+fetch\s*=\s*require\(\s*['"]node-fetch['"]\s*\)\s*;?\s*$/gm, "// (fetch: n8n ya lo trae)")
        .replace(/^\s*import\s+fetch\s+from\s+['"]node-fetch['"]\s*;?\s*$/gm, "// (fetch: n8n ya lo trae)");
      body = body.replace(/^\s*(const|let|var)\s+axios\s*=\s*require\(\s*['"]axios['"]\s*\)\s*;?\s*$/gm,
        "// axios → fetch\nconst axios = { get: async (u, c) => { const r = await fetch(u, c); return { data: await r.json().catch(() => null), status: r.status }; }, post: async (u, d, c) => { const r = await fetch(u, Object.assign({}, c, { method: 'POST', body: JSON.stringify(d), headers: Object.assign({ 'Content-Type': 'application/json' }, (c || {}).headers) })); return { data: await r.json().catch(() => null), status: r.status }; } };");
      if (/require\(/.test(body)) note("adjust", "requireOther", { name: toolName });
      // n8n's code sandbox has no global fetch: build one on top of this.helpers.httpRequest
      if (/\bfetch\s*\(|axios\./.test(body)) pre += "const fetch = async (url, opts = {}) => {\n  const res = await this.helpers.httpRequest({ url: String(url), method: opts.method || 'GET', headers: opts.headers, body: opts.body, returnFullResponse: true, ignoreHttpStatusErrors: true, encoding: 'text', json: false });\n  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);\n  return { ok: res.statusCode < 400, status: res.statusCode, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) };\n};\n";
      params.jsCode = `${pre}// ---- código original de Flowise ----\nreturn await (async () => {\n${body}\n})();`;
      if (names.length) Object.assign(params, { specifyInputSchema: true, schemaType: "manual", inputSchema: JSON.stringify({ type: "object", properties: props, required }, null, 2) });
      const node = b.add(toolName, LC + "toolCode", 1.1, params);
      note("adjust", "customToolCode", { name: toolName });
      return b.link(node, agent, "ai_tool");
    }

    function buildOutputParser(id, parent) {
      const n = g.nodes[id];
      const name = n.data.name;
      const i = inp(n);
      markDone(n);
      if (name === "listOutputParser" || name === "csvOutputParser") {
        b.link(b.add(label(n), LC + "outputParserItemList", 1, { options: clean({ separator: name === "csvOutputParser" ? "," : undefined }) }), parent, "ai_outputParser");
        return true;
      }
      let schema = null;
      if (name === "structuredOutputParser") {
        const rows = parseJSON(i.jsonStructure, []) || [];
        const props = {};
        for (const r of rows) if (r && r.property) props[r.property] = { type: { number: "number", boolean: "boolean" }[str(r.type).toLowerCase()] || "string", description: str(r.description) };
        schema = { type: "object", properties: props, required: Object.keys(props) };
      } else if (name === "advancedStructuredOutputParser") {
        try { schema = zodToJsonSchema(i.exampleJson); note("ok", "zodParsed"); } catch (e) { schema = { type: "object", properties: {} }; note("adjust", "zodFailed"); }
      } else { note("manual", "unsupported", { label: label(n), name }); return false; }
      if (bool(i.autofixParser)) note("adjust", "autofix");
      b.link(b.add(label(n), LC + "outputParserStructured", 1.2, { schemaType: "manual", inputSchema: JSON.stringify(schema, null, 2) }), parent, "ai_outputParser");
      return true;
    }

    function moderation(id) { for (const m of ins(id, "inputModeration")) { note("adjust", "moderation", { label: label(g.nodes[m]) }); markDone(g.nodes[m]); for (const x of ins(m, "model")) markDone(g.nodes[x]); } }

    function agentNode(n, systemMessage, extraOptions) {
      return b.add(label(n), LC + "agent", 2.2, { promptType: "auto", options: clean(Object.assign({ systemMessage: systemMessage || undefined }, extraOptions || {})) });
    }

    // ---- ending nodes
    function buildEnding(n, startFrom) {
      if (built[n.id]) return built[n.id];
      const name = n.data.name;
      const i = inp(n);
      const id = n.id;
      let upstream = startFrom;
      // A prompt value may point to another chain's output: build that chain first and run it before this one.
      const resolveRef = (refId) => {
        const rn = g.nodes[refId];
        if (!rn || !(ENDING_CATS.has(rn.data.category))) return null;
        const r = buildEnding(rn, upstream);
        if (!r) return null;
        upstream = r;
        return `$('${r.name}').item.json.${OUT_FIELD[r.type.replace(LC, "")] || "output"}`;
      };
      moderation(id);
      markDone(n);
      let root;
      const memories = () => ins(id, "memory").forEach((m) => buildMemory(m, root));
      if (name === "llmChain") {
        const promptId = ins(id, "prompt")[0];
        const params = { promptType: "auto" };
        const pn = promptId && g.nodes[promptId];
        if (pn) {
          markDone(pn);
          const pi = inp(pn);
          if (pn.data.name === "chatPromptTemplate") {
            const human = convertTemplate(pi.humanMessagePrompt || "{text}", pi.promptValues, chatInput, resolveRef);
            const sys = convertTemplate(pi.systemMessagePrompt, pi.promptValues, chatInput, resolveRef);
            if (human.text.trim() !== `{{ ${chatInput} }}` || upstream !== trigger) Object.assign(params, { promptType: "define", text: expr(human.text) });
            if (sys.text.trim()) params.messages = { messageValues: [{ type: "SystemMessagePromptTemplate", message: expr(sys.text) }] };
            const miss = human.missing.concat(sys.missing);
            if (miss.length) note("adjust", "promptVars", { vars: miss.join(", ") });
          } else {
            const t = convertTemplate(pi.template, pi.promptValues, chatInput, resolveRef);
            Object.assign(params, { promptType: "define", text: expr(t.text) });
            if (t.missing.length) note("adjust", "promptVars", { vars: t.missing.join(", ") });
          }
        }
        if (params.promptType === "auto" && upstream !== trigger) Object.assign(params, { promptType: "define", text: `={{ ${chatInput} }}` });
        root = b.add(label(n), LC + "chainLlm", 1.7, params);
        firstModel(ins(id, "model"), root);
        for (const p of ins(id, "outputParser")) if (buildOutputParser(p, root)) root.parameters.hasOutputParser = true;
      } else if (name === "conversationChain" || name === "simpleChatEngine") {
        let sys = str(i.systemMessagePrompt);
        const cpt = ins(id, "chatPromptTemplate")[0];
        if (cpt) { markDone(g.nodes[cpt]); sys = str(inp(g.nodes[cpt]).systemMessagePrompt) || sys; }
        root = agentNode(n, sys);
        firstModel(ins(id, "model"), root);
        memories();
        if (name === "simpleChatEngine") note("adjust", "llamaIndex", { label: label(n) });
      } else if (name === "conversationalRetrievalQAChain" || name === "contextChatEngine") {
        let sys = htmlToText(i.responsePrompt || i.systemMessagePrompt || "You are a helpful assistant. Answer using the documents found with the search tool.");
        sys = sys.replace(/\{context\}/g, "(los documentos que devuelve la herramienta search_documents)").replace(/\{question\}/g, "(la pregunta del usuario)").replace(/\{chat_history\}/g, "");
        sys += "\n\nAlways call the search_documents tool before answering a question about the documents.";
        root = agentNode(n, sys);
        firstModel(ins(id, "model"), root);
        memories();
        for (const v of ins(id, "vectorStoreRetriever")) { const vs = buildVectorStore(v, "retrieve-as-tool", { name: "search_documents", description: "Search the knowledge base documents. Input: the question rephrased as a standalone search query." }); if (vs) b.link(vs, root, "ai_tool"); }
        note("adjust", "crqa");
        if (i.rephrasePrompt) note("ok", "rephraseDropped");
        if (name === "contextChatEngine") note("adjust", "llamaIndex", { label: label(n) });
      } else if (name === "retrievalQAChain" || name === "vectorDBQAChain" || name === "queryEngine") {
        root = b.add(label(n), LC + "chainRetrievalQa", 1.6, { promptType: "auto", options: {} });
        let models = ins(id, "model");
        if (!models.length) for (const rs of ins(id, "responseSynthesizer")) { markDone(g.nodes[rs]); models = models.concat(ins(rs, "model")); }
        if (!models.length) for (const v of ins(id, "vectorStoreRetriever")) models = models.concat(ins(v, "model"));
        firstModel(models, root);
        for (const v of ins(id, "vectorStoreRetriever").concat(ins(id, "vectorStore"))) buildRetriever(v, root);
        if (name === "queryEngine") note("adjust", "llamaIndex", { label: label(n) });
      } else if (name === "multiRetrievalQAChain" || name === "subQuestionQueryEngine") {
        root = agentNode(n, "Answer using the search tools. Pick the tool whose description matches the question.");
        firstModel(ins(id, "model"), root);
        memories();
        const sources = ins(id, "vectorStoreRetriever").concat(ins(id, "queryEngineTools"));
        let k = 0;
        for (const v of sources) {
          const vn = g.nodes[v];
          const desc = str(inp(vn).description || inp(vn).toolDesc || label(vn));
          const targets = vn.data.name === "queryEngineToolLlamaIndex" ? ins(v, "baseQueryEngine").flatMap((q) => ins(q, "vectorStoreRetriever")) : [v];
          if (vn.data.name === "queryEngineToolLlamaIndex") { markDone(vn); for (const q of ins(v, "baseQueryEngine")) markDone(g.nodes[q]); }
          for (const tId of targets) { const vs = buildVectorStore(tId, "retrieve-as-tool", { name: slug(inp(vn).toolName || inp(vn).name || `search_${++k}`), description: desc }); if (vs) b.link(vs, root, "ai_tool"); }
        }
        if (name === "subQuestionQueryEngine") note("adjust", "subQuestion");
      } else if (["toolAgent", "openAIToolAgent", "openAIFunctionAgent", "conversationalAgent", "reactAgentChat", "reactAgentLLM", "mistralAIToolAgent", "conversationalRetrievalToolAgent", "conversationalRetrievalAgent", "xmlAgent", "anthropicAgent", "openAIAssistant", "csvAgent", "airtableAgent", "sqlDatabaseChain", "autoGPT", "babyAGI"].includes(name)) {
        let sys = htmlToText(i.systemMessage || i.systemMessagePrompt || "");
        if (name === "openAIAssistant") note("adjust", "assistant");
        if (name === "sqlDatabaseChain") note("manual", "sql");
        if (["csvAgent", "airtableAgent", "autoGPT", "babyAGI"].includes(name)) note("manual", "v2Approx", { label: label(n), name, how: "Agente de IA sin las herramientas especiales de Flowise" });
        root = agentNode(n, sys, { maxIterations: num(i.maxIterations) });
        let models = ins(id, "model");
        if (name === "openAIAssistant" && !models.length) {
          const m = b.add("OpenAI Chat Model", LC + "lmChatOpenAi", 1.2, { model: rl("gpt-4o"), options: {} });
          addCred("OpenAI", m.name);
          b.link(m, root, "ai_languageModel");
        } else firstModel(models, root);
        memories();
        for (const t of ins(id, "tools")) buildTool(t, root);
      } else if (name === "supervisor") {
        root = agentNode(n, htmlToText(i.supervisorPrompt).replace(/\{team_members\}/g, "the tools available to you"), {});
        note("adjust", "supervisor");
        firstModel(ins(id, "model"), root);
        for (const [wid, wn] of Object.entries(g.nodes)) {
          if (wn.data.name !== "worker" || !ins(wid, "supervisor").includes(id)) continue;
          markDone(wn);
          const wi = inp(wn);
          const prompt = convertTemplate(wi.workerPrompt, wi.promptValues, "$json.chatInput").text;
          const tool = b.add(str(wi.workerName) || label(wn), LC + "agentTool", 2.2, { toolDescription: `Worker: ${str(wi.workerName)}. ${prompt.slice(0, 200)}`, text: "={{ $fromAI('task', 'the task for this worker', 'string') }}", options: clean({ systemMessage: prompt, maxIterations: num(wi.maxIterations) }) });
          b.link(tool, root, "ai_tool");
          const wm = ins(wid, "model");
          if (wm.length) firstModel(wm, tool);
          else firstModel(ins(id, "model"), tool);
          for (const t of ins(wid, "tools")) buildTool(t, tool);
        }
      } else {
        note("manual", "unsupported", { label: label(n), name });
        return null;
      }
      if (upstream) b.link(upstream, root);
      built[id] = root;
      return root;
    }

    // ---- find ending nodes (chains/agents nobody consumes)
    const consumed = new Set(Object.keys(g.outgoing).filter((k) => g.outgoing[k].length));
    let endings = real.filter((n) => !consumed.has(n.id) && (ENDING_CATS.has(n.data.category) || n.data.name === "supervisor"));
    if (flow.kind === "multiagent") endings = real.filter((n) => n.data.name === "supervisor");
    if (flow.kind === "sequential") note("manual", "seqAgents");
    const trigger = b.add("When chat message received", LC + "chatTrigger", 1.1, { options: {} }, { webhookId: newId() });
    ctx.trigger = trigger;
    if (!endings.length && flow.kind !== "sequential") note("manual", "noEnding");
    if (endings.length > 1) note("adjust", "multiEnding", { n: endings.length });
    if (flow.kind !== "sequential") for (const e of endings) buildEnding(e, trigger);
    if (ins(endings[0] && endings[0].id, "memory").length) note("ok", "sessionId");

    // sticky notes
    for (const n of flow.nodes) if (n.data && /stickyNote/.test(n.data.name)) b.add(ctx.t.note, NB + "stickyNote", 1, { content: htmlToText(inp(n).note), height: 240, width: 300 });
    // leftovers
    for (const n of real) {
      if (done.has(n.id)) continue;
      const nm = n.data.name;
      if (/Moderation/i.test(nm)) note("adjust", "moderation", { label: label(n) });
      else if (/Cache/i.test(nm)) note("adjust", "cache", { label: label(n) });
      else if (flow.kind !== "sequential") note("manual", "unknownNode", { label: label(n), name: nm });
    }
    for (const { cred, node } of creds.values()) note("adjust", "credential", { cred, node });
    for (const wb of extraWorkflows) for (const nn of wb.nodes) {
      const credFor = (nn.type.includes("vectorStore") && !nn.type.includes("InMemory")) || nn.type.includes("embeddings") || nn.type.includes("Github");
      if (credFor) report.push({ level: "adjust", key: "credential", args: { cred: credLabel(nn.type), node: `${wb.name} › ${nn.name}` } });
    }
    const coverage = total ? Math.min(1, mapped / total) : 1;
    return { builders: [b].concat(extraWorkflows), report, coverage, creds: [...creds.values()] };
  }

  function credLabel(type) {
    const t = type.replace(LC, "");
    for (const tab of [VSTORES, EMBEDDINGS]) for (const v of Object.values(tab)) {
      const d = typeof v === "function" ? v({}) : v;
      if (d.type === t) return d.cred;
    }
    if (/Github/.test(t)) return "GitHub";
    return t;
  }

  function decodeB64(b64) {
    try {
      if (typeof atob === "function") {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        return new TextDecoder("utf-8").decode(bytes);
      }
      return Buffer.from(b64, "base64").toString("utf8");
    } catch (e) { return ""; }
  }

  // ------------------------------------------------------------------ public API

  function convert(files, opts) {
    opts = opts || {};
    const lang = opts.lang === "en" ? "en" : "es";
    const { flows, tools, docStores } = readFlows(files);
    const ctx = { tools, docStores, t: MSG[lang], storeIngests: {} };
    const workflows = [];
    const usedNames = new Set();
    for (const flow of flows) {
      let res;
      if (flow.kind === "agentflowv2") res = convertAgentflowV2 ? convertAgentflowV2(flow, ctx) : null;
      else res = convertChatflow(flow, ctx);
      if (!res) continue;
      res.builders.forEach((bld, k) => {
        let fileName = slug(bld.name) + ".n8n.json";
        for (let j = 2; usedNames.has(fileName); j++) fileName = slug(bld.name) + "_" + j + ".n8n.json";
        usedNames.add(fileName);
        workflows.push({ name: bld.name, fileName, n8n: bld.json(), report: k === 0 ? res.report : [], coverage: res.coverage, flowName: flow.name, kind: flow.kind, primary: k === 0 });
      });
    }
    const primaries = workflows.filter((w) => w.primary);
    const summary = {
      flows: flows.length,
      count: workflows.length,
      coverage: primaries.length ? primaries.reduce((s, w) => s + w.coverage, 0) / primaries.length : 0,
      fullyAutomatic: primaries.filter((w) => !w.report.some((r) => r.level === "manual")).length,
      kinds: flows.reduce((m, f) => ((m[f.kind] = (m[f.kind] || 0) + 1), m), {}),
    };
    return { workflows, summary, reportMarkdown: (l) => reportMarkdown(workflows, summary, l || lang), noteText };
  }

  function noteText(r, lang) {
    const f = NOTE[r.key];
    return f ? f[lang === "en" ? "en" : "es"](r.args || {}) : r.key;
  }

  function reportMarkdown(workflows, summary, lang) {
    const t = MSG[lang === "en" ? "en" : "es"];
    const out = [`# ${t.title}`, "", t.intro, ""];
    for (const w of workflows.filter((x) => x.primary)) {
      const related = workflows.filter((x) => x.flowName === w.flowName).map((x) => `\`${x.fileName}\``).join(", ");
      out.push(`## ${w.flowName}`, "", `${t.coverage}: ${Math.round(w.coverage * 100)}% · ${t.generated}: ${related}`, "");
      const levels = [["manual", t.manual], ["adjust", t.adjust], ["ok", t.ok]];
      let any = false;
      for (const [lv, lvName] of levels) {
        const items = w.report.filter((r) => r.level === lv && r.key !== "credential");
        if (!items.length) continue;
        any = true;
        out.push(`**${lvName}**`, "");
        for (const r of items) out.push(`- ${noteText(r, lang)}`);
        out.push("");
      }
      const creds = w.report.filter((r) => r.key === "credential");
      if (creds.length) {
        out.push(`**${t.creds}**`, "");
        for (const r of creds) out.push(`- ${noteText(r, lang)}`);
        out.push("");
      }
      if (!any && !creds.length) out.push(t.none, "");
    }
    return out.join("\n");
  }

  // Agentflow v2 conversion is attached below (kept separate for readability).
  let convertAgentflowV2 = null;
  const api = { convert, readFlows, zodToJsonSchema, _internal: { findStore, storeRetrieval, Builder, MODELS, EMBEDDINGS, VSTORES, MEMORIES, SPLITTERS, htmlToText, convertTemplate, clean, num, str, bool, slug, rl, parseJSON, newId, NOTE, MSG, LC, NB } };
  api.registerAgentflowV2 = (fn) => { convertAgentflowV2 = fn; };
  return api;
});
