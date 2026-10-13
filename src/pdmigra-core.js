/*
 * pdmigra core: converts Pipedream workflows (GitHub Sync folders or official project export) into n8n workflows.
 * Runs in the browser (window.pdmigra) and in Node (require). No network access, no data leaves the machine.
 *
 * Input:  a map { "path/inside/upload": "file text" } plus a YAML parser (js-yaml's load).
 * Output: { workflows: [{ name, fileName, n8n, report, coverage }], summary }
 *
 * Note: this file contains only our own code. Pipedream component source code is NOT included
 * (its license forbids commercial use); actions are re-implemented from each service's public API docs.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.pdmigra = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BUILTINS = new Set(["crypto", "fs", "path", "url", "util", "buffer", "querystring", "zlib", "os", "stream",
    "events", "assert", "http", "https", "string_decoder", "timers", "process", "child_process", "dns", "net"]);
  const X = 240;
  let uid = 0;
  const newId = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    uid += 1;
    return "00000000-0000-4000-8000-" + String(uid).padStart(12, "0");
  };
  const J = (v) => JSON.stringify(v);

  // ------------------------------------------------------------------ reading inputs

  function dirname(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
  function joinPath(base, rel) {
    const parts = (base ? base.split("/") : []).concat(rel.split("/"));
    const out = [];
    for (const s of parts) { if (s === "." || s === "") continue; if (s === "..") out.pop(); else out.push(s); }
    return out.join("/");
  }

  function readGithubSync(files, yamlLoad) {
    const out = [];
    for (const path of Object.keys(files).sort()) {
      if (!/(^|\/)workflow\.yaml$/.test(path) || path.includes("/.git/")) continue;
      const d = yamlLoad(files[path]) || {};
      const dir = dirname(path);
      const steps = (d.steps || []).map((s) => {
        const uses = s.uses || "";
        const step = { ns: s.namespace, runtime: s.runtime || "", props: s.props || {} };
        if (uses.startsWith("./")) {
          const file = joinPath(dir, uses.slice(2));
          Object.assign(step, { kind: "code", code: files[file] || "", file,
            lang: /python/.test(step.runtime) || file.endsWith(".py") ? "python" : "node" });
        } else {
          const at = uses.lastIndexOf("@");
          Object.assign(step, { kind: "component", component: at > 0 ? uses.slice(0, at) : uses, version: at > 0 ? uses.slice(at + 1) : "" });
        }
        return step;
      });
      out.push({ name: d.name || dir.split("/").pop(), source: dir, settings: d.settings || {}, inactive: !!d.inactive,
        triggers: (d.triggers || []).map((t) => ({ type: t.type || "unknown", config: t })), steps });
    }
    return out;
  }

  // Official export (project-export/2026.01). Exact step shape is not fully documented, so read tolerantly.
  function readExport(files) {
    const out = [];
    for (const path of Object.keys(files).sort()) {
      if (!path.endsWith(".json") || /(^|\/)manifest\.json$/.test(path)) continue;
      let d;
      try { d = JSON.parse(files[path]); } catch (e) { continue; }
      if (!d || !Array.isArray(d.steps)) continue;
      const steps = d.steps.map((s) => {
        const ns = s.namespace || s.name || s.key || s.id;
        // Real exports (workflow.json/2026.01): every step is a "CodeCell"; code lives in uses.code, actions in uses.key.
        const code = typeof s.code === "string" ? s.code : (s.source && typeof s.source.code === "string" ? s.source.code
          : (s.uses && typeof s.uses.code === "string" ? s.uses.code : null));
        const runtime = String(s.runtime || s.lang || "");
        let comp = s.component_key || s.component || s.key_version || s.uses || "";
        if (comp && typeof comp === "object") comp = comp.key || "";
        const step = { ns, runtime, props: s.props || s.configured_props || {} };
        if (code && /^(go|bash)/.test(runtime)) Object.assign(step, { kind: "component", component: runtime.replace(/[\d.]+$/, "") + "-code-step", version: "" });
        else if (code) Object.assign(step, { kind: "code", code, file: path, lang: /python/.test(runtime || String(s.type)) ? "python" : "node" });
        else {
          const at = String(comp).lastIndexOf("@");
          Object.assign(step, { kind: "component", component: at > 0 ? comp.slice(0, at) : comp, version: s.version || (at > 0 ? comp.slice(at + 1) : "") });
        }
        return step;
      });
      out.push({ name: d.name || path, source: path, settings: d.settings || {}, inactive: !!d.inactive,
        triggers: (d.triggers || []).map((t) => ({ type: t.type || "unknown", config: t })), steps });
    }
    return out;
  }

  // ------------------------------------------------------------------ report (en / es)

  const T = {
    en: {
      title: "Pipedream → n8n migration report",
      steps: "Steps", auto: "converted automatically", inactive: "Was inactive in Pipedream",
      connect: "Connect in n8n", vars: "Create these variables (n8n Variables or environment)",
      npm: "npm modules used (not allowed on n8n Cloud; on self-hosted n8n enable NODE_FUNCTION_ALLOW_EXTERNAL=",
      manual: "To do by hand", review: "Check",
    },
    es: {
      title: "Informe de migración Pipedream → n8n",
      steps: "Pasos", auto: "convertidos automáticamente", inactive: "Estaba inactivo en Pipedream",
      connect: "Conectar en n8n", vars: "Crear estas variables (n8n Variables o entorno)",
      npm: "Módulos npm usados (no se permiten en n8n Cloud; en n8n propio habilitar NODE_FUNCTION_ALLOW_EXTERNAL=",
      manual: "A mano", review: "Revisar",
    },
  };
  // Messages are stored as [en, es] pairs so the report can be rendered in either language.
  const M = {
    pythonBeta: (ns) => [`step ${ns}: Python step converted (beta); test it in n8n before activating`,
      `paso ${ns}: paso Python convertido (beta); probarlo en n8n antes de activar`],
    pyImports: (ns, mods) => [`step ${ns} (Python) imports ${mods}; on self-hosted n8n allow them with N8N_RUNNERS_STDLIB_ALLOW / N8N_RUNNERS_EXTERNAL_ALLOW`,
      `paso ${ns} (Python) usa ${mods}; en n8n propio habilitarlos con N8N_RUNNERS_STDLIB_ALLOW / N8N_RUNNERS_EXTERNAL_ALLOW`],
    noExport: (ns) => [`step ${ns}: original code is incomplete (no 'export default'); check it in Pipedream`,
      `paso ${ns}: el código original está incompleto (no tiene 'export default'); revisarlo en Pipedream`],
    missingLocal: (ns, m) => [`step ${ns}: imports ${m}, which was not included in the upload`,
      `paso ${ns}: importa ${m}, que no vino en los archivos`],
    dataStore: (ns, s) => [`step ${ns}: data store '${s}' now uses the n8n workflow's static data (persists only in production executions and is not shared across workflows)`,
      `paso ${ns}: el data store '${s}' pasó al almacenamiento interno del flujo de n8n (solo persiste en ejecuciones de producción y no se comparte entre flujos)`],
    flowDelay: (ns) => [`step ${ns}: uses $.flow.delay; replace it with a Wait node`, `paso ${ns}: usa $.flow.delay; reemplazarlo por un nodo Wait`],
    flowRerun: (ns) => [`step ${ns}: uses $.flow.rerun, which has no direct n8n equivalent`, `paso ${ns}: usa $.flow.rerun, que no tiene equivalente directo en n8n`],
    send: (ns) => [`step ${ns}: uses $.send (email/http/s3); replace it with the matching n8n node`, `paso ${ns}: usa $.send (email/http/s3); reemplazarlo por el nodo de n8n que corresponda`],
    files: (ns) => [`step ${ns}: uses Pipedream file storage ($.files); review by hand`, `paso ${ns}: usa archivos de Pipedream ($.files); revisar a mano`],
    unsupported: (ns, k, v) => [`step ${ns}: action ${k}${v ? "@" + v : ""} is not converted automatically yet; the node stops with an error until you replace it`,
      `paso ${ns}: la acción ${k}${v ? "@" + v : ""} todavía no se convierte sola; el nodo frena con un error hasta que lo reemplaces`],
    shape: (ns, uses) => [`step ${ns}: later steps read ${uses}; the n8n node returns the service's raw API response, check those fields`,
      `paso ${ns}: pasos siguientes leen ${uses}; el nodo de n8n devuelve la respuesta cruda de la API, revisar esos campos`],
    pagination: (ns) => [`step ${ns}: returns only the first page of results (Pipedream fetched every page); enable pagination in the HTTP node options if needed`,
      `paso ${ns}: devuelve solo la primera página (Pipedream traía todas); activar la paginación en las opciones del nodo HTTP si hace falta`],
    sheetTitle: (ns) => [`step ${ns}: the sheet name was not in the file; the range uses the first sheet, check it`,
      `paso ${ns}: el nombre de la hoja no venía en el archivo; el rango usa la primera hoja, revisarlo`],
    trigEmail: () => ["email trigger: Pipedream gave you its own inbox; in n8n use an Email Trigger (IMAP) with your own mailbox",
      "disparador por email: Pipedream daba una casilla propia; en n8n usar Email Trigger (IMAP) con una casilla tuya"],
    trigSource: (k) => [`app trigger (${k}): pick the matching n8n trigger node or a scheduled poll`,
      `disparador de app (${k}): elegir el trigger equivalente de n8n o un sondeo programado`],
    trigUnknown: () => ["trigger: the file does not include the trigger settings (GitHub Sync never does, and some exports come with an empty trigger list); it became a manual trigger, set the real one (webhook, schedule or app) in n8n",
      "disparador: el archivo no trae su configuración (GitHub Sync nunca la trae y algunos exports vienen con la lista vacía); quedó como disparador manual, configurá el real (webhook, programado o de app) en n8n"],
    trigSchedule: () => ["scheduled trigger: the schedule was not in the file; set the frequency", "disparador programado: la frecuencia no venía en el archivo; configurarla"],
    trigMany: (n) => [`the workflow had ${n} triggers; n8n uses one per workflow (the first one was converted)`,
      `el flujo tenía ${n} disparadores; n8n usa uno por flujo (se convirtió el primero)`],
    emailSelf: (ns) => [`step ${ns}: 'send email to self' now uses n8n's Send Email node; create an SMTP credential and the MY_EMAIL variable`,
      `paso ${ns}: 'enviarme un email' ahora usa el nodo Send Email de n8n; crear una credencial SMTP y la variable MY_EMAIL`],
  };

  function newReport() { return { creds: new Set(), vars: new Set(), npm: new Set(), manual: [], review: [] }; }

  // ------------------------------------------------------------------ expressions

  // Pipedream expression (JS-like) -> JS usable inside an n8n expression ({{ }}), reading other nodes' output.
  function pdExprToN8nJs(expr, ctx) {
    let e = expr.trim();
    e = e.replace(/\bprocess\.env\.(\w+)/g, (_, v) => { ctx.report.vars.add(`${v}  (process.env.${v})`); return `$env.${v}`; });
    e = e.replace(/\bsteps\.trigger\.event\b/g, "$('trigger').first().json");
    e = e.replace(/\bsteps\.trigger\.context\b/g, "$('trigger').first().json.__context");
    e = e.replace(/\bsteps\.(\w+)((?:\.\$return_value|\["\$return_value"\]|\['\$return_value'\])?)/g, (m, ns, rv) => {
      const kind = ctx.kinds[ns];
      if (kind === "raw") return `$('${ns}').first().json`;
      return `$('${ns}').first().json${rv ? ".$return_value" : ""}`;
    });
    return e;
  }

  const lv = (v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && "__lv" in v) return v.__lv && typeof v.__lv === "object" ? v.__lv.value : v.__lv;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "value" in v) return v.value;
    return v;
  };
  const lvLabel = (v) => (v && typeof v === "object" && v.__lv && typeof v.__lv === "object" ? v.__lv.label : undefined);

  // A prop value -> JS source for use inside {{ }} (strings with {{ }} become template literals).
  function valueToJs(v, ctx) {
    v = lv(v);
    if (typeof v === "string") {
      const parts = v.split(/\{\{([\s\S]*?)\}\}/);
      if (parts.length === 1) return J(v);
      if (parts.length === 3 && parts[0] === "" && parts[2] === "") return `(${pdExprToN8nJs(parts[1], ctx)})`;
      return "`" + parts.map((p, i) => (i % 2 ? "${" + pdExprToN8nJs(p, ctx) + "}" : p.replace(/[`\\]/g, "\\$&").replace(/\$\{/g, "\\${"))).join("") + "`";
    }
    if (Array.isArray(v)) return "[" + v.map((x) => valueToJs(x, ctx)).join(", ") + "]";
    if (v && typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => `${J(k)}: ${valueToJs(x, ctx)}`).join(", ") + "}";
    return J(v === undefined ? null : v);
  }

  // A prop value -> n8n parameter (plain value if static, "={{ ... }}" if it has expressions).
  function param(v, ctx) {
    v = lv(v);
    if (typeof v === "string" && v.includes("{{")) {
      return "=" + v.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => "{{ " + pdExprToN8nJs(e, ctx) + " }}");
    }
    if (v && typeof v === "object") {
      const s = J(v);
      return s.includes("{{") ? "={{ " + valueToJs(v, ctx) + " }}" : v;
    }
    return v;
  }
  // Pipedream "sql" props may come as { value: "SELECT ...", ... }: n8n wants the SQL text.
  const sqlText = (v) => (v && typeof v === "object" && !Array.isArray(v) ? (typeof v.value === "string" ? v.value : typeof v.query === "string" ? v.query : v) : v);
  // JSON bodies drop null/undefined fields (several APIs reject explicit nulls).
  const CLEAN = "((o) => JSON.parse(JSON.stringify(o, (k, v) => (v === null ? undefined : v))))";
  const exprObj = (obj, ctx) => "={{ " + CLEAN + "(" + valueToJs(obj, ctx) + ") }}";
  const has = (v) => { v = lv(v); return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length); };
  // String-ish prop as JS (inside {{ }}), parsing JSON arrays written as text.
  const asArrayJs = (v, ctx) => {
    const r = lv(v);
    if (Array.isArray(r)) return valueToJs(r, ctx);
    return `(() => { const v = ${valueToJs(r, ctx)}; if (Array.isArray(v)) return v; try { const p = JSON.parse(v); return Array.isArray(p) ? p : [p]; } catch (e) { return [v]; } })()`;
  };

  // ------------------------------------------------------------------ JS code steps

  const RX_IMPORT = /^[ \t]*import\s+([\w$*{][\s\S]*?)\s+from\s+['"]([^'"]+)['"][ \t]*;?[ \t]*(?:\/\/[^\n]*)?$/gm;

  function stripExports(js) {
    return js
      .replace(/^[ \t]*export\s+\{[^}]*\}\s*(from\s+['"][^'"]+['"])?;?[ \t]*$/gm, "")
      .replace(/^([ \t]*)export\s+default\s+/gm, "$1const __default_export = ")
      .replace(/^([ \t]*)export\s+(const|let|var|function|async\s+function|class)\b/gm, "$1$2");
  }

  function propsToJs(props, apps, ctx) {
    const items = [];
    for (const [k, raw] of Object.entries(props || {})) {
      if (raw && typeof raw === "object" && "authProvisionId" in raw) { items.push(`${J(k)}: __app(${J(k)})`); apps.add(k); continue; }
      if (k === "__configurableProps") continue;
      items.push(`${J(k)}: __try(() => (${valueToJsInCode(raw)}), undefined)`);
    }
    return items.length ? "{\n  " + items.join(",\n  ") + "\n}" : "{}";
  }
  // Inside a Code node, Pipedream expressions read the local `steps` object (built from previous nodes).
  function valueToJsInCode(v) {
    v = lv(v);
    if (typeof v === "string") {
      const fix = (e) => e.trim().replace(/\bprocess\.env\.(\w+)/g, "__secret('$1')");
      const parts = v.split(/\{\{([\s\S]*?)\}\}/);
      if (parts.length === 1) return J(v);
      if (parts.length === 3 && parts[0] === "" && parts[2] === "") return `(${fix(parts[1])})`;
      return "`" + parts.map((p, i) => (i % 2 ? "${" + fix(p) + "}" : p.replace(/[`\\]/g, "\\$&").replace(/\$\{/g, "\\${"))).join("") + "`";
    }
    if (Array.isArray(v)) return "[" + v.map(valueToJsInCode).join(", ") + "]";
    if (v && typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => `${J(k)}: ${valueToJsInCode(x)}`).join(", ") + "}";
    return J(v === undefined ? null : v);
  }

  const HELPERS = `const __node = this;
const __try = (f, d) => { try { const v = f(); return v === undefined ? d : v; } catch (e) { return d; } };
const __safe = (n) => { try { return $(n).first().json; } catch (e) { return undefined; } };
const __stepOut = (n) => { const j = __safe(n); return j && typeof j === 'object' && !Array.isArray(j) ? { ...j, $return_value: j.$return_value !== undefined ? j.$return_value : j } : { $return_value: j }; };
const __secret = (k) => { try { if (typeof $vars !== 'undefined' && $vars[k] !== undefined) return $vars[k]; } catch (e) {} try { return $env[k]; } catch (e) { return undefined; } };
const __app = (name) => ({ $auth: new Proxy({}, { get: (_, f) => __secret(\`\${name}_\${String(f)}\`.toUpperCase()) }) });
`;

  function stepsObjectJs(prev) {
    return "const steps = {\n  trigger: (() => { const t = __safe('trigger') || {}; const { __context, ...event } = t; return { event, context: __context || {} }; })(),\n" +
      prev.map((p) => `  ${J(p)}: __stepOut(${J(p)}),`).join("\n") + "\n};";
  }

  function convertJs(step, prev, ctx) {
    const R = ctx.report;
    const src = step.code;
    const npm = new Set();
    let pdAxios = false, npmAxios = false, broken = false;
    const base = dirname(step.file || "");
    const locals = [], seen = new Set();

    const imp = (m, body, mod) => {
      body = body.trim();
      if (mod.startsWith(".")) {
        const f = joinPath(base, mod);
        if (!seen.has(f) && ctx.files[f] !== undefined) {
          seen.add(f);
          locals.push(`// ---- local module ${mod} ----\n` + stripExports(ctx.files[f].replace(RX_IMPORT, imp)));
        } else if (ctx.files[f] === undefined) R.manual.push(M.missingLocal(step.ns, mod));
        return [...body.matchAll(/(\w+)\s+as\s+(\w+)/g)].map(([, a, b]) => `const ${b} = ${a};`).join("\n");
      }
      if (mod === "@pipedream/platform") { if (/\baxios\b/.test(body)) pdAxios = true; return ""; }
      if (mod === "axios") { npmAxios = true; const name = body.replace(/[{}]/g, "").split(",")[0].trim() || "axios"; return `const ${name} = __axiosNpm;`; }
      mod = mod.replace(/^node:/, "");
      const rootMod = mod.startsWith("@") ? mod.split("/").slice(0, 2).join("/") : mod.split("/")[0];
      if (!BUILTINS.has(rootMod)) npm.add(rootMod);
      if (body.startsWith("{")) return `const ${body.replace(/\s+as\s+/g, ": ")} = require(${J(mod)});`;
      if (body.startsWith("* as ")) return `const ${body.slice(5).trim()} = require(${J(mod)});`;
      if (body.includes(",")) {
        const [d, rest] = [body.slice(0, body.indexOf(",")), body.slice(body.indexOf(",") + 1)];
        return `const ${d.trim()} = require(${J(mod)});\nconst ${rest.trim().replace(/\s+as\s+/g, ": ")} = require(${J(mod)});`;
      }
      return `const ${body} = ((m) => (m && m.default ? m.default : m))(require(${J(mod)}));`;
    };

    let body = src.replace(RX_IMPORT, imp);
    body = body.replace(/^[ \t]*import\s+['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm, (m, mod) => `require(${J(mod)});`);
    if (locals.length) body = locals.join("\n") + "\n// ---- step ----\n" + body;
    if (/defineComponent\s*\(/.test(body)) body = body.replace(/export\s+default\s+defineComponent\s*\(/, "const __component = (");
    else if (/export\s+default\s+/.test(body)) body = body.replace(/export\s+default\s+/, "const __component = ");
    else { R.manual.push(M.noExport(step.ns)); broken = true; }
    for (const [, e] of body.matchAll(/process\.env\.(\w+)/g)) R.vars.add(`${e}  (process.env.${e})`);
    body = body.replace(/process\.env\.(\w+)/g, "__secret('$1')");

    const apps = new Set();
    for (const [, a, f] of src.matchAll(/this\.(\w+)\.\$auth\.(\w+)/g)) R.vars.add(`${a.toUpperCase()}_${f.toUpperCase()}  (this.${a}.$auth.${f})`);
    for (const [, a] of src.matchAll(/(\w+)\s*:\s*\{\s*type:\s*['"]app['"]/g)) apps.add(a);
    const stores = [...src.matchAll(/(\w+)\s*:\s*\{\s*type:\s*['"]data_store['"]/g)].map((m) => m[1]);
    for (const s of stores) { apps.delete(s); R.manual.push(M.dataStore(step.ns, s)); }
    for (const m of npm) R.npm.add(m);
    if (src.includes("$.flow.delay")) R.manual.push(M.flowDelay(step.ns));
    if (src.includes("$.flow.rerun")) R.manual.push(M.flowRerun(step.ns));
    if (src.includes("$.service.db")) R.manual.push(M.dataStore(step.ns, "$.service.db"));
    if (src.includes("$.send.")) R.manual.push(M.send(step.ns));
    if (src.includes("$.files")) R.manual.push(M.files(step.ns));

    const props = propsToJs(step.props, apps, ctx);
    let shims = "";
    if (pdAxios || npmAxios) shims += `const __http = async (cfg, full) => {
  const r = await __node.helpers.httpRequest({ method: (cfg.method || 'GET').toUpperCase(), url: cfg.url, headers: cfg.headers,
    qs: cfg.params, body: cfg.data, json: true, returnFullResponse: !!full });
  return full ? { data: r.body, status: r.statusCode, headers: r.headers } : r;
};
`;
    if (pdAxios) shims += "const axios = async ($, cfg) => __http(typeof $ === 'object' && $ && $.url ? $ : cfg);\n";
    if (npmAxios) shims += `const __axiosNpm = Object.assign((cfg) => __http(cfg, true), {
  request: (cfg) => __http(cfg, true),
  get: (url, cfg = {}) => __http({ ...cfg, url, method: 'GET' }, true),
  delete: (url, cfg = {}) => __http({ ...cfg, url, method: 'DELETE' }, true),
  post: (url, data, cfg = {}) => __http({ ...cfg, url, data, method: 'POST' }, true),
  put: (url, data, cfg = {}) => __http({ ...cfg, url, data, method: 'PUT' }, true),
  patch: (url, data, cfg = {}) => __http({ ...cfg, url, data, method: 'PATCH' }, true),
});
`;
    const code = `// Converted from Pipedream step "${step.ns}" by pdmigra.
${HELPERS}${shims}const __store = (name) => {
  const sd = $getWorkflowStaticData('global');
  sd[name] = sd[name] || {};
  const m = sd[name];
  return { get: async (k) => m[k], set: async (k, v) => { m[k] = v; }, has: async (k) => k in m,
    delete: async (k) => { delete m[k]; }, keys: async () => Object.keys(m),
    entries: async () => Object.entries(m).map(([key, value]) => ({ key, value })),
    clear: async () => { for (const k of Object.keys(m)) delete m[k]; } };
};
// ---- original code (imports adapted) ----
${body.trim()}
;
// ---- Pipedream-style execution ----
${stepsObjectJs(prev)}
const __exports = {};
let __response = null;
class __Exit extends Error {}
const __pd = {
  export: (k, v) => { __exports[k] = v; },
  respond: async (r) => { __response = r; },
  flow: { exit: (r) => { throw new __Exit(r || 'exit'); },
    delay: () => { throw new Error('$.flow.delay: use a Wait node'); },
    rerun: () => { throw new Error('$.flow.rerun has no n8n equivalent'); } },
};
const __ctx = ${props};
${[...apps].map((a) => `if (__ctx[${J(a)}] === undefined) __ctx[${J(a)}] = __app(${J(a)});`).join("\n")}
${stores.map((s) => `__ctx[${J(s)}] = __store(${J(s)});`).join("\n")}
let __ret;
try {
  __ret = await __component.run.call(__ctx, { steps, $: __pd });
} catch (e) {
  // A step that answered the webhook and then exited still has to send that answer before the flow stops.
  if (e instanceof __Exit) return __response ? [{ json: { __respond: __response, __exit: true } }] : [];
  throw e;
}
const { $summary, ...__exp } = __exports;
return [{ json: { $return_value: __ret === undefined ? null : __ret, ...__exp, ...(__response ? { __respond: __response } : {}) } }];
`;
    return { nodes: [{ parameters: { jsCode: code }, type: "n8n-nodes-base.code", typeVersion: 2 }], responds: /\$\.respond\(/.test(src), kind: "code", ok: !broken };
  }

  // ------------------------------------------------------------------ Python code steps

  function convertPy(step, prev, ctx) {
    const R = ctx.report;
    const src = step.code;
    R.manual.push(M.pythonBeta(step.ns));
    const mods = [...new Set([...src.matchAll(/^\s*(?:import|from)\s+([\w.]+)/gm)].map((m) => m[1]))].filter((m) => m !== "__future__");
    if (mods.length) R.manual.push(M.pyImports(step.ns, mods.join(", ")));
    for (const [k, v] of Object.entries(step.props || {})) {
      if (v && typeof v === "object" && "storeId" in v) R.manual.push([`step ${step.ns} (Python): data store '${k}' is not converted for Python steps yet; move that logic to a JavaScript step or an external database`,
        `paso ${step.ns} (Python): el data store '${k}' todavía no se convierte en pasos Python; pasar esa lógica a un paso JavaScript o a una base externa`]);
    }
    const apps = new Set();
    const prep = `// Prepares data for the Python step "${step.ns}" (n8n's native Python only sees input items). pdmigra.
${HELPERS}${stepsObjectJs(prev)}
return [{ json: { __steps: steps, __props: ${propsToJs(step.props, apps, ctx)} } }];
`;
    const py = `# Converted from Pipedream step "${step.ns}" by pdmigra.
class _Exit(Exception):
    pass

class _Flow:
    def exit(self, reason=None):
        raise _Exit(reason)

class _PD:
    def __init__(self, steps, inputs):
        self.steps, self.inputs, self.exports, self.response, self.flow = steps, inputs, {}, None, _Flow()
    def export(self, k, v):
        self.exports[k] = v
    def respond(self, r):
        self.response = r

# ---- original code ----
${src.trim()}

# ---- Pipedream-style execution ----
_in = _items[0]["json"] if _items else {}
_pd = _PD(_in.get("__steps", {}), _in.get("__props", {}))
try:
    _ret = handler(_pd)
except _Exit:
    return []
_out = {"$return_value": _ret, **_pd.exports}
_out.pop("$summary", None)
if _pd.response is not None:
    _out["__respond"] = _pd.response
return [{"json": _out}]
`;
    return {
      nodes: [
        { name: `prep_${step.ns}`, parameters: { jsCode: prep }, type: "n8n-nodes-base.code", typeVersion: 2 },
        { parameters: { language: "pythonNative", pythonCode: py }, type: "n8n-nodes-base.code", typeVersion: 2 },
      ],
      responds: /respond\(/.test(src), kind: "code", ok: true,
    };
  }

  // ------------------------------------------------------------------ pre-built actions

  // HTTP Request node calling the service API with the user's n8n credential for that service.
  function api(cred, method, url, opts = {}) {
    const p = { method, url, authentication: cred ? "predefinedCredentialType" : "none", options: {} };
    if (cred) p.nodeCredentialType = cred;
    if (opts.qs && opts.qs.length) { p.sendQuery = true; p.specifyQuery = "keypair"; p.queryParameters = { parameters: opts.qs }; }
    if (opts.headers && opts.headers.length) { p.sendHeaders = true; p.specifyHeaders = "keypair"; p.headerParameters = { parameters: opts.headers }; }
    if (opts.json !== undefined) { p.sendBody = true; p.contentType = "json"; p.specifyBody = "json"; p.jsonBody = opts.json; }
    if (opts.form) { p.sendBody = true; p.contentType = "form-urlencoded"; p.specifyBody = "keypair"; p.bodyParameters = { parameters: opts.form }; }
    return { parameters: p, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2 };
  }
  const q = (name, value) => ({ name, value });
  const ref = (v, ctx) => { const r = param(v, ctx); return typeof r === "string" && r.startsWith("=") ? r.slice(1) : String(r ?? ""); };
  // Inline a prop inside a URL: static values are URL-encoded, expressions stay as {{ }}.
  const seg = (v, ctx) => { const r = param(v, ctx); return typeof r === "string" && r.startsWith("=") ? r.slice(1) : encodeURIComponent(String(r ?? "")); };
  const url = (parts) => { const s = parts.join(""); return s.includes("{{") ? "=" + s : s; };

  function credNote(ctx, label, ns) { ctx.report.creds.add(`${label} (${ns})`); }

  function httpComponent(step, ctx, fallbackMethod) {
    const hr = step.props.httpRequest || step.props;
    const method = String(lv(hr.method) || fallbackMethod).toUpperCase();
    const live = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && x.name && !x.disabled).map((x) => q(x.name, param(x.value, ctx))) : []);
    const headers = live(hr.headers);
    const auth = hr.auth || {};
    if (auth.type === "bearer" && has(auth.token)) headers.push(q("Authorization", param("Bearer " + (lv(auth.token) || ""), ctx)));
    if (auth.type === "basic") ctx.report.manual.push([`step ${step.ns}: used Basic auth; add an HTTP Basic Auth credential to the node`,
      `paso ${step.ns}: usaba autenticación Basic; agregar una credencial HTTP Basic Auth al nodo`]);
    const opts = { qs: live(hr.params), headers };
    const b = hr.body || {};
    if (b.mode === "raw" && has(b.raw)) {
      // Raw JSON with {{ }} placeholders: quoted ones stay as text, bare ones become JSON values.
      const raw = String(lv(b.raw));
      const js = raw.replace(/("?)\{\{([\s\S]*?)\}\}("?)/g, (m, a, e, z) =>
        a && z ? `"{{ ${pdExprToN8nJs(e, ctx)} }}"` : `${a}{{ JSON.stringify(${pdExprToN8nJs(e, ctx)}) }}${z}`);
      opts.json = js.includes("{{") ? "=" + js : js;
    } else if (b.mode === "fields" || Array.isArray(b.fields)) {
      const f = (b.fields || []).filter((x) => x && x.name && !x.disabled);
      if (f.length) {
        if (/x-www-form-urlencoded/.test(b.contentType || "")) opts.form = f.map((x) => q(x.name, param(x.value, ctx)));
        else opts.json = exprObj(Object.fromEntries(f.map((x) => [x.name, x.value])), ctx);
      }
    } else if (has(step.props.data) || has(step.props.body)) {
      opts.json = param(step.props.data || step.props.body, ctx);
    }
    return api(null, method, param(lv(hr.url) || "", ctx), opts);
  }

  const GS = "https://sheets.googleapis.com/v4/spreadsheets/";
  function sheetRange(step, ctx, a1) {
    const title = lvLabel(step.props.worksheetId) || lv(step.props.sheetName);
    if (!title) ctx.report.manual.push(M.sheetTitle(step.ns));
    const t = title ? `'${String(title).replace(/'/g, "''")}'` : "";
    return encodeURIComponent(a1 ? (t ? `${t}!${a1}` : a1) : (t || "A1"));
  }
  const sheetId = (step, ctx) => seg(step.props.sheetId || step.props.spreadsheetId, ctx);

  function slackPost(step, ctx) {
    const P = step.props;
    credNote(ctx, "Slack (OAuth2)", step.ns);
    const body = { channel: P.conversation, text: P.text };
    if (has(P.mrkdwn)) body.mrkdwn = P.mrkdwn;
    if (has(P.thread_ts)) body.thread_ts = P.thread_ts;
    if (has(P.users) && !has(P.conversation)) body.channel = P.users;
    return api("slackOAuth2Api", "POST", "https://slack.com/api/chat.postMessage", { json: exprObj(body, ctx) });
  }

  const ACTIONS = {
    "http-get-request": (s, c) => httpComponent(s, c, "GET"),
    "http-post-request": (s, c) => httpComponent(s, c, "POST"),
    "http-put-request": (s, c) => httpComponent(s, c, "PUT"),
    "http-custom-request": (s, c) => httpComponent(s, c, "GET"),
    "http-return-http-response": (s, c) => {
      const P = s.props;
      const code = has(P.resStatusCode) ? param(P.resStatusCode, c) : 200;
      const opts = { responseCode: typeof code === "string" && /^\d+$/.test(code) ? Number(code) : code };
      if (has(P.resHeaders)) opts.responseHeaders = { entries: Object.entries(lv(P.resHeaders) || {}).map(([name, value]) => ({ name, value: param(value, c) })) };
      return { parameters: { respondWith: "json", responseBody: has(P.resBody) ? "={{ (() => { const b = " + valueToJs(P.resBody, c) + "; return typeof b === 'string' ? JSON.stringify(b) : b; })() }}" : "={}", options: opts },
        type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, isResponse: true };
    },
    "delay-workflow-delay": (s) => ({
      parameters: { resume: "timeInterval", amount: Number(lv(s.props.delayDurationValue)) || 1,
        unit: { seconds: "seconds", minutes: "minutes", hours: "hours", days: "days" }[String(lv(s.props.delayDurationUnit) || "minutes").toLowerCase()] || "minutes" },
      type: "n8n-nodes-base.wait", typeVersion: 1.1, webhookId: newId() }),

    // Google Sheets (raw Sheets API v4 responses, same as Pipedream returns)
    "google_sheets-add-single-row": (s, c) => { credNote(c, "Google Sheets", s.ns); return api("googleSheetsOAuth2Api", "POST",
      url([GS, sheetId(s, c), "/values/", sheetRange(s, c), ":append"]),
      { qs: [q("valueInputOption", "USER_ENTERED"), q("insertDataOption", "INSERT_ROWS")], json: "={{ ({ values: [" + asArrayJs(s.props.myColumnData, c) + "] }) }}" }); },
    "google_sheets-add-multiple-rows": (s, c) => { credNote(c, "Google Sheets", s.ns); return api("googleSheetsOAuth2Api", "POST",
      url([GS, sheetId(s, c), "/values/", sheetRange(s, c), ":append"]),
      { qs: [q("valueInputOption", "USER_ENTERED"), q("insertDataOption", "INSERT_ROWS")], json: "={{ ({ values: " + asArrayJs(s.props.rows, c) + " }) }}" }); },
    "google_sheets-get-values-in-range": (s, c) => { credNote(c, "Google Sheets", s.ns); return api("googleSheetsOAuth2Api", "GET",
      url([GS, sheetId(s, c), "/values/", has(s.props.range) && !String(lv(s.props.range)).includes("{{") ? sheetRange(s, c, lv(s.props.range)) : sheetRange(s, c)])); },
    "google_sheets-update-row": (s, c) => { credNote(c, "Google Sheets", s.ns); return api("googleSheetsOAuth2Api", "PUT",
      url([GS, sheetId(s, c), "/values/", sheetRange(s, c, "A"), seg(s.props.row, c)]),
      { qs: [q("valueInputOption", "USER_ENTERED")], json: "={{ ({ values: [" + asArrayJs(s.props.myColumnData, c) + "] }) }}" }); },

    // Slack
    "slack_v2-send-message": slackPost, "slack_v2-send-message-to-channel": slackPost, "slack_v2-send-message-to-user-or-group": slackPost,
    "slack_v2-send-message-advanced": slackPost, "slack_v2-reply-to-a-message": slackPost,
    "slack-send-message": slackPost, "slack-send-message-to-channel": slackPost, "slack-send-message-to-user-or-group": slackPost,
    "slack-reply-to-a-message": slackPost,

    // OpenAI chat: HTTP call + small node that rebuilds Pipedream's output shape
    "openai-chat": (s, c) => {
      credNote(c, "OpenAI", s.ns);
      const P = s.props;
      const msgs = "[" + (has(P.systemInstructions) ? `{ role: 'system', content: ${valueToJs(P.systemInstructions, c)} }, ` : "") +
        (has(P.messages) ? `...((m) => { try { return (Array.isArray(m) ? m : [m]).map((x) => (typeof x === 'string' ? JSON.parse(x) : x)); } catch (e) { return []; } })(${valueToJs(P.messages, c)}), ` : "") +
        `{ role: 'user', content: ${valueToJs(P.userMessage, c)} }]`;
      const body = "={{ ({ model: " + valueToJs(P.modelId || "gpt-4o-mini", c) + ", messages: " + msgs + (has(P.responseFormat) && lv(P.responseFormat) === "json_object" ? ", response_format: { type: 'json_object' }" : "") + " }) }}";
      return [
        Object.assign(api("openAiApi", "POST", "https://api.openai.com/v1/chat/completions", { json: body }), { name: `${s.ns}__api` }),
        { parameters: { jsCode: `// Rebuilds the output of Pipedream's "Chat" action. pdmigra.
const r = $input.first().json;
const msg = r.choices && r.choices[0] ? r.choices[0].message : null;
return [{ json: { $return_value: { ...r, generated_message: msg, original_messages_with_assistant_response: msg ? [msg] : [] } } }];` },
          type: "n8n-nodes-base.code", typeVersion: 2, kind: "code" },
      ];
    },

    // Gmail: build the MIME message, then call the Gmail API
    "gmail-send-email": (s, c) => {
      credNote(c, "Gmail", s.ns);
      const P = s.props;
      const fields = { to: P.to, cc: P.cc, bcc: P.bcc, subject: P.subject, body: P.body, bodyType: P.bodyType, fromName: P.fromName, replyTo: P.replyTo };
      return [
        { name: `${s.ns}__mime`, parameters: { jsCode: `// Builds the email for the Gmail API. pdmigra.
${HELPERS}${stepsObjectJs(c.prev)}
const f = ${propsToJs(fields, new Set(), c)};
const list = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
const enc = (t) => '=?UTF-8?B?' + Buffer.from(String(t), 'utf8').toString('base64') + '?=';
const lines = [];
if (f.fromName) lines.push('From: ' + enc(f.fromName) + ' <me>');
lines.push('To: ' + list(f.to));
if (f.cc) lines.push('Cc: ' + list(f.cc));
if (f.bcc) lines.push('Bcc: ' + list(f.bcc));
if (f.replyTo) lines.push('Reply-To: ' + f.replyTo);
lines.push('Subject: ' + enc(f.subject || ''));
lines.push('MIME-Version: 1.0');
lines.push('Content-Type: ' + (f.bodyType === 'html' ? 'text/html' : 'text/plain') + '; charset=UTF-8');
lines.push('Content-Transfer-Encoding: base64', '', Buffer.from(String(f.body || ''), 'utf8').toString('base64'));
const raw = Buffer.from(lines.join('\\r\\n'), 'utf8').toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
return [{ json: { raw } }];` }, type: "n8n-nodes-base.code", typeVersion: 2 },
        api("gmailOAuth2", "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { json: "={{ ({ raw: $json.raw }) }}" }),
      ];
    },

    // Airtable
    "airtable_oauth-create-single-record": (s, c) => { credNote(c, "Airtable (personal access token)", s.ns); return api("airtableTokenApi", "POST",
      url(["https://api.airtable.com/v0/", seg(s.props.baseId, c), "/", seg(s.props.tableId, c)]),
      { json: "={{ ({ fields: " + recordJs(s.props.record, c) + (has(s.props.typecast) ? ", typecast: " + valueToJs(s.props.typecast, c) : "") + " }) }}" }); },
    "airtable_oauth-update-record": (s, c) => { credNote(c, "Airtable (personal access token)", s.ns); return api("airtableTokenApi", "PATCH",
      url(["https://api.airtable.com/v0/", seg(s.props.baseId, c), "/", seg(s.props.tableId, c), "/", seg(s.props.recordId, c)]),
      { json: "={{ ({ fields: " + recordJs(s.props.record, c) + (has(s.props.typecast) ? ", typecast: " + valueToJs(s.props.typecast, c) : "") + " }) }}" }); },
    "airtable_oauth-list-records": (s, c) => { credNote(c, "Airtable (personal access token)", s.ns); c.report.review.push(M.pagination(s.ns));
      const qs = [];
      if (has(s.props.filterByFormula)) qs.push(q("filterByFormula", param(s.props.filterByFormula, c)));
      if (has(s.props.maxRecords)) qs.push(q("maxRecords", param(s.props.maxRecords, c)));
      return api("airtableTokenApi", "GET", url(["https://api.airtable.com/v0/", seg(s.props.baseId, c), "/", seg(s.props.tableId, c)]), { qs }); },

    // Telegram (token in the URL, as the Bot API requires)
    "telegram_bot_api-send-text-message-or-reply": (s, c) => {
      c.report.vars.add("TELEGRAM_BOT_TOKEN  (telegram_bot_api)");
      const P = s.props;
      const body = { chat_id: P.chatId, text: P.text };
      for (const k of ["parse_mode", "disable_notification", "reply_to_message_id", "reply_markup"]) if (has(P[k])) body[k] = P[k];
      return api(null, "POST", "=https://api.telegram.org/bot{{ $vars.TELEGRAM_BOT_TOKEN }}/sendMessage", { json: exprObj(body, c) });
    },

    // Discord (webhook URL lives in the Pipedream connected account)
    "discord-send-message": (s, c) => {
      c.report.vars.add("DISCORD_WEBHOOK_URL  (discord)");
      const P = s.props;
      const body = { content: P.message };
      if (has(P.username)) body.username = P.username;
      if (has(P.avatarURL)) body.avatar_url = P.avatarURL;
      return api(null, "POST", "={{ $vars.DISCORD_WEBHOOK_URL }}", { json: exprObj(body, c) });
    },

    // GitHub
    "github-create-issue": (s, c) => { credNote(c, "GitHub", s.ns); const P = s.props;
      const body = { title: P.title };
      if (has(P.body)) body.body = P.body;
      if (has(P.labels)) body.labels = P.labels;
      if (has(P.assignees)) body.assignees = P.assignees;
      if (has(P.milestoneNumber)) body.milestone = P.milestoneNumber;
      return api("githubApi", "POST", url(["https://api.github.com/repos/", ref(P.repoFullname, c), "/issues"]), { json: exprObj(body, c) }); },
    "github-create-issue-comment": (s, c) => { credNote(c, "GitHub", s.ns); const P = s.props;
      return api("githubApi", "POST", url(["https://api.github.com/repos/", ref(P.repoFullname, c), "/issues/", seg(P.issueNumber, c), "/comments"]), { json: exprObj({ body: P.body }, c) }); },

    // Microsoft 365
    "microsoft_outlook-send-email": (s, c) => { credNote(c, "Microsoft Outlook", s.ns); const P = s.props;
      const addr = (v) => `(${asArrayJs(v, c)}).filter(Boolean).map((a) => ({ emailAddress: { address: a } }))`;
      const body = "={{ ({ message: { subject: " + valueToJs(P.subject || "", c) + ", body: { contentType: " + valueToJs(P.contentType || "text", c) +
        ", content: " + valueToJs(P.content || "", c) + " }, toRecipients: " + addr(P.recipients) + (has(P.ccRecipients) ? ", ccRecipients: " + addr(P.ccRecipients) : "") +
        (has(P.bccRecipients) ? ", bccRecipients: " + addr(P.bccRecipients) : "") + " }, saveToSentItems: true }) }}";
      return api("microsoftOutlookOAuth2Api", "POST", "https://graph.microsoft.com/v1.0/me/sendMail", { json: body }); },
    "microsoft_teams-send-channel-message": (s, c) => { credNote(c, "Microsoft Teams", s.ns); const P = s.props;
      return api("microsoftTeamsOAuth2Api", "POST", url(["https://graph.microsoft.com/v1.0/teams/", seg(P.teamId, c), "/channels/", seg(P.channelId, c), "/messages"]),
        { json: exprObj({ body: { contentType: lv(P.contentType) || "text", content: P.message } }, c) }); },
    "microsoft_teams-send-chat-message": (s, c) => { credNote(c, "Microsoft Teams", s.ns); const P = s.props;
      return api("microsoftTeamsOAuth2Api", "POST", url(["https://graph.microsoft.com/v1.0/chats/", seg(P.chatId, c), "/messages"]),
        { json: exprObj({ body: { contentType: lv(P.contentType) || "text", content: P.message } }, c) }); },

    // Google Calendar
    "google_calendar-list-events": (s, c) => { credNote(c, "Google Calendar", s.ns); const P = s.props;
      const qs = [];
      for (const k of ["timeMin", "timeMax", "q", "maxResults", "orderBy", "singleEvents", "showDeleted", "timeZone", "updatedMin", "iCalUID"]) if (has(P[k])) qs.push(q(k, param(P[k], c)));
      return api("googleCalendarOAuth2Api", "GET", url(["https://www.googleapis.com/calendar/v3/calendars/", seg(P.calendarId || "primary", c), "/events"]), { qs }); },
    "google_calendar-create-event": (s, c) => { credNote(c, "Google Calendar", s.ns); const P = s.props;
      const when = (v) => `((d) => (/^\\d{4}-\\d{2}-\\d{2}$/.test(String(d)) ? { date: d } : { dateTime: d, timeZone: ${valueToJs(P.timeZone || "UTC", c)} }))(${valueToJs(P.eventStartDate === v ? P.eventStartDate : v, c)})`;
      const body = "={{ " + CLEAN + "({ summary: " + valueToJs(P.summary || "", c) + ", location: " + valueToJs(P.location || null, c) + ", description: " + valueToJs(P.description || null, c) +
        ", start: " + when(P.eventStartDate) + ", end: " + when(P.eventEndDate) +
        (has(P.attendees) ? ", attendees: (" + asArrayJs(P.attendees, c) + ").map((e) => ({ email: e }))" : "") + " }) }}";
      const qs = has(P.sendUpdates) ? [q("sendUpdates", param(P.sendUpdates, c))] : [];
      return api("googleCalendarOAuth2Api", "POST", url(["https://www.googleapis.com/calendar/v3/calendars/", seg(P.calendarId || "primary", c), "/events"]), { qs, json: body }); },

    // SendGrid
    "sendgrid-send-email-single-recipient": (s, c) => { credNote(c, "SendGrid", s.ns); const P = s.props;
      const pers = { to: [{ email: P.toEmail, name: P.toName }] };
      const body = { personalizations: [pers], from: { email: P.fromEmail, name: P.fromName }, subject: P.subject,
        content: [{ type: "text/html", value: P.content }] };
      if (has(P.templateId)) { body.template_id = P.templateId; delete body.content; }
      if (has(P.dynamicTemplateData)) pers.dynamic_template_data = P.dynamicTemplateData;
      return api("sendGridApi", "POST", "https://api.sendgrid.com/v3/mail/send", { json: exprObj(body, c) }); },

    // Postgres: native node + node that gathers rows like Pipedream returned them
    "postgresql-execute-custom-query": (s, c) => { credNote(c, "Postgres", s.ns); return [
      { name: `${s.ns}__query`, parameters: { operation: "executeQuery", query: param(sqlText(s.props.sql), c), options: {} }, type: "n8n-nodes-base.postgres", typeVersion: 2.5, alwaysOutputData: true },
      { parameters: { jsCode: "// Gathers the rows into one result, as Pipedream returned it. pdmigra.\nconst rows = $input.all().map((i) => i.json).filter((r) => Object.keys(r).length);\nreturn [{ json: { $return_value: rows } }];" },
        type: "n8n-nodes-base.code", typeVersion: 2, kind: "code" }]; },

    // Supabase REST (project URL as a variable; credential adds the API key)
    "supabase-insert-row": (s, c) => { credNote(c, "Supabase", s.ns); c.report.vars.add("SUPABASE_URL  (supabase)");
      return api("supabaseApi", "POST", url(["={{ $vars.SUPABASE_URL }}/rest/v1/", ref(s.props.table, c)].map(String)).replace(/^==/, "="),
        { headers: [q("Prefer", "return=representation")], json: param(s.props.data, c) }); },
    "supabase-select-row": (s, c) => { credNote(c, "Supabase", s.ns); c.report.vars.add("SUPABASE_URL  (supabase)"); const P = s.props;
      const qs = [];
      if (has(P.column) && has(P.value)) qs.push(q(ref(P.column, c), "=" + (lv(P.filter) || "eq") + "." + ref(P.value, c)));
      if (has(P.orderBy)) qs.push(q("order", "=" + ref(P.orderBy, c) + "." + (lv(P.sortOrder) || "asc")));
      if (has(P.max)) qs.push(q("limit", param(P.max, c)));
      return api("supabaseApi", "GET", url(["={{ $vars.SUPABASE_URL }}/rest/v1/", ref(P.table, c)].map(String)).replace(/^==/, "="), { qs }); },

    // Twilio
    "twilio-send-sms": (s, c) => { credNote(c, "Twilio", s.ns); c.report.vars.add("TWILIO_ACCOUNT_SID  (twilio)"); const P = s.props;
      return api("twilioApi", "POST", "=https://api.twilio.com/2010-04-01/Accounts/{{ $vars.TWILIO_ACCOUNT_SID }}/Messages.json",
        { form: [q("From", param(P.from, c)), q("To", param(P.to, c)), q("Body", param(P.body, c))] }); },

    // Snowflake: native node + gather rows
    "snowflake-execute-sql-query": (s, c) => { credNote(c, "Snowflake", s.ns); return [
      { name: `${s.ns}__query`, parameters: { operation: "executeQuery", query: param(sqlText(s.props.sql), c) }, type: "n8n-nodes-base.snowflake", typeVersion: 1, alwaysOutputData: true },
      { parameters: { jsCode: "// Gathers the rows into one result, as Pipedream returned it. pdmigra.\nconst rows = $input.all().map((i) => i.json).filter((r) => Object.keys(r).length);\nreturn [{ json: { $return_value: rows } }];" },
        type: "n8n-nodes-base.code", typeVersion: 2, kind: "code" }]; },

    // Email to yourself
    "email-send-email-to-self": (s, c) => { c.report.manual.push(M.emailSelf(s.ns)); c.report.vars.add("MY_EMAIL  (email)"); const P = s.props;
      return { parameters: { fromEmail: "={{ $vars.MY_EMAIL }}", toEmail: "={{ $vars.MY_EMAIL }}", subject: param(P.subject || "", c),
        emailFormat: has(P.html) ? "html" : "text", ...(has(P.html) ? { html: param(P.html, c) } : { text: param(P.text || "", c) }), options: {} },
        type: "n8n-nodes-base.emailSend", typeVersion: 2.1, webhookId: newId() }; },
  };

  // Data stores: re-implemented on the workflow's static data.
  const DS = {
    "data_stores-get-record": "return m[key];",
    "data_stores-add-update-record": "m[key] = value; return value;",
    "data_stores-append-to-record": "m[key] = [].concat(m[key] === undefined ? [] : m[key], value); return m[key];",
    "data_stores-delete-single-record": "const had = key in m; delete m[key]; return had;",
    "data_stores-delete-all-records": "for (const k of Object.keys(m)) delete m[k]; return true;",
    "data_stores-get-all-records": "return { ...m };",
    "data_stores-list-keys": "return Object.keys(m);",
    "data_stores-list-records": "return Object.entries(m).map(([key, value]) => ({ key, value }));",
    "data_stores-get-record-keys": "return Object.keys(m);",
    "data_stores-has-key-or-create": "if (key in m) return true; if (P.addRecordIfNotFound === 'Yes' || P.addRecordIfNotFound === true) m[key] = value; return false;",
    "data_stores-get-record-or-create": "if (key in m) return m[key]; if (P.addRecordIfNotFound === 'Yes' || P.addRecordIfNotFound === true) m[key] = value; return m[key];",
    "data_stores-add-update-multiple-records": "const d = typeof P.data === 'string' ? JSON.parse(P.data) : P.data || {}; Object.assign(m, d); return d;",
  };
  for (const [k, logic] of Object.entries(DS)) {
    ACTIONS[k] = (s, c) => {
      const name = lvLabel(s.props.dataStore) || (lv(s.props.dataStore) && typeof lv(s.props.dataStore) === "string" ? lv(s.props.dataStore) : "data_store");
      c.report.manual.push(M.dataStore(s.ns, name));
      const props = { ...s.props }; delete props.dataStore;
      return { parameters: { jsCode: `// Pipedream data store action "${k}" re-implemented on n8n static data. pdmigra.
${HELPERS}${stepsObjectJs(c.prev)}
const P = ${propsToJs(props, new Set(), c)};
const sd = $getWorkflowStaticData('global');
sd[${J(String(name))}] = sd[${J(String(name))}] || {};
const m = sd[${J(String(name))}];
const key = P.key; let value = P.value;
if (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) {} }
const out = (() => { ${logic} })();
return [{ json: { $return_value: out === undefined ? null : out } }];` }, type: "n8n-nodes-base.code", typeVersion: 2, kind: "code" };
    };
  }

  function recordJs(record, ctx) {
    const r = lv(record);
    if (typeof r === "string") return `((v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return v; } })(${valueToJs(r, ctx)})`;
    return valueToJs(r || {}, ctx);
  }

  function convertComponent(step, ctx) {
    const fn = ACTIONS[step.component];
    if (fn) {
      const r = fn(step, ctx);
      const nodes = Array.isArray(r) ? r : [r];
      const last = nodes[nodes.length - 1];
      const kind = last.kind || "raw";
      for (const n of nodes) delete n.kind;
      const responds = nodes.some((n) => n.isResponse);
      for (const n of nodes) delete n.isResponse;
      return { nodes, responds, kind, ok: true };
    }
    ctx.report.manual.push(M.unsupported(step.ns, step.component, step.version));
    const lines = Object.entries(step.props).map(([k, v]) => `//   ${k}: ${J(v).slice(0, 200)}`).join("\n");
    return { nodes: [{ parameters: { jsCode: `// Step "${step.ns}" used the Pipedream action ${step.component}@${step.version}.\n// pdmigra does not convert it automatically yet. Configured props:\n${lines}\nthrow new Error('Step pending manual conversion: ${step.component}');\n` },
      type: "n8n-nodes-base.code", typeVersion: 2 }], responds: false, kind: "raw", ok: false };
  }

  // ------------------------------------------------------------------ triggers (+ adapter that recreates Pipedream's event)

  function convertTrigger(trig, responds, ctx) {
    const R = ctx.report;
    const c = trig.config || {};
    let node, adapter;
    if (trig.type === "http") {
      node = { name: "webhook", parameters: { httpMethod: "POST", path: newId(), responseMode: responds ? "responseNode" : "onReceived", options: {} },
        type: "n8n-nodes-base.webhook", typeVersion: 2, webhookId: newId() };
      adapter = "const j = $input.first().json;\nreturn [{ json: { method: 'POST', path: '/', query: j.query || {}, headers: j.headers || {}, body: j.body, url: j.webhookUrl, __context: { ts: new Date().toISOString(), id: $execution.id, workflow_id: $workflow.id } } }];";
    } else if (trig.type === "timer") {
      const t = c.timer || c;
      const cron = t.cron, secs = t.interval_seconds;
      if (!cron && !secs) R.manual.push(M.trigSchedule());
      node = { name: "schedule", parameters: { rule: { interval: [cron ? { field: "cronExpression", expression: cron } : secs ? { field: "seconds", secondsInterval: Number(secs) } : {}] } },
        type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2 };
      adapter = `const now = new Date();
const tz = ${J(t.timezone || "UTC")};
const fmt = (d) => ({ iso8601: { timestamp: d.toISOString() }, timezone: 'UTC' });
return [{ json: { timestamp: Math.floor(now.getTime() / 1000), interval_seconds: ${J(secs || null)}, cron: ${J(cron || null)},
  timezone_configured: { ...fmt(now), timezone: tz }, timezone_utc: fmt(now), __context: { ts: now.toISOString(), id: $execution.id, workflow_id: $workflow.id } } }];`;
    } else {
      if (trig.type === "email") R.manual.push(M.trigEmail());
      else if (trig.type === "source") R.manual.push(M.trigSource(c.key || c.component_key || "source"));
      else R.manual.push(M.trigUnknown());
      node = { name: "start", parameters: {}, type: "n8n-nodes-base.manualTrigger", typeVersion: 1 };
      adapter = `const now = new Date();\nconst fmt = (d) => ({ iso8601: { timestamp: d.toISOString() }, timezone: 'UTC' });\nreturn [{ json: { ...($input.first()?.json || {}), timestamp: Math.floor(now.getTime() / 1000), timezone_configured: fmt(now), timezone_utc: fmt(now), __context: { ts: now.toISOString(), id: $execution.id, workflow_id: $workflow.id } } }];`;
    }
    return [node, { name: "trigger", parameters: { jsCode: "// Recreates the shape of Pipedream's trigger event (steps.trigger.event). pdmigra.\n" + adapter }, type: "n8n-nodes-base.code", typeVersion: 2 }];
  }

  // ------------------------------------------------------------------ whole workflow

  function convertWorkflow(wf, files) {
    const report = newReport();
    const ctx = { report, files, kinds: {}, prev: [] };
    const body = [];
    let ok = 0, respondsAt = null;
    for (const step of wf.steps) {
      const r = step.kind === "code" ? (step.lang === "python" ? convertPy(step, ctx.prev, ctx) : convertJs(step, ctx.prev, ctx)) : convertComponent(step, ctx);
      r.nodes.forEach((n, i) => { if (!n.name || i === r.nodes.length - 1) n.name = n.name && i < r.nodes.length - 1 ? n.name : step.ns; n.id = newId(); body.push(n); });
      ctx.kinds[step.ns] = r.kind;
      ctx.prev.push(step.ns);
      ok += r.ok ? 1 : 0;
      if (r.responds && respondsAt === null) respondsAt = { ns: step.ns, native: r.nodes.some((n) => n.type === "n8n-nodes-base.respondToWebhook") };
    }
    // warn when later steps read fields of a raw API response
    wf.steps.forEach((s, i) => {
      if (ctx.kinds[s.ns] !== "raw" || s.kind !== "component") return;
      const later = wf.steps.slice(i + 1).map((x) => (x.code || "") + J(x.props || {})).join("\n");
      const uses = [...new Set([...later.matchAll(new RegExp(`steps\\.${s.ns}(?:\\.\\$return_value|\\["\\$return_value"\\])?((?:\\.[\\w$]+|\\[[^\\]]+\\])+)`, "g"))].map((m) => m[1]))].slice(0, 4);
      if (uses.length) report.review.push(M.shape(s.ns, uses.map((u) => "steps." + s.ns + u).join(", ")));
    });
    const trig = convertTrigger(wf.triggers[0] || { type: "unknown", config: {} }, respondsAt !== null, ctx);
    if (wf.triggers.length > 1) report.manual.push(M.trigMany(wf.triggers.length));
    trig.forEach((n) => { n.id = newId(); });
    const nodes = trig.concat(body);
    if (respondsAt && !respondsAt.native && trig[0].type === "n8n-nodes-base.webhook") {
      const idx = nodes.findIndex((n) => n.name === respondsAt.ns);
      nodes.splice(idx + 1, 0, { name: `respond_${respondsAt.ns}`, id: newId(), type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1,
        parameters: { respondWith: "json", responseBody: "={{ JSON.stringify($json.__respond?.body ?? $json.__respond ?? {}) }}",
          options: { responseCode: "={{ $json.__respond?.status ?? 200 }}" } } },
      // stops here when the step called $.flow.exit after responding
      { name: `continue_${respondsAt.ns}`, id: newId(), type: "n8n-nodes-base.code", typeVersion: 2,
        parameters: { jsCode: "// Pipedream's $.flow.exit after $.respond: the answer was sent, the workflow stops here. pdmigra.\nreturn $input.all().filter((i) => !i.json.__exit);" } });
    }
    nodes.forEach((n, i) => { n.position = [i * X, 300]; });
    const connections = {};
    for (let i = 0; i < nodes.length - 1; i++) connections[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: "main", index: 0 }]] };
    const n8n = { name: wf.name, nodes, connections, active: false, settings: { executionOrder: "v1" }, pinData: {},
      meta: { pdmigra: { source: wf.source, converted: new Date().toISOString() } } };
    return { name: wf.name, fileName: (String(wf.name).replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "workflow") + ".n8n.json",
      n8n, report, coverage: wf.steps.length ? ok / wf.steps.length : 1, inactive: wf.inactive, steps: wf.steps.length };
  }

  function reportMarkdown(results, lang = "en") {
    const t = T[lang] || T.en;
    const pick = (m) => (Array.isArray(m) ? m[lang === "es" ? 1 : 0] : m);
    const out = [`# ${t.title}`, ""];
    for (const r of results) {
      const R = r.report;
      out.push(`## ${r.name}`, `- ${t.steps}: ${r.steps} | ${t.auto}: ${Math.round(r.coverage * 100)}%`);
      if (r.inactive) out.push(`- ${t.inactive}`);
      if (R.creds.size) out.push(`- ${t.connect}: ` + [...R.creds].sort().join("; "));
      if (R.vars.size) out.push(`- ${t.vars}: ` + [...R.vars].sort().join("; "));
      if (R.npm.size) out.push(`- ${t.npm}${[...R.npm].sort().join(",")})`);
      for (const m of R.manual) out.push(`- ${t.manual}: ${pick(m)}`);
      for (const m of R.review) out.push(`- ${t.review}: ${pick(m)}`);
      out.push("");
    }
    return out.join("\n");
  }

  function convert(files, opts) {
    const yamlLoad = opts && opts.yamlLoad;
    const isSync = Object.keys(files).some((p) => /(^|\/)workflow\.yaml$/.test(p));
    if (isSync && !yamlLoad) throw new Error("A YAML parser is required for GitHub Sync folders");
    // An upload can mix both formats (a GitHub Sync repo plus exported JSON files).
    const wfs = (isSync ? readGithubSync(files, yamlLoad) : []).concat(readExport(files));
    const exported = wfs.length - (isSync ? readGithubSync(files, yamlLoad).length : 0);
    const workflows = wfs.map((w) => convertWorkflow(w, files));
    const cov = workflows.length ? workflows.reduce((a, w) => a + w.coverage, 0) / workflows.length : 0;
    const format = isSync && exported ? "mixed" : isSync ? "github-sync" : "export";
    return { workflows, summary: { format, count: workflows.length, coverage: cov,
      fullyAutomatic: workflows.filter((w) => w.coverage === 1).length }, reportMarkdown: (lang) => reportMarkdown(workflows, lang) };
  }

  return { convert, supportedActions: () => Object.keys(ACTIONS).sort(), version: "0.2.0" };
});
