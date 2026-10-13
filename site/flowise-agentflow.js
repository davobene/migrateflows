/*
 * Agentflow v2 (Flowise 3.x) → n8n. Plugs into flowise-core.js via flowmigra.registerAgentflowV2.
 * Agentflow v2 is a control-flow graph (Start → LLM/Agent/Condition/HTTP/... nodes), so each node becomes a main
 * n8n node, and models, memory and tools become AI sub-nodes.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else if (root.flowmigra) factory(root.flowmigra);
})(typeof self !== "undefined" ? self : this, function (flowmigra) {
  "use strict";
  const X = flowmigra._internal;
  const { findStore, storeRetrieval, Builder, MODELS, EMBEDDINGS, VSTORES, htmlToText, clean, num, str, bool, slug, rl, parseJSON, newId, LC, NB } = X;
  const TRIGGER = "When chat message received";
  const FORM = "Start form";
  const STATE = "Flow state";

  function convertAgentflowV2(flow, ctx) {
    const b = new Builder(flow.name);
    const report = [];
    const creds = new Map();
    const note = (level, key, args) => report.push({ level, key, args: args || {} });
    const addCred = (cred, nodeName) => { if (cred) creds.set(cred + "|" + nodeName, { cred, node: nodeName }); };
    const nodes = {};
    for (const n of flow.nodes) nodes[n.id] = n;
    const label = (n) => str(n.data && n.data.label) || n.id;
    const inp = (n) => (n.data && n.data.inputs) || {};
    const kind = (n) => n.data && n.data.name;
    const out = {}; // flowise id -> { node (n8n), field }
    const stateExpr = {}; // state key -> n8n expression (without braces)
    let total = 0, mapped = 0;
    const extraBuilders = [];
    const addIngest = (r, store) => { if (r.ingest && !ctx.storeIngests[store.id]) { ctx.storeIngests[store.id] = true; extraBuilders.push(r.ingest); } };
    const real = flow.nodes.filter((n) => n.data && !/stickyNote/.test(kind(n)));
    total = real.length;

    const start = flow.nodes.find((n) => kind(n) === "startAgentflow");
    const si = start ? inp(start) : {};
    const isForm = si.startInputType === "formInput";
    const formFields = (Array.isArray(si.formInputTypes) ? si.formInputTypes : []).filter((f) => f && (f.name || f.label));
    const questionExpr = isForm ? `JSON.stringify($('${FORM}').item.json)` : `$('${TRIGGER}').item.json.chatInput`;
    const sessionExpr = `$('${TRIGGER}').item.json.sessionId`;

    // ---- variable mentions → n8n expressions
    function jsRef(v, self) {
      v = v.trim();
      if (v === "question") return questionExpr;
      if (v === "chat_history") return "''";
      if (v === "current_date_time") return "$now.toISO()";
      if (v === "runtime_messages_length") return "$runIndex";
      if (v === "file_attachment") return "''";
      let m;
      if ((m = /^\$flow\.state\.([\w$]+)(.*)$/.exec(v))) return (stateExpr[m[1]] || `$('${STATE}').item.json.${m[1]}`) + m[2];
      if ((m = /^\$form\.([\w$]+)(.*)$/.exec(v))) {
        const f = formFields.find((x) => x.name === m[1]);
        return `$('${FORM}').item.json[${JSON.stringify(f ? f.label || f.name : m[1])}]` + m[2];
      }
      if ((m = /^\$iteration(\.(.+))?$/.exec(v))) return m[2] ? `$json.${m[2]}` : "JSON.stringify($json)";
      if (/^\$vars\./.test(v)) return v;
      if ((m = /^output(\.(.+))?$/.exec(v)) && self) return `$('${self.node.name}').item.json.${self.field}` + (m[2] ? "." + m[2] : "");
      if ((m = /^([A-Za-z]+Agentflow_\d+)(\.output)?(\.(.+))?$/.exec(v)) && out[m[1]]) {
        const o = out[m[1]];
        return `$('${o.node.name}').item.json.${o.field}` + (m[4] ? "." + m[4] : "");
      }
      return null;
    }
    function tx(text, self) {
      const t = htmlToText(text);
      return t.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, v) => { const r = jsRef(v, self); return r ? `{{ ${r} }}` : m; });
    }
    const ex = (t) => (t.includes("{{") ? "=" + t : t);

    function model(name, cfg, parent) {
      const f = MODELS[name];
      if (!f) { note("manual", "unsupported", { label: name, name }); return null; }
      const m = f(Object.assign({}, cfg || {}));
      const node = b.add(m.label, LC + m.type, m.v, m.params);
      addCred(m.cred, node.name);
      b.link(node, parent, "ai_languageModel");
      return node;
    }
    function memory(parent, size) {
      if (isForm) return;
      const node = b.add("Simple Memory", LC + "memoryBufferWindow", 1.3, { sessionIdType: "customKey", sessionKey: `={{ ${sessionExpr} }}`, contextWindowLength: num(size) || 10 });
      b.link(node, parent, "ai_memory");
    }
    function messagesToSystem(msgs) {
      return (Array.isArray(msgs) ? msgs : []).filter((m) => /system|developer/.test(str(m.role))).map((m) => tx(m.content)).join("\n\n");
    }
    function userMessage(msgs, explicit) {
      if (str(explicit).trim()) return tx(explicit);
      const u = (Array.isArray(msgs) ? msgs : []).filter((m) => m.role === "user").map((m) => tx(m.content)).join("\n\n");
      return u || `{{ ${questionExpr} }}`;
    }
    function structuredSchema(rows) {
      const props = {};
      for (const r of rows || []) {
        if (!r || !r.key) continue;
        const ty = str(r.type);
        let s;
        if (ty === "enum") s = { type: "string", enum: str(r.enumValues).split(",").map((x) => x.trim()).filter(Boolean) };
        else if (ty === "stringArray") s = { type: "array", items: { type: "string" } };
        else if (ty === "number") s = { type: "number" };
        else if (ty === "boolean") s = { type: "boolean" };
        else if (ty === "jsonArray") { const inner = parseJSON(r.jsonSchema, {}) || {}; s = { type: "array", items: { type: "object", properties: inner, required: Object.keys(inner) } }; }
        else s = { type: "string" };
        if (r.description) s.description = str(r.description);
        props[r.key] = s;
      }
      return { type: "object", properties: props, required: Object.keys(props) };
    }
    function updateState(list, self) {
      for (const u of Array.isArray(list) ? list : []) if (u && u.key) {
        const t = tx(u.value, self);
        const m = /^\{\{ (.+) \}\}$/.exec(t.trim());
        stateExpr[u.key] = m ? m[1] : JSON.stringify(t);
      }
    }

    // ---- tools for agent nodes
    function agentTool(t, agent) {
      const name = str(t.agentSelectedTool);
      const cfg = t.agentSelectedToolConfig || {};
      if (name === "calculator") return b.link(b.add("Calculator", LC + "toolCalculator", 1, {}), agent, "ai_tool");
      if (/^requests(Get|Post|Put|Delete)$/.test(name)) {
        const method = name.replace("requests", "").toUpperCase();
        const pre = "requests" + name.replace("requests", "");
        const url = htmlToText(cfg[pre + "Url"]);
        const p = { toolDescription: str(cfg[pre + "Description"]) || `${method} ${url}`, method, url: url || "={{ $fromAI('url', 'URL', 'string') }}", options: {} };
        const hdr = parseJSON(cfg[pre + "Headers"], null);
        if (hdr && typeof hdr === "object" && Object.keys(hdr).length) Object.assign(p, { sendHeaders: true, specifyHeaders: "json", jsonHeaders: JSON.stringify(hdr) });
        if (method !== "GET" && method !== "DELETE") Object.assign(p, { sendBody: true, specifyBody: "json", jsonBody: "={{ $fromAI('body', 'JSON body for the request', 'string') }}" });
        const node = b.add(str(cfg[pre + "Name"]) || label({ data: { label: name } }), NB + "httpRequestTool", 4.2, p);
        note("adjust", "httpTool", { label: node.name, cred: "—" });
        return b.link(node, agent, "ai_tool");
      }
      const search = { googleCustomSearch: ["https://www.googleapis.com/customsearch/v1", "q", "httpQueryAuth"], serper: ["https://google.serper.dev/search", "q", "httpHeaderAuth", true], tavilyAPI: ["https://api.tavily.com/search", "query", "httpHeaderAuth", true], braveSearchAPI: ["https://api.search.brave.com/res/v1/web/search", "q", "httpHeaderAuth"], searchAPI: ["https://www.searchapi.io/api/v1/search", "q", "httpQueryAuth"], exaSearch: ["https://api.exa.ai/search", "query", "httpHeaderAuth", true] }[name];
      if (search) {
        const p = { toolDescription: `Web search (${name}). Input: the search query.`, method: search[3] ? "POST" : "GET", url: search[0], authentication: "genericCredentialType", genericAuthType: search[2], options: {} };
        if (search[3]) Object.assign(p, { sendBody: true, specifyBody: "json", jsonBody: `={ "${search[1]}": "{{ $fromAI('query', 'search query', 'string') }}" }` });
        else Object.assign(p, { sendQuery: true, queryParameters: { parameters: [{ name: search[1], value: "={{ $fromAI('query', 'search query', 'string') }}" }] } });
        const node = b.add(name, NB + "httpRequestTool", 4.2, p);
        note("adjust", "httpTool", { label: name, cred: search[2] });
        return b.link(node, agent, "ai_tool");
      }
      if (name === "customTool") {
        const stored = ctx.tools[str(cfg.selectedTool)] || {};
        const fake = { id: "ct", data: { name: "customTool", label: stored.name || "Custom Tool", inputs: { selectedTool: cfg.selectedTool, customToolName: stored.name, customToolDesc: stored.description, customToolSchema: stored.schema, customToolFunc: stored.func } } };
        return customToolNode(fake, agent);
      }
      if (/MCP$/i.test(name) || name === "customMCP") {
        const c = parseJSON(cfg.mcpServerConfig, {}) || {};
        const url = str(c.url || cfg.url);
        const node = b.add(name, LC + "mcpClientTool", 1.2, clean({ endpointUrl: url || "http://localhost:8000/mcp", serverTransport: /sse/i.test(url) ? "sse" : "httpStreamable", include: "all" }));
        if (!url) note("manual", "mcpStdio", { label: name });
        return b.link(node, agent, "ai_tool");
      }
      if (name === "chatflowTool" || name === "agentflowTool") {
        const node = b.add(str(cfg.name) || name, LC + "toolWorkflow", 2.1, { description: str(cfg.description) || name, workflowId: { __rl: true, mode: "list", value: "" } });
        note("manual", "executeFlow", { label: node.name });
        return b.link(node, agent, "ai_tool");
      }
      note("manual", "v2Tool", { tool: name, label: agent.name });
    }
    function customToolNode(fake, agent) {
      // Reuse the chatflow converter's custom-tool translation through a tiny one-node chatflow.
      const res = flowmigra.convert({ "t.json": JSON.stringify({ nodes: [{ id: "toolAgent_0", data: { name: "toolAgent", category: "Agents", label: "a", inputs: { tools: ["{{ct.data.instance}}"] } } }, Object.assign({}, fake, { data: Object.assign({}, fake.data, { category: "Tools" }) })], edges: [] }) }, { lang: "es" });
      const toolJson = res.workflows[0] && res.workflows[0].n8n.nodes.find((n) => n.type === LC + "toolCode");
      if (!toolJson) return;
      const node = b.add(toolJson.name, toolJson.type, toolJson.typeVersion, toolJson.parameters);
      for (const r of res.workflows[0].report) if (r.key !== "noEnding" && r.key !== "unknownNode") report.push(r);
      b.link(node, agent, "ai_tool");
    }
    function knowledge(list, agent) {
      for (const k of Array.isArray(list) ? list : []) {
        const vs = VSTORES[str(k.vectorStore)];
        const emb = EMBEDDINGS[str(k.embeddingModel)];
        if (!vs) { note("manual", "unsupported", { label: str(k.knowledgeName || k.vectorStore), name: str(k.vectorStore) }); continue; }
        const cfg = k.vectorStoreConfig || {};
        const node = b.add(slug(k.knowledgeName || "search_knowledge"), LC + vs.type, 1.3, clean(Object.assign({ mode: "retrieve-as-tool", toolDescription: str(k.knowledgeDescription) || "Search the knowledge base" }, vs.params(cfg, "retrieve-as-tool"))));
        addCred(vs.cred, node.name);
        if (emb) { const e = emb(k.embeddingModelConfig || {}); const en = b.add(e.label, LC + e.type, e.v, e.params); addCred(e.cred, en.name); b.link(en, node, "ai_embedding"); }
        b.link(node, agent, "ai_tool");
      }
    }

    // ---- one n8n node (or small group) per Flowise node; returns { first, last, outputs }
    function build(n) {
      const i = inp(n);
      const k = kind(n);
      const self = {};
      let node;
      mapped++;
      switch (k) {
        case "llmAgentflow": {
          const sys = messagesToSystem(i.llmMessages);
          const user = userMessage(i.llmMessages, i.llmUserMessage);
          const hasParser = Array.isArray(i.llmStructuredOutput) && i.llmStructuredOutput.some((r) => r && r.key);
          if (bool(i.llmEnableMemory) && !isForm) {
            node = b.add(label(n), LC + "agent", 2.2, { promptType: "define", text: ex(user), options: clean({ systemMessage: sys || undefined }) });
            memory(node, i.llmMemoryWindowSize);
            Object.assign(self, { node, field: "output" });
          } else {
            const p = { promptType: "define", text: ex(user) };
            if (sys) p.messages = { messageValues: [{ type: "SystemMessagePromptTemplate", message: ex(sys) }] };
            node = b.add(label(n), LC + "chainLlm", 1.7, p);
            Object.assign(self, { node, field: hasParser ? "output" : "text" });
          }
          model(i.llmModel, i.llmModelConfig, node);
          if (hasParser) {
            node.parameters.hasOutputParser = true;
            b.link(b.add("Structured Output Parser", LC + "outputParserStructured", 1.2, { schemaType: "manual", inputSchema: JSON.stringify(structuredSchema(i.llmStructuredOutput), null, 2) }), node, "ai_outputParser");
            self.field = "output";
          }
          out[n.id] = self;
          updateState(i.llmUpdateState, self);
          return { first: node, last: node };
        }
        case "agentAgentflow": {
          const sys = messagesToSystem(i.agentMessages);
          const user = userMessage(i.agentMessages, i.agentUserMessage);
          node = b.add(label(n), LC + "agent", 2.2, { promptType: "define", text: ex(user), options: clean({ systemMessage: sys || undefined }) });
          model(i.agentModel, i.agentModelConfig, node);
          if (bool(i.agentEnableMemory)) memory(node, i.agentMemoryWindowSize);
          for (const t of Array.isArray(i.agentTools) ? i.agentTools : []) agentTool(t, node);
          knowledge(i.agentKnowledgeVSEmbeddings, node);
          for (const ks of Array.isArray(i.agentKnowledgeDocumentStores) ? i.agentKnowledgeDocumentStores : []) {
            const store = findStore(ctx, ks.documentStore);
            if (!store) { note("manual", "v2DocStore", { label: label(n) }); continue; }
            const r = storeRetrieval(b, ctx, store, "retrieve-as-tool", { name: slug(store.name), toolDescription: str(ks.docStoreDescription || store.description) || `Search the ${store.name} documents` }, addCred, note);
            b.link(r.node, node, "ai_tool");
            addIngest(r, store);
          }
          Object.assign(self, { node, field: "output" });
          out[n.id] = self;
          updateState(i.agentUpdateState, self);
          return { first: node, last: node };
        }
        case "conditionAgentAgentflow": {
          const scenarios = (Array.isArray(i.conditionAgentScenarios) ? i.conditionAgentScenarios : []).map((s) => str(s.scenario)).filter(Boolean);
          const input = str(i.conditionAgentInput).trim() ? tx(i.conditionAgentInput) : `{{ ${questionExpr} }}`;
          const instr = htmlToText(i.conditionAgentInstructions);
          node = b.add(label(n), LC + "textClassifier", 1.1, { inputText: ex(input), categories: { categories: scenarios.map((s) => ({ category: s, description: s })) }, options: clean({ systemPromptTemplate: instr ? instr + "\n\nClassify the text into exactly one of the categories. {categories}" : undefined }) });
          model(i.conditionAgentModel, i.conditionAgentModelConfig, node);
          out[n.id] = { node, field: "chatInput" };
          return { first: node, last: node };
        }
        case "conditionAgentflow": {
          const conds = Array.isArray(i.conditions) ? i.conditions : [];
          const ops = { string: { equal: "equals", notEqual: "notEquals", contains: "contains", notContains: "notContains", startsWith: "startsWith", endsWith: "endsWith", isEmpty: "empty", notEmpty: "notEmpty", regex: "regex" },
            number: { equal: "equals", notEqual: "notEquals", larger: "gt", largerEqual: "gte", smaller: "lt", smallerEqual: "lte", isEmpty: "empty", notEmpty: "notEmpty" },
            boolean: { equal: "equals", notEqual: "notEquals" } };
          const rules = conds.map((c, idx) => {
            const ty = ops[c.type] ? c.type : "string";
            const operation = ops[ty][c.operation] || "equals";
            const left = tx(c.value1).trim();
            const right = tx(c.value2).trim();
            const cast = (v) => (ty === "number" && !v.includes("{{") ? num(v) : ty === "boolean" && !v.includes("{{") ? v === "true" : v);
            return { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: newId(), leftValue: ex(left), rightValue: /empty/i.test(operation) ? "" : (typeof cast(right) === "string" ? ex(right) : cast(right)), operator: { type: ty, operation, singleValue: /empty/i.test(operation) || undefined } }], combinator: "and" }, renameOutput: true, outputKey: `Condition ${idx}` };
          });
          node = b.add(label(n), NB + "switch", 3.2, { mode: "rules", rules: { values: rules }, looseTypeValidation: true, options: { fallbackOutput: "extra", renameFallbackOutput: "Else" } });
          out[n.id] = { node, field: "chatInput" };
          return { first: node, last: node };
        }
        case "httpAgentflow": {
          const p = { method: str(i.method) || "GET", url: ex(tx(i.url)) || "https://example.com", options: {} };
          const kv = (arr) => (Array.isArray(arr) ? arr : []).filter((h) => h && h.key).map((h) => ({ name: str(h.key), value: ex(tx(h.value)) }));
          if (kv(i.headers).length) Object.assign(p, { sendHeaders: true, headerParameters: { parameters: kv(i.headers) } });
          if (kv(i.queryParams).length) Object.assign(p, { sendQuery: true, queryParameters: { parameters: kv(i.queryParams) } });
          const bt = str(i.bodyType);
          if (bt === "json") Object.assign(p, { sendBody: true, specifyBody: "json", jsonBody: ex(tx(i.body)) });
          else if (bt === "raw") Object.assign(p, { sendBody: true, contentType: "raw", rawContentType: "text/plain", body: ex(tx(i.body)) });
          else if (bt === "formData" || bt === "xWwwFormUrlencoded") Object.assign(p, { sendBody: true, contentType: bt === "formData" ? "multipart-form-data" : "form-urlencoded", bodyParameters: { parameters: kv(i.body) } });
          node = b.add(label(n), NB + "httpRequest", 4.2, p);
          if (i.credential) addCred("HTTP (la credencial que usaba Flowise)", node.name);
          out[n.id] = { node, field: "data" };
          return { first: node, last: node };
        }
        case "customFunctionAgentflow": {
          const vars = (Array.isArray(i.customFunctionInputVariables) ? i.customFunctionInputVariables : []).filter((v) => v && v.variableName);
          let pre = vars.map((v) => {
            const t = tx(v.variableValue).trim();
            const m = /^\{\{ (.+) \}\}$/.exec(t);
            return `const $${v.variableName} = ${m ? m[1].replace(/\.item\.json/g, ".first().json") : JSON.stringify(t)};`;
          }).join("\n");
          let code = str(i.customFunctionJavascriptFunction)
            .replace(/^\s*(const|let|var)\s+fetch\s*=\s*require\(\s*['"]node-fetch['"]\s*\)\s*;?\s*$/gm, "// (fetch: n8n ya lo trae)");
          if (/\$flow\b/.test(code)) pre += `\nconst $flow = { sessionId: ${isForm ? "''" : sessionExpr.replace(".item.json", ".first().json")}, input: ${questionExpr.replace(".item.json", ".first().json")}, state: (() => { try { return $('${STATE}').first().json; } catch (e) { return {}; } })() };`;
          if (/\bfetch\s*\(/.test(code)) pre += "\nconst fetch = async (url, opts = {}) => {\n  const res = await this.helpers.httpRequest({ url: String(url), method: opts.method || 'GET', headers: opts.headers, body: opts.body, returnFullResponse: true, ignoreHttpStatusErrors: true, encoding: 'text', json: false });\n  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);\n  return { ok: res.statusCode < 400, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) };\n};";
          const js = `${pre}\n// ---- código original de Flowise ----\nconst __r = await (async () => {\n${code}\n})();\nreturn [{ json: { output: __r } }];`;
          node = b.add(label(n), NB + "code", 2, { jsCode: js });
          if (/require\(/.test(code)) note("adjust", "requireOther", { name: label(n) });
          note("adjust", "customFunction", { label: label(n) });
          Object.assign(self, { node, field: "output" });
          out[n.id] = self;
          updateState(i.customFunctionUpdateState, self);
          return { first: node, last: node };
        }
        case "directReplyAgentflow": {
          node = b.add(label(n), NB + "set", 3.4, { mode: "manual", assignments: { assignments: [{ id: newId(), name: "output", value: ex(tx(i.directReplyMessage)), type: "string" }] }, options: {} });
          out[n.id] = { node, field: "output" };
          return { first: node, last: node };
        }
        case "humanInputAgentflow": {
          const desc = htmlToText(i.humanInputDescription) || "¿Continuar?";
          const wait = b.add(label(n), NB + "wait", 1.1, { resume: "form", formTitle: "Aprobación", formDescription: ex(tx(desc)), formFields: { values: [{ fieldLabel: "Decision", fieldType: "dropdown", fieldOptions: { values: [{ option: "Proceed" }, { option: "Reject" }] }, requiredField: true }].concat(bool(i.humanInputEnableFeedback) ? [{ fieldLabel: "Feedback", fieldType: "textarea" }] : []) }, options: {} }, { webhookId: newId() });
          const sw = b.add(label(n) + " → decisión", NB + "switch", 3.2, { mode: "rules", rules: { values: ["Proceed", "Reject"].map((o) => ({ conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: newId(), leftValue: "={{ $json.Decision }}", rightValue: o, operator: { type: "string", operation: "equals" } }], combinator: "and" }, renameOutput: true, outputKey: o })) }, looseTypeValidation: true, options: {} });
          b.link(wait, sw);
          note("adjust", "v2Human");
          out[n.id] = { node: wait, field: "Feedback" };
          return { first: wait, last: sw };
        }
        case "toolAgentflow": {
          const tool = str(i.toolAgentflowSelectedTool);
          node = b.add(label(n), NB + "noOp", 1, {});
          note("manual", "v2Tool", { tool, label: label(n) });
          out[n.id] = { node, field: "output" };
          updateState(i.toolUpdateState, { node, field: "output" });
          return { first: node, last: node };
        }
        case "retrieverAgentflow": {
          const refs = Array.isArray(i.retrieverKnowledgeDocumentStores) ? i.retrieverKnowledgeDocumentStores : [];
          const store = refs.length ? findStore(ctx, refs[0].documentStore) : null;
          if (!store) {
            node = b.add(label(n), NB + "noOp", 1, {});
            note("manual", "v2DocStore", { label: label(n) });
            out[n.id] = { node, field: "output" };
            updateState(i.retrieverUpdateState, { node, field: "output" });
            return { first: node, last: node };
          }
          const q = str(i.retrieverQuery).trim() ? tx(i.retrieverQuery) : `{{ ${questionExpr} }}`;
          const r = storeRetrieval(b, ctx, store, "load", { name: label(n), prompt: ex(q), topK: 4 }, addCred, note);
          addIngest(r, store);
          const join = b.add(label(n) + " → text", NB + "code", 2, { jsCode: "const docs = $input.all().map((i) => (i.json.document && i.json.document.pageContent) || '');\nreturn [{ json: { output: docs.join('\\n\\n') } }];" });
          b.link(r.node, join);
          if (refs.length > 1) note("adjust", "v2Approx", { label: label(n), name: k, how: "solo se usa el primer Document Store" });
          Object.assign(self, { node: join, field: "output" });
          out[n.id] = self;
          updateState(i.retrieverUpdateState, self);
          return { first: r.node, last: join };
        }
        case "executeFlowAgentflow": {
          node = b.add(label(n), NB + "executeWorkflow", 1.2, { workflowId: { __rl: true, mode: "list", value: "" }, options: {} });
          note("manual", "executeFlow", { label: label(n) });
          out[n.id] = { node, field: "output" };
          return { first: node, last: node };
        }
        case "loopAgentflow": {
          const max = num(i.maxLoopCount) || 5;
          node = b.add(label(n), NB + "if", 2.2, { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: newId(), leftValue: "={{ $runIndex }}", rightValue: max - 1, operator: { type: "number", operation: "lt" } }], combinator: "and" }, looseTypeValidation: true, options: {} });
          const targetId = str(i.loopBackToNode).split("-")[0];
          loops.push({ from: node, targetId, max });
          out[n.id] = { node, field: "chatInput" };
          return { first: node, last: node };
        }
        case "iterationAgentflow": {
          const t = tx(i.iterationInput).trim();
          const m = /^\{\{ (.+) \}\}$/.exec(t);
          const src = m ? m[1].replace(/\.item\.json/g, ".first().json") : JSON.stringify(t);
          node = b.add(label(n), NB + "code", 2, { jsCode: `let v = ${src};\nif (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { v = [v]; } }\nif (!Array.isArray(v)) v = [v];\nreturn v.map((x) => ({ json: x && typeof x === "object" ? x : { item: x } }));` });
          note("adjust", "v2Approx", { label: label(n), name: k, how: "cada elemento pasa como un item y al final se juntan con Aggregate" });
          return { first: node, last: node, iteration: true };
        }
        default:
          mapped--;
          note("manual", "unknownNode", { label: label(n), name: k });
          node = b.add(label(n), NB + "noOp", 1, {});
          return { first: node, last: node };
      }
    }

    // ---- trigger and initial state
    let trigger;
    if (isForm) {
      trigger = b.add(FORM, NB + "formTrigger", 2.2, { formTitle: str(si.formTitle) || flow.name, formDescription: str(si.formDescription), formFields: { values: formFields.map((f) => clean({ fieldLabel: str(f.label || f.name), fieldType: { number: "number", boolean: "checkbox", options: "dropdown" }[f.type] || "text", fieldOptions: f.type === "options" ? { values: (f.addOptions || []).map((o) => ({ option: str(o.option) })) } : undefined })) }, options: {} }, { webhookId: newId() });
    } else trigger = b.add(TRIGGER, LC + "chatTrigger", 1.1, { options: {} }, { webhookId: newId() });
    if (start) mapped++;
    let head = trigger;
    const startState = Array.isArray(si.startState) ? si.startState.filter((s) => s && s.key) : [];
    if (startState.length) {
      const st = b.add(STATE, NB + "set", 3.4, { mode: "manual", assignments: { assignments: startState.map((s) => ({ id: newId(), name: str(s.key), value: str(s.value), type: "string" })) }, includeOtherFields: true, options: {} });
      b.link(trigger, st);
      head = st;
      note("adjust", "v2State");
    }

    // ---- walk the graph
    const edgesFrom = {};
    for (const e of flow.edges || []) (edgesFrom[e.source] = edgesFrom[e.source] || []).push(e);
    const children = {};
    for (const n of flow.nodes) if (n.parentNode) (children[n.parentNode] = children[n.parentNode] || []).push(n);
    const builtNodes = {};
    const loops = [];
    const outIndex = (e) => { const m = /-output-(\d+)$/.exec(str(e.sourceHandle)); return m ? Number(m[1]) : 0; };
    const order = [];
    function visit(id, from, fromOut) {
      const n = nodes[id];
      if (!n || /stickyNote/.test(kind(n))) return;
      if (builtNodes[id]) { b.link(from, builtNodes[id].first, "main", fromOut); return; }
      const r = build(n);
      builtNodes[id] = r;
      order.push(id);
      b.link(from, r.first, "main", fromOut);
      let tail = r.last;
      if (r.iteration) {
        const kids = children[id] || [];
        const kidIds = new Set(kids.map((k) => k.id));
        const firstKid = kids.find((k) => !(flow.edges || []).some((e) => e.target === k.id && kidIds.has(e.source)));
        let cur = firstKid, prev = r.last;
        const seen = new Set();
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id);
          const kr = build(cur);
          builtNodes[cur.id] = kr;
          b.link(prev, kr.first);
          prev = kr.last;
          const nxt = (edgesFrom[cur.id] || []).map((e) => nodes[e.target]).find((x) => x && kidIds.has(x.id));
          cur = nxt;
        }
        const agg = b.add(label(n) + " → resultados", NB + "aggregate", 1, { aggregate: "aggregateAllItemData", destinationFieldName: "output", options: {} });
        b.link(prev, agg);
        out[id] = { node: agg, field: "output" };
        tail = agg;
      }
      for (const e of edgesFrom[id] || []) {
        const tgt = nodes[e.target];
        if (tgt && tgt.parentNode === id) continue;
        visit(e.target, tail, outIndex(e));
      }
    }
    if (start) for (const e of edgesFrom[start.id] || []) visit(e.target, head, 0);
    for (const lp of loops) {
      const tgt = builtNodes[lp.targetId];
      if (tgt) { b.link(lp.from, tgt.first, "main", 0); note("adjust", "v2Loop", { to: tgt.first.name, max: lp.max }); }
    }
    // nodes not reachable from start
    for (const n of real) if (!builtNodes[n.id] && n !== start && !n.parentNode) note("adjust", "unreachable", { label: label(n), name: kind(n) });
    for (const n of flow.nodes) if (/stickyNote/.test(kind(n))) b.add(ctx.t.note, NB + "stickyNote", 1, { content: htmlToText(inp(n).note), height: 240, width: 300 });
    for (const { cred, node } of creds.values()) note("adjust", "credential", { cred, node });
    return { builders: [b].concat(extraBuilders), report, coverage: total ? Math.min(1, mapped / total) : 1 };
  }

  flowmigra.registerAgentflowV2(convertAgentflowV2);
  return convertAgentflowV2;
});
