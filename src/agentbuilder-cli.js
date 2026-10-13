// CLI: node agentbuilder-cli.js <carpeta|archivo> <salida> [es|en]
const fs = require("fs"), path = require("path");
const ab = require("./agentbuilder-core.js");
const [inp, out, lang = "es"] = process.argv.slice(2);
const files = {};
const st = fs.statSync(inp);
if (st.isDirectory()) for (const f of fs.readdirSync(inp)) { const p = path.join(inp, f); if (fs.statSync(p).isFile() && fs.statSync(p).size < 2e6) files[f] = fs.readFileSync(p, "utf8"); }
else files[path.basename(inp)] = fs.readFileSync(inp, "utf8");
const res = ab.convert(files, { lang });
fs.mkdirSync(out, { recursive: true });
for (const w of res.workflows) fs.writeFileSync(path.join(out, w.fileName), JSON.stringify(w.n8n, null, 1));
fs.writeFileSync(path.join(out, "INFORME.md"), res.reportMarkdown(lang));
for (const f of res.failed) console.log("FALLÓ", f.name, f.error);
const s = res.summary;
console.log(`${s.files} exports → ${s.count} flujos de n8n (${s.agents} agentes) | cobertura media ${Math.round(s.coverage * 100)}% | sin pasos a mano: ${s.fullyAutomatic} | errores: ${s.errors}`);
