/*
 * OpenAI Agent Builder (Agents SDK code export, Python or TypeScript) → n8n workflows.
 * Runs in the browser (window.abmigra, needs window.abparse) and in Node (require).
 * Secrets that people sometimes leave in exported code (MCP authorization, API keys) are never copied into the output.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./agentbuilder-parse.js"));
  else root.abmigra = factory(root.abparse);
})(typeof self !== "undefined" ? self : this, function (P) {
  "use strict";

  const LC = "@n8n/n8n-nodes-langchain.";
  const NB = "n8n-nodes-base.";
  const TRIGGER = "When chat message received";
  const STATE = "Workflow state";
  let uid = 0;
  const newId = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    uid += 1;
    return "00000000-0000-4000-8000-" + String(uid).padStart(12, "0");
  };
  const str = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : String(v));
  const num = (v) => { if (v === "" || v === undefined || v === null || typeof v === "boolean") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  function clean(o) { const out = {}; for (const [k, v] of Object.entries(o || {})) { if (v === undefined || v === null || v === "") continue; if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue; out[k] = v; } return out; }
  const slug = (s) => str(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "workflow";
  const PII_N8N = new Set(["CREDIT_CARD", "CRYPTO", "DATE_TIME", "EMAIL_ADDRESS", "IBAN_CODE", "IP_ADDRESS", "LOCATION", "PHONE_NUMBER", "MEDICAL_LICENSE", "US_BANK_NUMBER", "US_DRIVER_LICENSE", "US_ITIN", "US_PASSPORT", "US_SSN", "UK_NHS", "UK_NINO", "ES_NIF", "ES_NIE", "IT_FISCAL_CODE", "IT_DRIVER_LICENSE", "IT_VAT_CODE", "IT_PASSPORT", "IT_IDENTITY_CARD", "PL_PESEL", "SG_NRIC_FIN", "SG_UEN", "AU_ABN", "AU_ACN", "AU_TFN", "AU_MEDICARE", "IN_PAN", "IN_AADHAAR", "IN_VEHICLE_REGISTRATION", "IN_VOTER", "IN_PASSPORT", "FI_PERSONAL_IDENTITY_CODE"]);
  const camelToSnake = (s) => str(s).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

  // ------------------------------------------------------------------ messages
  const MSG = {
    es: { title: "Informe de conversión Agent Builder → n8n", intro: "Cada export de código del Agent Builder (Agents SDK) se convirtió en un flujo de n8n listo para importar (Workflows → Import from File). Abajo, lo hecho y lo que falta revisar.", creds: "Credenciales para crear en n8n", ok: "Hecho", adjust: "Revisar", manual: "A mano", coverage: "Cobertura", none: "Nada pendiente.", note: "Nota" },
    en: { title: "Agent Builder → n8n conversion report", intro: "Each Agent Builder code export (Agents SDK) was converted into an n8n workflow ready to import (Workflows → Import from File). Below is what was done and what still needs a look.", creds: "Credentials to create in n8n", ok: "Done", adjust: "Review", manual: "Manual", coverage: "Coverage", none: "Nothing pending.", note: "Note" },
  };
  const NOTE = {
    credential: { es: (a) => `Crear credencial "${a.cred}" y elegirla en "${a.node}".`, en: (a) => `Create a "${a.cred}" credential and select it in "${a.node}".` },
    agents: { es: (a) => `${a.n} agentes pasaron a nodos AI Agent con su modelo, instrucciones y herramientas.`, en: (a) => `${a.n} agents became AI Agent nodes with their model, instructions and tools.` },
    builtin: { es: (a) => `"${a.agent}": ${a.tools} quedaron como herramientas integradas del modelo de OpenAI (Responses API). Los vector stores siguen en tu cuenta de OpenAI: usá la misma API key o proyecto.`, en: (a) => `"${a.agent}": ${a.tools} became built-in tools of the OpenAI model (Responses API). Vector stores stay in your OpenAI account: use the same API key or project.` },
    mcp: { es: (a) => `Servidor MCP "${a.label}" → nodo MCP Client Tool (${a.url}).`, en: (a) => `MCP server "${a.label}" → MCP Client Tool node (${a.url}).` },
    mcpSecret: { es: (a) => `El export traía la autorización del servidor MCP "${a.label}" escrita en el código. No se copió: cargala como credencial Bearer en n8n y rotá ese token si el código estuvo publicado.`, en: (a) => `The export had the authorization for MCP server "${a.label}" written in the code. It was not copied: add it as a Bearer credential in n8n, and rotate that token if the code was ever public.` },
    connector: { es: (a) => `"${a.label}" usa un conector de OpenAI (${a.id}). En n8n agregá el nodo de esa app como herramienta del agente (por ejemplo Gmail Tool o Google Drive Tool).`, en: (a) => `"${a.label}" uses an OpenAI connector (${a.id}). In n8n add that app's node as an agent tool (for example Gmail Tool or Google Drive Tool).` },
    fnStub: { es: (a) => `La herramienta "${a.name}" era una función del lado del cliente sin implementar en el export. Quedó un Code Tool con su esquema: escribí qué hace.`, en: (a) => `Tool "${a.name}" was a client-side function with no implementation in the export. A Code Tool with its schema was created: write what it does.` },
    fnCode: { es: (a) => `La herramienta "${a.name}" pasó a un Code Tool con su código JavaScript; probala con un mensaje real.`, en: (a) => `Tool "${a.name}" moved to a Code Tool with its JavaScript code; test it with a real message.` },
    fnPython: { es: (a) => `La herramienta "${a.name}" tenía código Python; quedó copiado como comentario en un Code Tool para pasarlo a JavaScript (o usá Python en n8n propio).`, en: (a) => `Tool "${a.name}" had Python code; it was copied as a comment into a Code Tool so you can port it to JavaScript (or use Python on self-hosted n8n).` },
    imageGen: { es: (a) => `"${a.agent}" generaba imágenes; en n8n usá el nodo OpenAI → Generate an Image como herramienta.`, en: (a) => `"${a.agent}" generated images; in n8n use the OpenAI → Generate an Image node as a tool.` },
    guardrails: { es: (a) => `Guardrails (${a.list}) → nodo Guardrails de n8n: salida 0 = pasa, salida 1 = bloqueado.`, en: (a) => `Guardrails (${a.list}) → n8n Guardrails node: output 0 = pass, output 1 = blocked.` },
    guardMissing: { es: (a) => `Guardrails sin equivalente directo en n8n: ${a.list}. Agregá un chequeo "Custom" en el nodo Guardrails si los necesitás.`, en: (a) => `Guardrails without a direct n8n equivalent: ${a.list}. Add a "Custom" check in the Guardrails node if you need them.` },
    piiMask: { es: () => "En el Agent Builder la PII se enmascaraba sin bloquear; en n8n el nodo la detecta y bloquea. Para enmascarar, agregá otro nodo Guardrails en modo Sanitize.", en: () => "In Agent Builder PII was masked without blocking; in n8n the node detects and blocks it. To mask instead, add another Guardrails node in Sanitize mode." },
    branch: { es: (a) => `La condición if/else de la línea ${a.line} pasó a un nodo Switch (${a.n} salidas).`, en: (a) => `The if/else at line ${a.line} became a Switch node (${a.n} outputs).` },
    condRaw: { es: (a) => `No pude traducir la condición de la línea ${a.line} (${a.src}); revisala en el Switch.`, en: (a) => `Could not translate the condition at line ${a.line} (${a.src}); check it in the Switch.` },
    exprRaw: { es: (a) => `Expresión sin traducir en "${a.node}": ${a.src}.`, en: (a) => `Untranslated expression in "${a.node}": ${a.src}.` },
    loop: { es: (a) => `El bucle while de la línea ${a.line} pasó a un nodo If que vuelve atrás; revisá que la condición termine.`, en: (a) => `The while loop at line ${a.line} became an If node that loops back; check that the condition ends.` },
    forLoop: { es: (a) => `El bucle for de la línea ${a.line} no se convirtió: su contenido corre una vez. Revisalo.`, en: (a) => `The for loop at line ${a.line} was not converted: its body runs once. Check it.` },
    approval: { es: () => "La aprobación humana pasó a un nodo Wait con formulario (Approve/Reject).", en: () => "Human approval became a Wait node with a form (Approve/Reject)." },
    fileSearchNode: { es: () => "La búsqueda en vector store pasó a un HTTP Request a la API de OpenAI con tu credencial.", en: () => "The vector store search became an HTTP Request to the OpenAI API with your credential." },
    end: { es: () => "Cada \"return\" pasó a un nodo Set con el campo output (lo que muestra el chat).", en: () => "Each \"return\" became a Set node with the output field (what the chat shows)." },
    noWorkflow: { es: () => "No encontré la función run_workflow / runWorkflow; se crearon los agentes sin conectar.", en: () => "No run_workflow / runWorkflow function found; agents were created unconnected." },
    unknownStmt: { es: (a) => `Línea ${a.line}: no se convirtió (${a.src}).`, en: (a) => `Line ${a.line}: not converted (${a.src}).` },
    memory: { es: () => "Los agentes que compartían el historial de la conversación comparten una memoria por sesión de chat.", en: () => "Agents that shared the conversation history share one memory per chat session." },
    state: { es: () => "El estado del flujo (state) se arma en un nodo Set al inicio; los cambios se leen del nodo que los produce.", en: () => "Flow state is set up in a Set node at the start; changes are read from the node that produces them." },
    toolMissing: { es: (a) => `La herramienta "${a.name}" de "${a.agent}" no se pudo leer del export; agregala a mano en n8n.`, en: (a) => `Tool "${a.name}" of "${a.agent}" could not be read from the export; add it by hand in n8n.` },
    unusedAgent: { es: (a) => `El agente "${a.name}" está definido pero no se usa en el flujo; quedó suelto.`, en: (a) => `Agent "${a.name}" is defined but not used in the flow; left unconnected.` },
  };

  // ------------------------------------------------------------------ builder (same layout logic as the Flowise converter)
  class Builder {
    constructor(name) { this.name = name; this.nodes = []; this.conns = {}; this.names = new Set(); }
    uniq(n) { let name = str(n).replace(/[\r\n]+/g, " ").trim().slice(0, 80) || "Node"; if (!this.names.has(name)) { this.names.add(name); return name; } for (let i = 2; ; i++) if (!this.names.has(`${name} ${i}`)) { this.names.add(`${name} ${i}`); return `${name} ${i}`; } }
    add(name, type, typeVersion, parameters, extra) { const node = Object.assign({ parameters: parameters || {}, type, typeVersion, position: [0, 0], id: newId(), name: this.uniq(name) }, extra || {}); this.nodes.push(node); return node; }
    link(from, to, type, outIndex, inIndex) {
      type = type || "main";
      const byType = (this.conns[from.name] = this.conns[from.name] || {});
      const outs = (byType[type] = byType[type] || []);
      const oi = outIndex || 0;
      while (outs.length <= oi) outs.push([]);
      if (!outs[oi].some((c) => c.node === to.name && c.index === (inIndex || 0))) outs[oi].push({ node: to.name, type, index: inIndex || 0 });
    }
    layout() {
      const byName = Object.fromEntries(this.nodes.map((n) => [n.name, n]));
      const children = {}, mainNext = {}, hasMainIn = new Set();
      for (const [src, types] of Object.entries(this.conns)) for (const [type, outs] of Object.entries(types)) outs.forEach((out, oi) => out.forEach((c) => {
        if (type === "main") { (mainNext[src] = mainNext[src] || []).push(c.node); hasMainIn.add(c.node); } else (children[c.node] = children[c.node] || []).push(src);
      }));
      const placed = new Set();
      const width = (n, seen) => { seen = seen || new Set(); if (seen.has(n)) return 1; seen.add(n); const ch = (children[n] || []).filter((c) => !placed.has(c)); return Math.max(1, ch.reduce((s, c) => s + width(c, seen), 0)); };
      const placeSub = (n, x, y) => { const ch = (children[n] || []).filter((c) => !placed.has(c)); let cx = x - ((width(n) - 1) * 180) / 2; for (const c of ch) { const w = width(c); const px = cx + ((w - 1) * 180) / 2; placed.add(c); byName[c].position = [Math.round(px), y]; placeSub(c, px, y + 200); cx += w * 180; } };
      let x = 0;
      const rowOf = {};
      const placeMain = (n, y) => { if (placed.has(n)) return; placed.add(n); byName[n].position = [x, y]; placeSub(n, x + 40, y + 220); x += Math.max(280, width(n) * 180); (mainNext[n] || []).forEach((m, i) => placeMain(m, y + i * 420)); };
      for (const r of this.nodes.filter((n) => !hasMainIn.has(n.name) && !Object.values(children).some((cs) => cs.includes(n.name)) && n.type !== NB + "stickyNote")) placeMain(r.name, 0);
      let sx = 0;
      for (const n of this.nodes) if (!placed.has(n.name)) { if (n.type === NB + "stickyNote") { n.position = [sx, -420]; sx += 320; } else { n.position = [x, 600]; x += 220; } }
    }
    json() { this.layout(); return { name: this.name, nodes: this.nodes, connections: this.conns, pinData: {}, settings: { executionOrder: "v1" }, active: false, meta: { templateCredsSetupCompleted: false, convertedFrom: "openai-agent-builder", converter: "MigrateFlows" } }; }
  }

  // ------------------------------------------------------------------ helpers over the AST
  const lit = P.lit, loose = P.loose;
  const nameOf = P.nameOf;
  function callName(a) { while (a && a.t === "un") a = a.x; return a && a.t === "call" ? nameOf(a.fn) : ""; }
  function unawait(a) { return a; }
  // kwargs of a Python call or the first object argument of a TS call → { key: AST }
  function kw(call) {
    if (!call || call.t !== "call") return {};
    if (call.kwargs && Object.keys(call.kwargs).length) return call.kwargs;
    const obj = call.args && call.args.find((x) => x && x.t === "dict");
    if (!obj) return {};
    const out = {};
    for (const e of obj.entries) if (e.k) { const k = lit(e.k); if (k !== undefined) out[String(k)] = e.v; }
    return out;
  }
  const K = (o, ...names) => { for (const n of names) if (o[n] !== undefined) return o[n]; return undefined; };

  // pydantic class body / zod object → JSON Schema
  function pyTypeToSchema(t, classes, depth) {
    t = str(t).replace(/\s+/g, "");
    depth = depth || 0;
    let m;
    if ((m = /^Optional\[(.+)\]$/.exec(t))) return pyTypeToSchema(m[1], classes, depth);
    if ((m = /^(.+)\|None$/.exec(t))) return pyTypeToSchema(m[1], classes, depth);
    if ((m = /^(?:list|List|Sequence)\[(.+)\]$/.exec(t))) return { type: "array", items: pyTypeToSchema(m[1], classes, depth) };
    if ((m = /^Literal\[(.+)\]$/.exec(t))) return { type: "string", enum: m[1].split(",").map((x) => x.replace(/^["']|["']$/g, "")) };
    if (/^(dict|Dict)/.test(t)) return { type: "object" };
    if (t === "str") return { type: "string" };
    if (t === "int") return { type: "integer" };
    if (t === "float") return { type: "number" };
    if (t === "bool") return { type: "boolean" };
    if (classes[t] && depth < 6) return classSchema(classes[t], classes, depth + 1);
    return { type: "string" };
  }
  function classSchema(cls, classes, depth) {
    const props = {}, req = [];
    for (const s of cls.body || []) {
      if (s.s === "ann") { props[s.name] = pyTypeToSchema(s.type, classes, depth || 0); req.push(s.name); }
      else if (s.s === "assign" && s.target && s.target.t === "name") props[s.target.id] = props[s.target.id] || { type: "string" };
    }
    return { type: "object", properties: props, required: req };
  }
  function zodToSchema(a, schemas, depth) {
    depth = depth || 0;
    if (!a || depth > 8) return { type: "string" };
    if (a.t === "name" && schemas[a.id]) return schemas[a.id];
    if (a.t !== "call") return { type: "string" };
    const fn = nameOf(a.fn);
    const base = a.fn.t === "attr" ? a.fn.obj : null;
    const method = a.fn.t === "attr" ? a.fn.name : fn;
    if (/^z\.object$/.test(fn) || method === "object" && base && nameOf(base) === "z") {
      const props = {}, req = [];
      const obj = a.args[0];
      if (obj && obj.t === "dict") for (const e of obj.entries) if (e.k) { const k = String(lit(e.k)); const s = zodToSchema(e.v, schemas, depth + 1); props[k] = s; if (!s.__optional) req.push(k); delete s.__optional; }
      return { type: "object", properties: props, required: req };
    }
    if (fn === "z.string") return { type: "string" };
    if (fn === "z.number") return { type: "number" };
    if (fn === "z.boolean") return { type: "boolean" };
    if (fn === "z.any" || fn === "z.unknown") return {};
    if (fn === "z.enum") return { type: "string", enum: lit(a.args[0]) || [] };
    if (fn === "z.literal") return { const: lit(a.args[0]) };
    if (fn === "z.array") return { type: "array", items: zodToSchema(a.args[0], schemas, depth + 1) };
    if (fn === "z.record") return { type: "object" };
    if (fn === "z.union") return { anyOf: ((a.args[0] && a.args[0].items) || []).map((x) => zodToSchema(x, schemas, depth + 1)) };
    // chained modifiers: X.optional(), X.nullable(), X.describe("..."), X.int(), X.array(), X.default()
    if (base) {
      const inner = zodToSchema(base, schemas, depth + 1);
      if (method === "optional" || method === "nullish" || method === "default") return Object.assign(inner, { __optional: true });
      if (method === "nullable") return inner;
      if (method === "describe") return Object.assign(inner, { description: str(lit(a.args[0])) });
      if (method === "int") return Object.assign(inner, { type: "integer" });
      if (method === "array") return { type: "array", items: inner };
      return inner;
    }
    return { type: "string" };
  }

  // ------------------------------------------------------------------ main conversion of one export file
  function convertFile(path, src, ctx) {
    const lang = /new Agent\(\{|@openai\/agents|runWorkflow\s*=|export const |const \w+ = /.test(src) && !/^\s*(from agents import|import asyncio|def run_workflow|async def run_workflow)/m.test(src) ? "ts" : "py";
    const report = [];
    const note = (level, key, args) => report.push({ level, key, args: args || {} });
    const creds = new Map();
    const addCred = (cred, node) => creds.set(cred + "|" + node, { cred, node });
    const top = lang === "py" ? P.pyStatements(src) : P.tsStatements(P.tokenize(src, "ts"));

    // ---- collect definitions
    const tools = {}, agents = {}, schemas = {}, classes = {}, fns = {};
    let guardrailsConfig = null, workflowBody = null, traceName = "";
    const guardConfigs = {};
    let pendingDecorator = null;
    const visitTop = (stmts) => {
      for (const s of stmts) {
        if (s.s === "decorator") { pendingDecorator = s.name; continue; }
        if (s.s === "class") classes[s.name] = s;
        if (s.s === "def") {
          if (s.name === "run_workflow") workflowBody = s.body;
          else fns[s.name] = Object.assign({}, s, { decorator: pendingDecorator });
          if (pendingDecorator && /function_tool/.test(pendingDecorator)) tools[s.name] = { kind: "function", name: s.name, py: s };
        }
        pendingDecorator = s.s === "decorator" ? pendingDecorator : null;
        if (s.s !== "assign" || !s.target || s.target.t !== "name") continue;
        const name = s.target.id;
        let v = s.value;
        const cn = callName(v);
        if (/^(WebSearchTool|webSearchTool)$/.test(cn)) tools[name] = { kind: "web_search", cfg: loose(v.args[0] && v.args[0].t === "dict" ? v.args[0] : { t: "dict", entries: Object.entries(v.kwargs || {}).map(([k, x]) => ({ k: { t: "str", v: k }, v: x })) }) };
        else if (/^(FileSearchTool|fileSearchTool)$/.test(cn)) { const k = kw(v); const ids = lit(K(k, "vector_store_ids", "vectorStoreIds")) || lit(v.args[0]) || []; tools[name] = { kind: "file_search", ids: [].concat(ids), max: lit(K(k, "max_num_results", "maxNumResults")) }; if (v.args[1] && v.args[1].t === "dict") { const k2 = kw({ t: "call", args: [v.args[1]] }); tools[name].max = lit(K(k2, "max_num_results", "maxNumResults")) || tools[name].max; } }
        else if (/^(HostedMCPTool|hostedMcpTool)$/.test(cn)) { const k = kw(v); const cfg = loose(K(k, "tool_config")) || loose(v.args[0]) || {}; tools[name] = { kind: "mcp", cfg }; }
        else if (/^(CodeInterpreterTool|codeInterpreterTool)$/.test(cn)) tools[name] = { kind: "code_interpreter" };
        else if (/^(ImageGenerationTool|imageGenerationTool)$/.test(cn)) tools[name] = { kind: "image_generation" };
        else if (cn === "tool" || cn === "function_tool") { const k = kw(v); tools[name] = { kind: "function", name: str(lit(k.name)) || name, desc: str(lit(k.description)), params: k.parameters, exec: k.execute }; }
        else if (cn === "Agent" || cn === "agents.Agent") agents[name] = { varName: name, kw: kw(v) };
        else if (/^z\.object$/.test(cn) || (v && v.t === "call" && v.fn.t === "attr" && nameOf(v.fn).startsWith("z."))) schemas[name] = zodToSchema(v, schemas);
        else if (v && v.t === "dict" && v.entries.some((e) => e.k && lit(e.k) === "guardrails")) { guardConfigs[name] = loose(v); guardrailsConfig = guardrailsConfig || guardConfigs[name]; }
        else if (name === "runWorkflow" && v && v.t === "arrow" && v.body && v.body.t === "block") workflowBody = P.tsStatements(v.body.src.concat([{ type: "eof" }]));
        else if (v && v.t === "arrow") fns[name] = { name, arrow: v };
      }
    };
    visitTop(top);
    for (const m of src.matchAll(/(\w+)\s*=\s*(?:HostedMCPTool|hostedMcpTool)\(/g)) {
      if (tools[m[1]]) continue;
      const chunk = src.slice(m.index, m.index + 3000);
      const g = (k) => { const r = new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']([^"']+)["']`).exec(chunk); return r ? r[1] : undefined; };
      tools[m[1]] = { kind: "mcp", cfg: { server_label: g("server_label") || g("serverLabel"), server_url: g("server_url") || g("serverUrl"), connector_id: g("connector_id") || g("connectorId"), authorization: /authorization/i.test(chunk) ? "x" : undefined } };
    }
    for (const [k, c] of Object.entries(classes)) if (/BaseModel/.test(c.bases)) schemas[k] = classSchema(c, classes, 0);

    // unwrap "with trace(...)" (py) and "return await withTrace(name, async () => {...})" (ts)
    const unwrap = (body) => {
      if (!body) return null;
      const out = [];
      for (const s of body) {
        if (s.s === "block") { out.push(...unwrap(s.body)); continue; }
        if (s.s === "return" && s.value && callName(s.value) === "withTrace") {
          const fnArg = s.value.args.find((x) => x.t === "arrow");
          if (fnArg && fnArg.body && fnArg.body.t === "block") { traceName = str(lit(s.value.args[0])); out.push(...unwrap(P.tsStatements(fnArg.body.src.concat([{ type: "eof" }])))); continue; }
        }
        out.push(s);
      }
      return out;
    };
    workflowBody = unwrap(workflowBody);
    const tm = /trace\(\s*["']([^"']+)["']|withTrace\(\s*["']([^"']+)["']/.exec(src);
    if (tm) traceName = tm[1] || tm[2];
    const baseName = traceName || path.split("/").pop().replace(/\.[^.]+$/, "");
    const b = new Builder(baseName);

    // ---- expression translation (Python/TS AST → n8n JavaScript expression)
    const env = { vars: {}, state: {} };
    const agentNodes = []; // { varName, node, hasParser }
    let warnings = [];
    function chain(a) {
      const acc = [];
      while (a && (a.t === "attr" || a.t === "index" || (a.t === "call" && a.fn.t === "attr" && ["final_output_as", "model_dump", "json", "get", "model_dump_json"].includes(a.fn.name)))) {
        if (a.t === "attr") { acc.unshift({ k: a.name }); a = a.obj; }
        else if (a.t === "index") { const k = lit(a.idx); acc.unshift(k !== undefined ? { k: String(k) } : { e: a.idx }); a = a.obj; }
        else { const m = a.fn.name; if (m === "get") { acc.unshift({ k: String(lit(a.args[0])) }); } a = a.fn.obj; }
      }
      return { root: a, acc };
    }
    const accJs = (acc, from) => acc.slice(from || 0).map((x) => (x.k !== undefined ? (/^[A-Za-z_$][\w$]*$/.test(x.k) ? "." + x.k : `[${JSON.stringify(x.k)}]`) : `[${jx(x.e)}]`)).join("");
    function resolveChain(a) {
      const { root, acc } = chain(a);
      if (!root || root.t !== "name") return null;
      const id = root.id;
      if (id === "workflow" || id === "workflow_input" || id === "input") {
        const k = acc[0] && acc[0].k;
        if (!k || /^input_as_text$|^inputAsText$/.test(k)) return `$('${TRIGGER}').item.json.chatInput` + accJs(acc, 1);
        return `$('${TRIGGER}').item.json.${k}` + accJs(acc, 1);
      }
      if (id === "state") {
        const k = acc[0] && acc[0].k;
        if (!k) return `$('${STATE}').item.json`;
        return (env.state[k] || `$('${STATE}').item.json.${k}`) + accJs(acc, 1);
      }
      const v = env.vars[id];
      if (v && v.kind === "agent") {
        let i = 0;
        const field = v.field || "output";
        if (acc[0] && /^(output_parsed|finalOutput|final_output|output_text|outputText|output_parsed_json)$/.test(acc[0].k)) i = 1;
        if (acc[0] && /^(output_text|outputText)$/.test(acc[0].k) && v.parser) return `JSON.stringify($('${v.node.name}').item.json.${field})`;
        return `$('${v.node.name}').item.json.${field}` + accJs(acc, i);
      }
      if (v && v.kind === "expr") return `(${v.js})` + accJs(acc);
      if (v && (v.kind === "node" || v.kind === "guard")) return `$('${v.node.name}').item.json` + accJs(acc);
      return null;
    }
    function jx(a) {
      if (!a) return "''";
      switch (a.t) {
        case "str": return JSON.stringify(a.v);
        case "num": return String(a.v);
        case "bool": return a.v ? "true" : "false";
        case "null": return "null";
        case "regex": return a.src;
        case "fstr": return "`" + a.parts.map((p) => (typeof p === "string" ? p.replace(/[`\\]/g, "\\$&").replace(/\$\{/g, "\\${") : "${" + jx(p) + "}")).join("") + "`";
        case "list": return "[" + a.items.map((x) => (x.t === "spread" ? "..." + jx(x.x) : jx(x))).join(", ") + "]";
        case "dict": return "{" + a.entries.map((e) => (e.spread ? "..." + jx(e.spread) : e.k ? `${JSON.stringify(String(lit(e.k) !== undefined ? lit(e.k) : "k"))}: ${jx(e.v)}` : "")).filter(Boolean).join(", ") + "}";
        case "name": { const r = resolveChain(a); if (r) return r; if (a.id === "self") return "{}"; warnings.push(a.id); return a.id; }
        case "attr": case "index": { const r = resolveChain(a); if (r) return r; return a.t === "attr" ? jx(a.obj) + "." + a.name : jx(a.obj) + "[" + jx(a.idx) + "]"; }
        case "un": return a.op === "typeof" ? `typeof ${jx(a.x)}` : `${a.op}(${jx(a.x)})`;
        case "bin":
          if (a.op === "in") return `(${jx(a.r)} || []).includes(${jx(a.l)})`;
          if (a.op === "//") return `Math.floor(${jx(a.l)} / ${jx(a.r)})`;
          if (a.op === "**") return `Math.pow(${jx(a.l)}, ${jx(a.r)})`;
          return `(${jx(a.l)} ${a.op === "==" ? "==" : a.op === "!=" ? "!=" : a.op} ${jx(a.r)})`;
        case "cond": return `(${jx(a.test)} ? ${jx(a.a)} : ${jx(a.b)})`;
        case "call": {
          const r = resolveChain(a);
          if (r) return r;
          const fn = nameOf(a.fn);
          const A = a.args.map(jx);
          if (fn === "len") return `(${A[0]}).length`;
          if (fn === "str" || fn === "String") return `String(${A[0]})`;
          if (fn === "int" || fn === "float" || fn === "Number") return `Number(${A[0]})`;
          if (fn === "bool" || fn === "Boolean") return `Boolean(${A[0]})`;
          if (fn === "json.dumps" || fn === "JSON.stringify") return `JSON.stringify(${A[0]})`;
          if (fn === "json.loads" || fn === "JSON.parse") return `JSON.parse(${A[0]})`;
          if (fn === "isinstance") return "true";
          if (fn === "any") return `(${A[0]}).some(Boolean)`;
          if (fn === "all") return `(${A[0]}).every(Boolean)`;
          if (a.fn.t === "attr") {
            const o = jx(a.fn.obj), m = a.fn.name;
            const map = { lower: "toLowerCase()", upper: "toUpperCase()", strip: "trim()", lstrip: "trimStart()", rstrip: "trimEnd()" };
            if (map[m]) return `${o}.${map[m]}`;
            if (m === "startswith") return `${o}.startsWith(${A[0]})`;
            if (m === "endswith") return `${o}.endsWith(${A[0]})`;
            if (m === "join") return `(${A[0]}).join(${o})`;
            if (m === "split") return `${o}.split(${A[0] || "' '"})`;
            if (m === "replace") return `${o}.split(${A[0]}).join(${A[1]})`;
            if (m === "format") return o;
            return `${o}.${m}(${A.join(", ")})`;
          }
          warnings.push(fn + "()");
          return `${fn}(${A.join(", ")})`;
        }
        case "spread": return jx(a.x);
        case "arrow": return "(() => '')";
        default: warnings.push(a.t); return "''";
      }
    }
    const expr = (a) => "={{ " + jx(a) + " }}";
    const textOf = (a) => { // AST → n8n string parameter (literal or expression)
      const v = lit(a);
      if (typeof v === "string") return v;
      if (a && a.t === "fstr") return "=" + a.parts.map((p) => (typeof p === "string" ? p : "{{ " + jx(p) + " }}")).join("");
      return expr(a);
    };

    // ---- agents
    let memoryUsed = false;
    const builtinNames = { web_search: "web search", file_search: "file search", code_interpreter: "code interpreter" };
    function buildModel(agentDef, parent, ownerName) {
      const k = agentDef.kw;
      const model = str(lit(K(k, "model"))) || "gpt-4.1";
      const ms = K(k, "model_settings", "modelSettings");
      const msk = ms ? (ms.t === "dict" ? kw({ t: "call", args: [ms] }) : kw(ms)) : {};
      const reasoning = K(msk, "reasoning");
      const rk = reasoning ? (reasoning.t === "dict" ? kw({ t: "call", args: [reasoning] }) : kw(reasoning)) : {};
      const effort = str(lit(K(rk, "effort")));
      const toolList = (K(k, "tools") && K(k, "tools").items) || [];
      const builtIn = {};
      const used = [];
      for (const t of toolList) {
        const def = t.t === "name" ? tools[t.id] : null;
        if (!def) continue;
        if (def.kind === "web_search") {
          const c = def.cfg || {};
          const loc = c.user_location || c.userLocation || {};
          builtIn.webSearch = clean({ searchContextSize: c.search_context_size || c.searchContextSize || "medium", country: typeof loc.country === "string" ? loc.country : undefined, city: typeof loc.city === "string" ? loc.city : undefined, region: typeof loc.region === "string" ? loc.region : undefined });
          if (!Object.keys(builtIn.webSearch).length) builtIn.webSearch = { searchContextSize: "medium" };
          used.push(builtinNames.web_search);
        }
        if (def.kind === "file_search") { builtIn.fileSearch = clean({ vectorStoreIds: JSON.stringify(def.ids || []), maxResults: num(def.max) }); used.push(builtinNames.file_search + " (" + (def.ids || []).join(", ") + ")"); }
        if (def.kind === "code_interpreter") { builtIn.codeInterpreter = true; used.push(builtinNames.code_interpreter); }
      }
      const responses = Object.keys(builtIn).length > 0;
      const params = { model: { __rl: true, mode: "id", value: model } };
      if (responses) Object.assign(params, { responsesApiEnabled: true, builtInTools: builtIn });
      else params.responsesApiEnabled = false;
      params.options = clean({ temperature: num(lit(K(msk, "temperature"))), topP: num(lit(K(msk, "top_p", "topP"))), maxTokens: num(lit(K(msk, "max_tokens", "maxTokens"))), reasoningEffort: /^(low|medium|high)$/.test(effort) ? effort : undefined });
      const node = b.add(`${ownerName} model`, LC + "lmChatOpenAi", 1.3, params);
      addCred("OpenAI", node.name);
      b.link(node, parent, "ai_languageModel");
      if (used.length) note("ok", "builtin", { agent: ownerName, tools: used.join(", ") });
      return node;
    }
    function buildTools(agentDef, parent, ownerName) {
      const toolList = (K(agentDef.kw, "tools") && K(agentDef.kw, "tools").items) || [];
      for (const t of toolList) {
        const def = t.t === "name" ? tools[t.id] : null;
        if (!def) { note("manual", "toolMissing", { name: t.t === "name" ? t.id : nameOf(t.fn || t) || "?", agent: ownerName }); continue; }
        if (def.kind === "mcp") {
          const c = def.cfg || {};
          const label = str(c.server_label || c.serverLabel || "mcp");
          if (c.connector_id || c.connectorId) { note("manual", "connector", { label, id: str(c.connector_id || c.connectorId) }); continue; }
          const url = str(c.server_url || c.serverUrl);
          const allowed = Array.isArray(c.allowed_tools || c.allowedTools) ? (c.allowed_tools || c.allowedTools) : (c.allowed_tools && c.allowed_tools.tool_names) || null;
          const hasAuth = !!(c.authorization || (c.headers && Object.keys(c.headers).length));
          const p = clean({ endpointUrl: url || "https://example.com/mcp", serverTransport: /\/sse\b/.test(url) ? "sse" : "httpStreamable", authentication: hasAuth ? "bearerAuth" : undefined, include: allowed && allowed.length ? "selected" : "all", includeTools: allowed && allowed.length ? allowed : undefined });
          const node = b.add(label, LC + "mcpClientTool", 1.2, p);
          note("ok", "mcp", { label, url: url || "?" });
          if (hasAuth) { addCred(`Bearer del servidor MCP "${label}"`, node.name); note("adjust", "mcpSecret", { label }); }
          b.link(node, parent, "ai_tool");
        } else if (def.kind === "function") {
          let schema = { type: "object", properties: {} };
          if (def.params) schema = zodToSchema(def.params, schemas);
          if (def.py) { const props = {}; const params = str(def.py.params).replace(/^\(|\)$/g, ""); for (const part of params.split(",")) { const m = /^\s*(\w+)\s*:\s*([\w\[\]\. |]+)/.exec(part); if (m && m[1] !== "self" && m[1] !== "ctx") props[m[1]] = pyTypeToSchema(m[2], classes); } schema = { type: "object", properties: props, required: Object.keys(props) }; }
          const p = { name: slug(def.name), description: def.desc || (def.py && docstring(def.py)) || def.name, language: "javaScript", specifyInputSchema: true, schemaType: "manual", inputSchema: JSON.stringify(schema, null, 2) };
          const stub = isStub(def);
          if (def.exec && def.exec.t === "arrow" && def.exec.body && def.exec.body.t === "block" && !stub) {
            const bodySrc = sliceTokens(def.exec.body.src);
            const param = def.exec.params[0] || "input";
            p.jsCode = `const ${param} = typeof query === "string" ? (() => { try { return JSON.parse(query); } catch (e) { return { input: query }; } })() : (query || {});\n// ---- código original del export ----\nreturn await (async () => {${bodySrc}})();`;
            note("adjust", "fnCode", { name: def.name });
          } else if (def.py && !stub) {
            const pySrc = src.split("\n").slice(def.py.line - 1, def.py.endLine || def.py.line + 30).join("\n");
            p.jsCode = `// TODO: pasar a JavaScript. Código Python original:\n${pySrc.split("\n").map((l) => "// " + l).join("\n")}\nreturn "sin implementar";`;
            note("manual", "fnPython", { name: def.name });
          } else {
            p.jsCode = `// TODO: implementar "${def.name}". Los parámetros llegan en query (${Object.keys(schema.properties || {}).join(", ")}).\nreturn JSON.stringify({ error: "not implemented" });`;
            note("manual", "fnStub", { name: def.name });
          }
          b.link(b.add(def.name, LC + "toolCode", 1.3, p), parent, "ai_tool");
        } else if (def.kind === "image_generation") note("manual", "imageGen", { agent: ownerName });
        // web_search / file_search / code_interpreter are built-in tools of the model (buildModel)
      }
    }
    function docstring(def) { const s = def.body && def.body[0]; return s && s.s === "expr" && s.value && s.value.t === "str" ? s.value.v.trim() : ""; }
    function isStub(def) {
      if (def.py) return def.py.body.every((s) => s.s === "pass" || (s.s === "expr" && s.value && s.value.t === "str") || s.s === "raise");
      if (def.exec && def.exec.body && def.exec.body.t === "block") { const toks = def.exec.body.src.filter((t) => t.type !== "nl"); return toks.length === 0 || /TODO|Unimplemented|not implemented/i.test(sliceTokens(def.exec.body.src)) && toks.length < 12; }
      return true;
    }
    function sliceTokens(toks) {
      const real = toks.filter((t) => t.type !== "nl" && t.pos !== undefined);
      if (!real.length) return "";
      const last = real[real.length - 1];
      let end = last.pos + 1;
      // extend to end of the last token
      while (end < src.length && !/[\s;,)}\]]/.test(src[end])) end++;
      if (last.type === "str" || last.type === "fstr") { const q = src[last.pos]; const close = src.indexOf(q, last.pos + 1); end = close > 0 ? close + 1 : end; }
      return "\n" + src.slice(real[0].pos, end) + "\n";
    }
    function instructionsOf(agentDef, contextArgs) {
      const ins = K(agentDef.kw, "instructions");
      if (!ins) return "";
      const v = lit(ins);
      if (typeof v === "string") return v;
      if (ins.t === "fstr") return textOf(ins);
      // function reference (py) or arrow (ts) that builds instructions from run context
      const fnDef = ins.t === "name" ? fns[ins.id] : ins.t === "arrow" ? { arrow: ins } : null;
      if (!fnDef) return "";
      const saved = Object.assign({}, env.vars);
      try {
        if (fnDef.body) {
          for (const s of fnDef.body) {
            if (s.s === "assign" && s.target.t === "name") {
              const c = chain(s.value);
              const ctxKey = c.acc.length && c.acc[c.acc.length - 1].k;
              if (ctxKey && contextArgs[ctxKey]) env.vars[s.target.id] = { kind: "expr", js: jx(contextArgs[ctxKey]) };
              else if (ctxKey && contextArgs[camelToSnake(ctxKey)]) env.vars[s.target.id] = { kind: "expr", js: jx(contextArgs[camelToSnake(ctxKey)]) };
            }
            if (s.s === "return" && s.value) return textOf(s.value);
          }
        }
        if (fnDef.arrow && fnDef.arrow.body && fnDef.arrow.body.t !== "block") {
          const params = fnDef.arrow.params;
          const replaceCtx = (a) => { // runContext.context.x → context arg
            if (!a || typeof a !== "object") return a;
            if (a.t === "attr" && a.obj && a.obj.t === "attr" && a.obj.name === "context" && a.obj.obj.t === "name" && params.includes(a.obj.obj.id)) return contextArgs[a.name] || contextArgs[camelToSnake(a.name)] || { t: "str", v: "" };
            const out = Array.isArray(a) ? [] : {};
            for (const [k, v] of Object.entries(a)) out[k] = typeof v === "object" ? replaceCtx(v) : v;
            return out;
          };
          return textOf(replaceCtx(fnDef.arrow.body));
        }
      } finally { env.vars = saved; }
      return "";
    }
    let runCount = {};
    function buildAgentRun(agentVar, inputAst, contextAst, extendsHistory) {
      const def = agents[agentVar];
      const name = str(lit(K(def.kw, "name"))) || agentVar;
      runCount[agentVar] = (runCount[agentVar] || 0) + 1;
      const contextArgs = contextAst ? (contextAst.t === "call" ? Object.assign({}, contextAst.kwargs, kw(contextAst)) : contextAst.t === "dict" ? kw({ t: "call", args: [contextAst] }) : {}) : {};
      // prompt: conversation history → chat message; explicit message dicts → their text
      let text = `={{ $('${TRIGGER}').item.json.chatInput }}`;
      let usesHistory = false;
      const items = inputAst && inputAst.t === "list" ? inputAst.items : inputAst ? [inputAst] : [];
      const texts = [];
      for (const it of items) {
        if (it.t === "spread") { usesHistory = true; continue; }
        if (it.t === "dict") {
          const d = kw({ t: "call", args: [it] });
          const content = d.content;
          if (content && content.t === "list") for (const part of content.items) { const pk = part.t === "dict" ? kw({ t: "call", args: [part] }) : {}; if (pk.text) texts.push(pk.text); }
          else if (content) texts.push(content);
        } else if (it.t === "str" || it.t === "fstr" || it.t === "name" || it.t === "attr" || it.t === "index") texts.push(it);
      }
      if (texts.length) {
        const parts = texts.map((x) => { const t = textOf(x); return t.startsWith("=") ? t.slice(1) : t.replace(/\{\{/g, "{ {"); });
        text = "=" + parts.join("\n\n");
        if (!text.includes("{{")) text = text.slice(1);
      }
      const hasParser = !!K(def.kw, "output_type", "outputType");
      const sys = instructionsOf(def, contextArgs);
      const node = b.add(name, LC + "agent", 3.1, { promptType: "define", text, hasOutputParser: hasParser || undefined, options: clean({ systemMessage: sys || undefined }) });
      if (!hasParser) delete node.parameters.hasOutputParser;
      buildModel(def, node, node.name);
      buildTools(def, node, node.name);
      if (usesHistory || extendsHistory) {
        const mem = b.add(`${node.name} memory`, LC + "memoryBufferWindow", 1.3, { sessionIdType: "customKey", sessionKey: `={{ $('${TRIGGER}').item.json.sessionId }}`, contextWindowLength: 20 });
        b.link(mem, node, "ai_memory");
        memoryUsed = true;
      }
      if (hasParser) {
        const ot = K(def.kw, "output_type", "outputType");
        const schema = ot.t === "name" && schemas[ot.id] ? schemas[ot.id] : ot.t === "call" ? zodToSchema(ot, schemas) : { type: "object", properties: {} };
        b.link(b.add(`${node.name} output`, LC + "outputParserStructured", 1.2, { schemaType: "manual", inputSchema: JSON.stringify(schema, null, 2) }), node, "ai_outputParser");
      }
      agentNodes.push({ varName: agentVar, node });
      return { node, parser: hasParser };
    }

    // ---- guardrails
    function buildGuardrails(inputAst, callAst) {
      let cfg = guardrailsConfig;
      const findName = (a) => { if (!a || typeof a !== "object") return null; if (a.t === "name" && guardConfigs[a.id]) return guardConfigs[a.id]; for (const v of Object.values(a)) { const r = typeof v === "object" ? findName(v) : null; if (r) return r; } return null; };
      cfg = findName(callAst) || cfg;
      const list = (cfg && cfg.guardrails) || [];
      const g = {};
      const missing = [];
      let piiMask = false;
      for (const item of list) {
        const n = str(item.name), c = item.config || {};
        if (n === "Jailbreak" || n === "Prompt Injection Detection") g.jailbreak = { value: clean({ threshold: num(c.confidence_threshold) || 0.7 }) };
        else if (n === "NSFW Text") g.nsfw = { value: clean({ threshold: num(c.confidence_threshold) || 0.7 }) };
        else if (n === "Contains PII") {
          const ok = Array.isArray(c.entities) ? c.entities.filter((e) => PII_N8N.has(e)) : [];
          const dropped = Array.isArray(c.entities) ? c.entities.filter((e) => !PII_N8N.has(e)) : [];
          g.pii = { value: ok.length ? { type: "selected", entities: ok } : { type: "all" } };
          if (dropped.length) missing.push("PII: " + dropped.join(", "));
          if (c.block === false) piiMask = true;
        }
        else if (n === "URL Filter") g.urls = { value: clean({ allowedUrls: (c.url_allow_list || []).join(","), allowedSchemes: c.allowed_schemes, allowSubdomains: c.allow_subdomains, blockUserinfo: c.block_userinfo }) };
        else if (n === "Off Topic Prompts") g.topicalAlignment = { value: clean({ threshold: num(c.confidence_threshold) || 0.7, prompt: str(c.system_prompt_details) }) };
        else if (n === "Custom Prompt Check") (g.custom = g.custom || { guardrail: [] }).guardrail.push(clean({ name: "Custom", threshold: num(c.confidence_threshold) || 0.7, prompt: str(c.system_prompt_details) }));
        else missing.push(n);
      }
      const node = b.add("Guardrails", LC + "guardrails", 2, { operation: "classify", text: inputAst ? expr(inputAst) : `={{ $('${TRIGGER}').item.json.chatInput }}`, guardrails: g });
      if (g.jailbreak || g.nsfw || g.topicalAlignment || g.custom) { // LLM-based checks need a model
        const model = list.map((x) => x.config && x.config.model).find(Boolean) || "gpt-4.1-mini";
        const m = b.add("Guardrails model", LC + "lmChatOpenAi", 1.3, { model: { __rl: true, mode: "id", value: model }, responsesApiEnabled: false, options: {} });
        addCred("OpenAI", m.name);
        b.link(m, node, "ai_languageModel");
      }
      note("ok", "guardrails", { list: list.map((x) => x.name).join(", ") || "—" });
      if (missing.length) note("adjust", "guardMissing", { list: missing.join(", ") });
      if (piiMask) note("adjust", "piiMask");
      return node;
    }

    // ---- statements → graph
    const runOf = (v) => { // detects Runner.run(agent, input) / runner.run(agent, [...]) / run(agent, ...)
      if (!v || v.t !== "call") return null;
      const fn = nameOf(v.fn);
      if (!/(^|\.)(run|run_streamed|runStreamed)$/.test(fn) || !/Runner|runner|^run$/.test(fn)) return null;
      const a0 = v.args[0];
      if (!a0 || a0.t !== "name" || !agents[a0.id]) return null;
      const opts = v.args[2] && v.args[2].t === "dict" ? kw({ t: "call", args: [v.args[2]] }) : {};
      return { agentVar: a0.id, input: v.kwargs && v.kwargs.input ? v.kwargs.input : v.args[1], context: (v.kwargs && v.kwargs.context) || opts.context };
    };
    const isHistoryExtend = (s) => s.s === "expr" && s.value && s.value.t === "call" && /conversation_?[hH]istory\.(extend|push)$/.test(nameOf(s.value.fn));
    const stmtSrc = (s) => (src.split("\n")[s.line - 1] || "").trim().slice(0, 90);
    let stateNode = null;
    let lastGuard = null;

    // tails: list of [node, outputIndex]; returns new tails
    function connect(tails, node) { for (const [n, o] of tails) b.link(n, node, "main", o); }
    function emit(stmts, tails) {
      for (let idx = 0; idx < stmts.length; idx++) {
        const s = stmts[idx];
        if (!tails.length && s.s !== "other") { /* unreachable after return */ }
        if (s.s === "assign" && s.target && s.target.t === "name") {
          const name = s.target.id;
          const run = runOf(s.value);
          if (run) {
            const ext = stmts.slice(idx + 1, idx + 3).some(isHistoryExtend);
            const r = buildAgentRun(run.agentVar, run.input, run.context, ext);
            connect(tails, r.node);
            tails = [[r.node, 0]];
            env.vars[name] = { kind: "agent", node: r.node, parser: r.parser };
            const base = name.replace(/_result_temp$|ResultTemp$/, "");
            env.vars[base + "_result"] = env.vars[base + "Result"] = env.vars[name];
            continue;
          }
          const cn = callName(s.value);
          if (/run_guardrails|run_and_apply_guardrails|runGuardrails|runAndApplyGuardrails/.test(cn)) {
            const inputArg = /apply/i.test(cn) ? s.value.args[0] : s.value.args[1] || s.value.args[0];
            const g = buildGuardrails(inputArg && inputArg.t !== "name" ? inputArg : inputArg && env.vars[inputArg.id] ? { t: "name", id: inputArg.id } : null, s.value);
            connect(tails, g);
            tails = [[g, 0]];
            lastGuard = g;
            env.vars[name] = { kind: "guard", node: g };
            continue;
          }
          if (/vector_stores\.search|vectorStores\.search/.test(cn)) {
            const k = kw(s.value);
            const vs = str(lit(K(k, "vector_store_id", "vectorStoreId"))) || "vs_…";
            const h = b.add("File search", NB + "httpRequest", 4.2, { method: "POST", url: `https://api.openai.com/v1/vector_stores/${vs}/search`, authentication: "predefinedCredentialType", nodeCredentialType: "openAiApi", sendBody: true, specifyBody: "json", jsonBody: `={{ JSON.stringify({ query: ${jx(K(k, "query"))}, max_num_results: ${num(lit(K(k, "max_num_results", "maxNumResults"))) || 5} }) }}`, options: {} });
            addCred("OpenAI", h.name);
            note("adjust", "fileSearchNode");
            connect(tails, h);
            tails = [[h, 0]];
            env.vars[name] = { kind: "node", node: h };
            continue;
          }
          if (name === "state" && s.value.t === "dict") {
            const fields = kw({ t: "call", args: [s.value] });
            if (Object.keys(fields).length) {
              stateNode = b.add(STATE, NB + "set", 3.4, { mode: "manual", assignments: { assignments: Object.entries(fields).map(([k, v]) => ({ id: newId(), name: k, value: textOf(v), type: "string" })) }, includeOtherFields: true, options: {} });
              connect(tails, stateNode);
              tails = [[stateNode, 0]];
              note("adjust", "state");
            }
            continue;
          }
          if (/conversation_?[hH]istory|^workflow$|^runner$|^ctx$|^client$/.test(name)) continue;
          if (env.vars[name] && env.vars[name].kind === "agent") continue;
          // plain variable: keep as an expression for later references
          if (s.value) env.vars[name] = { kind: "expr", js: jx(s.value) };
          continue;
        }
        if (s.s === "assign" && s.target && s.target.t === "destructure") {
          const cn = callName(s.value);
          if (/run_guardrails|run_and_apply_guardrails|runGuardrails|runAndApplyGuardrails/.test(cn)) {
            const g = buildGuardrails(s.value.args[0] && s.value.args[0].t === "name" && env.vars[s.value.args[0].id] ? s.value.args[0] : null, s.value);
            connect(tails, g);
            tails = [[g, 0]];
            lastGuard = g;
            s.target.names.forEach((nm, i) => { env.vars[nm] = /tripwire/i.test(s.target.keys[i]) ? { kind: "expr", js: "false", tripwire: true } : { kind: "guard", node: g }; });
            continue;
          }
          const run = runOf(s.value);
          if (run) { const r = buildAgentRun(run.agentVar, run.input, run.context, false); connect(tails, r.node); tails = [[r.node, 0]]; continue; }
          continue;
        }
        if (s.s === "assign" && s.target) {
          const c = chain(s.target);
          if (c.root && c.root.t === "name" && c.root.id === "state" && c.acc[0] && c.acc[0].k) { env.state[c.acc[0].k] = jx(s.value); continue; }
          continue;
        }
        if (s.s === "expr") {
          if (isHistoryExtend(s)) continue;
          const run = runOf(s.value);
          if (run) { const r = buildAgentRun(run.agentVar, run.input, run.context, false); connect(tails, r.node); tails = [[r.node, 0]]; continue; }
          continue;
        }
        if (s.s === "if") {
          // guardrails tripwire → use the Guardrails node outputs
          const t0 = s.branches[0].test;
          const t0src = JSON.stringify(t0 || {});
          if (lastGuard && (/tripwire|hastripwire|hasTripwire/i.test(t0src) || (t0 && t0.t === "name" && env.vars[t0.id] && env.vars[t0.id].tripwire)) && s.branches.length === 1) {
            const failTails = emit(s.branches[0].body, [[lastGuard, 1]]);
            const passTails = emit(s.orelse || [], [[lastGuard, 0]]);
            tails = failTails.concat(passTails);
            lastGuard = null;
            continue;
          }
          // human approval
          if (s.branches.length === 1 && /approval_?[rR]equest|approvalRequest/.test(callName(t0))) {
            const wait = b.add("User approval", NB + "wait", 1.1, { resume: "form", formTitle: "Approval", formDescription: textOf(t0.args[0] || { t: "str", v: "Approve?" }), formFields: { values: [{ fieldLabel: "Decision", fieldType: "dropdown", fieldOptions: { values: [{ option: "Approve" }, { option: "Reject" }] }, requiredField: true }] }, options: {} }, { webhookId: newId() });
            connect(tails, wait);
            const sw = b.add("Approved?", NB + "if", 2.2, { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: newId(), leftValue: "={{ $json.Decision }}", rightValue: "Approve", operator: { type: "string", operation: "equals" } }], combinator: "and" }, looseTypeValidation: true, options: {} });
            b.link(wait, sw);
            note("adjust", "approval");
            tails = emit(s.branches[0].body, [[sw, 0]]).concat(emit(s.orelse || [], [[sw, 1]]));
            continue;
          }
          warnings = [];
          const rules = s.branches.map((br, i) => ({ conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: newId(), leftValue: "={{ Boolean(" + jx(br.test) + ") }}", rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }], combinator: "and" }, renameOutput: true, outputKey: `Branch ${i + 1}` }));
          if (warnings.length) note("adjust", "condRaw", { line: s.line, src: stmtSrc(s) });
          const before = b.nodes.length;
          const sw = b.add("If / else", NB + "switch", 3.2, { mode: "rules", rules: { values: rules }, looseTypeValidation: true, options: { fallbackOutput: "extra", renameFallbackOutput: "Else" } });
          let out = [];
          s.branches.forEach((br, i) => { out = out.concat(emit(br.body, [[sw, i]])); });
          out = out.concat(s.orelse ? emit(s.orelse, [[sw, rules.length]]) : [[sw, rules.length]]);
          if (b.nodes.length === before + 1) { // branches only set variables: drop the Switch
            b.nodes.pop(); b.names.delete(sw.name); delete b.conns[sw.name];
            continue;
          }
          connect(tails, sw);
          note("ok", "branch", { line: s.line, n: rules.length + 1 });
          tails = out;
          continue;
        }
        if (s.s === "while") {
          const iff = b.add("While", NB + "if", 2.2, { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: newId(), leftValue: "={{ Boolean(" + jx(s.test) + ") && $runIndex < 20 }}", rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }], combinator: "and" }, looseTypeValidation: true, options: {} });
          connect(tails, iff);
          const bodyTails = emit(s.body, [[iff, 0]]);
          for (const [n, o] of bodyTails) b.link(n, iff, "main", o);
          note("adjust", "loop", { line: s.line });
          tails = [[iff, 1]];
          continue;
        }
        if (s.s === "for") { note("adjust", "forLoop", { line: s.line }); tails = emit(s.body, tails); continue; }
        if (s.s === "block") { tails = emit(s.body, tails); continue; }
        if (s.s === "return") {
          if (!s.value) { tails = []; continue; }
          const r = resolveChain(s.value);
          let value;
          const lv = lit(s.value);
          if (typeof lv === "string") value = lv;
          else if (s.value.t === "dict") {
            const d = kw({ t: "call", args: [s.value] });
            const keys = Object.keys(d);
            value = keys.length === 1 ? textOf(d[keys[0]]) : "={{ JSON.stringify(" + jx(s.value) + ") }}";
          } else {
            const e = r || jx(s.value);
            value = /item\.json\.output$/.test(e) && !/output\./.test(e) ? "={{ " + e + " }}" : "={{ (v => typeof v === 'string' ? v : JSON.stringify(v))(" + e + ") }}";
          }
          const end = b.add("End", NB + "set", 3.4, { mode: "manual", assignments: { assignments: [{ id: newId(), name: "output", value, type: "string" }] }, options: {} });
          connect(tails, end);
          tails = [];
          continue;
        }
        if (s.s === "pass" || s.s === "decl" || s.s === "import" || s.s === "break" || s.s === "continue") continue;
        if (s.s === "raise") { tails = []; continue; }
        if (s.s === "other" && s.err) note("adjust", "unknownStmt", { line: s.line, src: stmtSrc(s) });
      }
      return tails;
    }

    const trigger = b.add(TRIGGER, LC + "chatTrigger", 1.1, { options: {} }, { webhookId: newId() });
    let endTails = [];
    if (workflowBody && workflowBody.length) endTails = emit(workflowBody, [[trigger, 0]]);
    else note("manual", "noWorkflow");
    // agents never run in the workflow body still get a node so nothing is lost
    for (const [v, def] of Object.entries(agents)) if (!agentNodes.some((a) => a.varName === v)) {
      const r = buildAgentRun(v, null, null, false);
      if (!workflowBody) b.link(trigger, r.node);
      else note("adjust", "unusedAgent", { name: r.node.name });
    }
    if (agentNodes.length) report.unshift({ level: "ok", key: "agents", args: { n: Object.keys(agents).length } });
    if (memoryUsed) note("ok", "memory");
    if (b.nodes.some((n) => n.name.startsWith("End"))) note("ok", "end");
    for (const { cred, node } of creds.values()) note("adjust", "credential", { cred, node });
    const stmtsTotal = (function count(st) { return (st || []).reduce((s, x) => s + 1 + count(x.body) + (x.branches || []).reduce((a, br) => a + count(br.body), 0) + count(x.orelse), 0); })(workflowBody);
    const bad = report.filter((r) => r.level === "manual" || r.key === "unknownStmt" || r.key === "condRaw").length;
    const coverage = Object.keys(agents).length ? Math.max(0, 1 - bad / Math.max(1, stmtsTotal + Object.keys(agents).length)) : 0;
    const seen = new Set();
    const uniq = report.filter((r) => { const k = r.key + JSON.stringify(r.args); if (seen.has(k)) return false; seen.add(k); return true; });
    return { builder: b, report: uniq, coverage, lang, agents: Object.keys(agents).length };
  }

  // ------------------------------------------------------------------ public API
  function looksLikeExport(src) {
    return /(new Agent\(\{|= Agent\()/.test(src) && /(Runner\.run|runner\.run|\brun\(\w+,)/.test(src);
  }
  function convert(files, opts) {
    opts = opts || {};
    const lang = opts.lang === "en" ? "en" : "es";
    const workflows = [];
    const used = new Set();
    for (const path of Object.keys(files).sort()) {
      const src = files[path];
      if (typeof src !== "string" || !looksLikeExport(src) || /^\s*</.test(src)) continue;
      let res;
      try { res = convertFile(path, src, { lang }); } catch (e) { workflows.push({ name: path, fileName: slug(path) + ".error.txt", error: e.message, report: [], coverage: 0, primary: true }); continue; }
      let fileName = slug(res.builder.name) + ".n8n.json";
      for (let j = 2; used.has(fileName); j++) fileName = slug(res.builder.name) + "_" + j + ".n8n.json";
      used.add(fileName);
      workflows.push({ name: res.builder.name, source: path, fileName, n8n: res.builder.json(), report: res.report, coverage: res.coverage, lang: res.lang, agents: res.agents, primary: true });
    }
    const ok = workflows.filter((w) => !w.error);
    const summary = { files: workflows.length, count: ok.length, errors: workflows.length - ok.length, agents: ok.reduce((s, w) => s + w.agents, 0),
      coverage: ok.length ? ok.reduce((s, w) => s + w.coverage, 0) / ok.length : 0, fullyAutomatic: ok.filter((w) => !w.report.some((r) => r.level === "manual")).length };
    return { workflows: ok, failed: workflows.filter((w) => w.error), summary, reportMarkdown: (l) => reportMarkdown(ok, l || lang), noteText };
  }
  function noteText(r, lang) { const f = NOTE[r.key]; return f ? f[lang === "en" ? "en" : "es"](r.args || {}) : r.key; }
  function reportMarkdown(workflows, lang) {
    const t = MSG[lang === "en" ? "en" : "es"];
    const out = [`# ${t.title}`, "", t.intro, ""];
    for (const w of workflows) {
      out.push(`## ${w.name}`, "", `${t.coverage}: ${Math.round(w.coverage * 100)}% · \`${w.fileName}\` (${w.source})`, "");
      for (const [lv, lvName] of [["manual", t.manual], ["adjust", t.adjust], ["ok", t.ok]]) {
        const items = w.report.filter((r) => r.level === lv && r.key !== "credential");
        if (!items.length) continue;
        out.push(`**${lvName}**`, "");
        for (const r of items) out.push(`- ${noteText(r, lang)}`);
        out.push("");
      }
      const creds = [...new Set(w.report.filter((r) => r.key === "credential").map((r) => noteText(r, lang)))];
      if (creds.length) { out.push(`**${t.creds}**`, ""); for (const c of creds) out.push(`- ${c}`); out.push(""); }
    }
    return out.join("\n");
  }
  return { convert, looksLikeExport, _internal: { convertFile } };
});
