// CLI for testing the Flowise converter: node flowise-cli.js <folder|export.zip|flow.json> <out_folder> [es|en]
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const flowmigra = require("./flowise-core.js");
require("./flowise-agentflow.js")(flowmigra);

async function loadInput(p) {
  const files = {};
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.json$/i.test(e.name)) files[path.relative(p, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
      }
    };
    walk(p);
  } else if (p.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(fs.readFileSync(p));
    for (const [name, f] of Object.entries(zip.files)) if (!f.dir) files[name] = await f.async("string");
  } else files[path.basename(p)] = fs.readFileSync(p, "utf8");
  return files;
}

(async () => {
  const [inp, out, lang = "es"] = process.argv.slice(2);
  const files = await loadInput(inp);
  const res = flowmigra.convert(files, { lang });
  fs.mkdirSync(out, { recursive: true });
  for (const w of res.workflows) fs.writeFileSync(path.join(out, w.fileName), JSON.stringify(w.n8n, null, 1));
  fs.writeFileSync(path.join(out, "INFORME.md"), res.reportMarkdown(lang));
  const s = res.summary;
  console.log(`${s.flows} flujos de Flowise ${JSON.stringify(s.kinds)} → ${s.count} flujos de n8n | cobertura media ${Math.round(s.coverage * 100)}% | sin pasos a mano: ${s.fullyAutomatic}`);
})();
