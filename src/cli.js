// CLI for testing the core: node cli.js <folder|export.zip|workflow.json> <out_folder> [en|es]
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const JSZip = require("jszip");
const pdmigra = require("./pdmigra-core.js");

async function loadInput(p) {
  const files = {};
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ya?ml|m?js|py|json|ts)$/.test(e.name) && fs.statSync(full).size < 2e6) files[path.relative(p, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
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
  const res = pdmigra.convert(files, { yamlLoad: yaml.load });
  fs.mkdirSync(out, { recursive: true });
  for (const w of res.workflows) fs.writeFileSync(path.join(out, w.fileName), JSON.stringify(w.n8n, null, 1));
  fs.writeFileSync(path.join(out, "INFORME.md"), res.reportMarkdown(lang));
  const s = res.summary;
  console.log(`${s.count} flujos (${s.format}) | cobertura media ${Math.round(s.coverage * 100)}% | 100% automáticos: ${s.fullyAutomatic}`);
})();
