/*
 * Small parser for the code that OpenAI Agent Builder exports (Agents SDK, Python or TypeScript).
 * It is not a general Python/TS parser: it understands the expressions and statements that the exporter generates
 * (assignments, calls, dicts/objects, lists, f-strings/template literals, if/elif/else, while, for, return).
 * Exposes window.abparse / module.exports.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.abparse = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------ tokenizer
  const PUNCT = ["...", "**=", "//=", "===", "!==", "**", "//", "==", "!=", "<=", ">=", "=>", "->", "&&", "||", "??", "?.", "+=", "-=", "*=", "/=", ":=",
    "(", ")", "[", "]", "{", "}", ",", ":", ";", ".", "=", "+", "-", "*", "/", "%", "<", ">", "!", "?", "@", "&", "|", "^", "~"];

  function tokenize(src, lang) {
    const toks = [];
    let i = 0, line = 1;
    const n = src.length;
    let tokStart = 0;
    const push = (type, value, extra) => toks.push(Object.assign({ type, value, line, pos: tokStart }, extra || {}));
    while (i < n) {
      tokStart = i;
      const ch = src[i];
      if (ch === "\n") { push("nl", "\n"); line++; i++; continue; }
      if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
      if (ch === "\\" && src[i + 1] === "\n") { i += 2; line++; continue; }
      if (lang === "py" && ch === "#") { while (i < n && src[i] !== "\n") i++; continue; }
      if (lang === "ts" && ch === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (lang === "ts" && ch === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const chunk = src.slice(i, e < 0 ? n : e + 2); line += (chunk.match(/\n/g) || []).length; i = e < 0 ? n : e + 2; continue; }
      // strings (python prefixes f/r/b/u combos)
      let m = lang === "py" ? /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(i, i + 5)) : null;
      if ((lang === "ts" && (ch === '"' || ch === "'" || ch === "`")) || (m && (m[1] === "" || /^[rRbBuUfF]+$/.test(m[1])) && (m[1] || ch === '"' || ch === "'"))) {
        let prefix = "", q;
        if (lang === "py") { prefix = m[1].toLowerCase(); q = m[2]; i += m[1].length; } else q = ch;
        const start = i;
        i += q.length;
        let out = "";
        const parts = []; // template / f-string parts: strings and {expr} sources
        let cur = "";
        const fmt = prefix.includes("f") || q === "`";
        const raw = prefix.includes("r");
        while (i < n && src.slice(i, i + q.length) !== q) {
          const c = src[i];
          if (c === "\n") line++;
          if (c === "\\" && !raw) {
            const nx = src[i + 1];
            const map = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\", "`": "`", $: "$", "{": "\\{", "}": "\\}" };
            if (nx === "\n") { i += 2; line++; continue; }
            if (nx === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) { cur += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
            cur += map[nx] !== undefined ? (map[nx] === "\\{" ? "{" : map[nx] === "\\}" ? "}" : map[nx]) : nx;
            i += 2;
            continue;
          }
          if (fmt && q !== "`" && c === "{" && src[i + 1] === "{") { cur += "{"; i += 2; continue; }
          if (fmt && q !== "`" && c === "}" && src[i + 1] === "}") { cur += "}"; i += 2; continue; }
          if (fmt && ((q === "`" && c === "$" && src[i + 1] === "{") || (q !== "`" && c === "{"))) {
            i += q === "`" ? 2 : 1;
            let depth = 1, e = i, inStr = null;
            while (e < n && depth > 0) {
              const d = src[e];
              if (inStr) { if (d === "\\") e++; else if (d === inStr) inStr = null; }
              else if (d === '"' || d === "'" || d === "`") inStr = d;
              else if (d === "{") depth++;
              else if (d === "}") depth--;
              if (depth > 0) e++;
            }
            let exprSrc = src.slice(i, e);
            // python format spec / conversion: {x!r:>10}
            if (q !== "`") exprSrc = exprSrc.replace(/(![rsa])?(:[^:{}\[\]()'"]*)?$/, "");
            if (cur) parts.push(cur);
            cur = "";
            parts.push({ expr: exprSrc });
            i = e + 1;
            continue;
          }
          cur += c;
          i++;
        }
        i += q.length;
        if (cur || !parts.length) parts.push(cur);
        if (fmt && parts.some((p) => typeof p === "object")) push("fstr", parts, { raw: src.slice(start, i) });
        else push("str", parts.join(""));
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1]))) {
        const mm = /^(0[xX][0-9a-fA-F_]+|[0-9][0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+)/.exec(src.slice(i));
        push("num", Number(mm[1].replace(/_/g, "")));
        i += mm[1].length;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        const mm = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
        push("name", mm[0]);
        i += mm[0].length;
        continue;
      }
      if (lang === "ts" && ch === "/") {
        const prev = toks.length ? toks[toks.length - 1] : null;
        const operandExpected = !prev || prev.type === "nl" || (prev.type === "op" && !")]}".includes(prev.value)) || (prev.type === "name" && ["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do"].includes(prev.value));
        if (operandExpected) {
          let j = i + 1, inCls = false;
          while (j < n && src[j] !== "\n") { const c = src[j]; if (c === "\\") { j += 2; continue; } if (c === "[") inCls = true; else if (c === "]") inCls = false; else if (c === "/" && !inCls) break; j++; }
          if (src[j] === "/") { let k = j + 1; while (/[a-z]/.test(src[k] || "")) k++; push("regex", src.slice(i, k)); i = k; continue; }
        }
      }
      const p = PUNCT.find((x) => src.startsWith(x, i));
      if (p) { push("op", p); i += p.length; continue; }
      push("op", ch);
      i++;
    }
    push("eof", null);
    return toks;
  }

  // ------------------------------------------------------------------ expression parser
  // AST: {t:"str",v} {t:"fstr",parts:[string|AST]} {t:"num",v} {t:"bool",v} {t:"null"} {t:"name",id}
  //      {t:"list",items} {t:"dict",entries:[{k,v}|{spread}]} {t:"attr",obj,name} {t:"index",obj,idx}
  //      {t:"call",fn,args,kwargs} {t:"bin",op,l,r} {t:"un",op,x} {t:"cond",test,a,b} {t:"spread",x} {t:"arrow",params,body}
  class Parser {
    constructor(toks, lang) { this.t = toks; this.i = 0; this.lang = lang; this.depth = 0; }
    peek(o) { let j = this.i, k = o || 0; for (;;) { const tk = this.t[j]; if (tk.type === "nl" && this.depth > 0) { j++; continue; } if (k === 0) return tk; k--; j++; } }
    next() { for (;;) { const tk = this.t[this.i++]; if (tk.type === "nl" && this.depth > 0) continue; return tk; } }
    is(v, type) { const tk = this.peek(); return tk.value === v && (!type || tk.type === type) && tk.type !== "str"; }
    eat(v) { if (this.is(v)) { this.next(); return true; } return false; }
    expect(v) { const tk = this.next(); if (tk.value !== v) throw new Error(`esperaba "${v}" y encontré "${tk.value}" (línea ${tk.line})`); return tk; }
    open(v) { this.expect(v); this.depth++; }
    close(v) { this.depth--; this.expect(v); }

    expr() {
      if (this.lang === "py" && this.is("lambda")) { this.next(); const params = []; while (!this.is(":")) { const tk = this.next(); if (tk.type === "name") params.push(tk.value); } this.next(); return { t: "arrow", params, body: this.expr() }; }
      let e = this.or();
      if (this.lang === "py" && this.is("if") && !this.stopIf) { this.next(); const test = this.or(); this.expect("else"); const b = this.expr(); return { t: "cond", test, a: e, b }; }
      if (this.lang === "ts" && this.is("?")) { this.next(); const a = this.expr(); this.expect(":"); const b = this.expr(); return { t: "cond", test: e, a, b }; }
      if (this.lang === "ts" && this.is("as")) { this.next(); this.skipType(); }
      return e;
    }
    skipType() { let d = 0; for (;;) { const tk = this.peek(); if (tk.type === "eof") return; if (d === 0 && (tk.value === "," || tk.value === ")" || tk.value === ";" || tk.value === "]" || tk.value === "}" || tk.value === ">" || tk.value === "=" || tk.value === "=>" || tk.value === "{" && this.peek(1).type !== "name" || (tk.type === "nl"))) return; if (tk.value === "<" || tk.value === "(" || tk.value === "[" || tk.value === "{") d++; if (tk.value === ">" || tk.value === ")" || tk.value === "]" || tk.value === "}") d--; this.next(); } }
    or() { let l = this.and(); while (this.is("or") || this.is("||") || this.is("??")) { const op = this.next().value; l = { t: "bin", op: op === "or" ? "||" : op, l, r: this.and() }; } return l; }
    and() { let l = this.not(); while (this.is("and") || this.is("&&")) { this.next(); l = { t: "bin", op: "&&", l, r: this.not() }; } return l; }
    not() { if (this.is("not") || this.is("!")) { this.next(); return { t: "un", op: "!", x: this.not() }; } return this.cmp(); }
    cmp() {
      let l = this.add();
      for (;;) {
        const tk = this.peek();
        if (["==", "!=", "===", "!==", "<", ">", "<=", ">="].includes(tk.value) && tk.type === "op") { this.next(); l = { t: "bin", op: tk.value.replace(/^===$/, "==").replace(/^!==$/, "!="), l, r: this.add() }; continue; }
        if (tk.value === "in" && tk.type === "name") { this.next(); l = { t: "bin", op: "in", l, r: this.add() }; continue; }
        if (tk.value === "not" && this.peek(1).value === "in") { this.next(); this.next(); l = { t: "un", op: "!", x: { t: "bin", op: "in", l, r: this.add() } }; continue; }
        if (tk.value === "is" && tk.type === "name") { this.next(); const neg = this.eat("not"); const r = this.add(); l = { t: "bin", op: neg ? "!=" : "==", l, r }; continue; }
        if (tk.value === "instanceof") { this.next(); l = { t: "bin", op: "instanceof", l, r: this.add() }; continue; }
        return l;
      }
    }
    add() { let l = this.mul(); while ((this.is("+") || this.is("-")) && this.peek().type === "op") { const op = this.next().value; l = { t: "bin", op, l, r: this.mul() }; } return l; }
    mul() { let l = this.unary(); while ((this.is("*") || this.is("/") || this.is("//") || this.is("%") || this.is("**")) && this.peek().type === "op") { const op = this.next().value; l = { t: "bin", op, l, r: this.unary() }; } return l; }
    unary() {
      if (this.is("-") || this.is("+")) { const op = this.next().value; return { t: "un", op, x: this.unary() }; }
      if (this.is("await") || this.is("new") || this.is("typeof") || this.is("void")) { const op = this.next().value; const x = this.unary(); return op === "new" ? Object.assign(x, { isNew: true }) : op === "typeof" ? { t: "un", op: "typeof", x } : x; }
      return this.postfix();
    }
    postfix() {
      let e = this.primary();
      for (;;) {
        if (this.is(".") || this.is("?.")) { this.next(); if (this.is("[")) { this.open("["); const idx = this.expr(); this.close("]"); e = { t: "index", obj: e, idx }; continue; } const nm = this.next(); e = { t: "attr", obj: e, name: nm.value }; continue; }
        if (this.is("[")) { this.open("["); let idx = this.is(":") ? { t: "null" } : this.expr(); if (this.eat(":")) { if (!this.is("]")) this.expr(); } this.close("]"); e = { t: "index", obj: e, idx }; continue; }
        if (this.is("(")) { e = Object.assign({ t: "call", fn: e }, this.args()); continue; }
        if (this.lang === "ts" && this.is("!") && this.peek().type === "op" && [".", ")", ",", ";", "]"].includes(this.peek(1).value)) { this.next(); continue; }
        if (this.lang === "ts" && this.is("<") && (e.t === "name" || e.t === "attr")) { // generic call like Agent<Ctx>(...) / new Map<string, X>()
          const save = this.i; try { this.next(); this.skipType(); if (this.eat(">") && this.is("(")) continue; } catch (x) {} this.i = save; return e;
        }
        return e;
      }
    }
    args() {
      this.open("(");
      const args = [], kwargs = {};
      while (!this.is(")")) {
        if (this.is("*") || this.is("**") || this.is("...")) { this.next(); args.push({ t: "spread", x: this.expr() }); }
        else if (this.lang === "py" && this.peek().type === "name" && this.peek(1).value === "=" ) { const k = this.next().value; this.next(); kwargs[k] = this.expr(); }
        else args.push(this.exprOrArrow());
        if (this.lang === "py" && this.is("for")) { let d = 0; while (!(d === 0 && this.is(")"))) { const tk = this.next(); if (tk.type === "eof") break; if (tk.value === "(" || tk.value === "[" || tk.value === "{") d++; if (tk.value === ")" || tk.value === "]" || tk.value === "}") d--; } args.push({ t: "comprehension" }); break; }
        if (!this.eat(",")) break;
      }
      this.close(")");
      return { args, kwargs };
    }
    exprOrArrow() { return (this.lang === "ts" && this.tryArrow()) || this.expr(); }
    tryArrow() {
      // (a, b) => ... | a => ... | async (a) => ...   — returns null (and restores position) when it is not an arrow function
      const save = this.i;
      const saveDepth = this.depth;
      if (this.lang === "ts") {
        try {
          this.eat("async");
          let params = [];
          if (this.peek().type === "name" && this.peek(1).value === "=>") params = [this.next().value];
          else if (this.is("(")) { this.open("("); while (!this.is(")")) { const tk = this.next(); if (tk.type === "name") params.push(tk.value); if (tk.value === ":") this.skipType(); } this.close(")"); if (this.is(":")) { this.next(); this.skipType(); } if (!this.is("=>")) throw 0; }
          else throw 0;
          this.expect("=>");
          if (this.is("{")) { const body = this.skipBlock(); return { t: "arrow", params, body: { t: "block", src: body } }; }
          return { t: "arrow", params, body: this.expr() };
        } catch (x) { this.i = save; this.depth = saveDepth; }
      }
      return null;
    }
    skipBlock() { this.open("{"); const start = this.i; let d = 1; while (d > 0) { const tk = this.t[this.i++]; if (tk.type === "eof") break; if (tk.value === "{" && tk.type === "op") d++; if (tk.value === "}" && tk.type === "op") d--; } this.depth--; return this.t.slice(start, this.i - 1); }
    primary() {
      const tk = this.next();
      if (tk.type === "str") { let v = tk.value; while (this.peek().type === "str" || this.peek().type === "fstr") { const t2 = this.next(); if (t2.type === "str") v += t2.value; else return { t: "fstr", parts: [v].concat(t2.value.map((p) => (typeof p === "string" ? p : subExpr(p.expr, this.lang)))) }; } return { t: "str", v }; }
      if (tk.type === "fstr") return { t: "fstr", parts: tk.value.map((p) => (typeof p === "string" ? p : subExpr(p.expr, this.lang))) };
      if (tk.type === "num") return { t: "num", v: tk.value };
      if (tk.type === "regex") return { t: "regex", src: tk.value };
      if (tk.type === "name") {
        if (tk.value === "True" || tk.value === "true") return { t: "bool", v: true };
        if (tk.value === "False" || tk.value === "false") return { t: "bool", v: false };
        if (tk.value === "None" || tk.value === "null" || tk.value === "undefined") return { t: "null" };
        if (this.lang === "ts" && tk.value === "async" && (this.is("(") || this.peek().type === "name")) { this.i--; const a = this.tryArrow(); if (a) return a; this.next(); return { t: "name", id: "async" }; }
        if (this.lang === "ts" && tk.value === "function") { while (!this.is("{")) this.next(); return { t: "arrow", params: [], body: { t: "block", src: this.skipBlock() } }; }
        return { t: "name", id: tk.value };
      }
      if (tk.value === "(") {
        this.i--;
        if (this.lang === "ts") { const a = this.tryArrow(); if (a) return a; }
        this.open("(");
        if (this.is(")")) { this.close(")"); return { t: "list", items: [] }; }
        const e = this.expr();
        if (this.lang === "py" && this.is("for")) { let d = 0; while (!(d === 0 && this.is(")"))) { const tk = this.next(); if (tk.type === "eof") break; if ("([{".includes(tk.value)) d++; if (")]}".includes(tk.value)) d--; } this.close(")"); return { t: "comprehension" }; }
        if (this.is(",")) { const items = [e]; while (this.eat(",") && !this.is(")")) items.push(this.expr()); this.close(")"); return { t: "list", items }; }
        this.close(")");
        return e;
      }
      if (tk.value === "[") {
        this.depth++;
        const items = [];
        while (!this.is("]")) {
          if (this.is("*") || this.is("...")) { this.next(); items.push({ t: "spread", x: this.expr() }); }
          else items.push(this.exprOrArrow());
          if (this.lang === "py" && this.is("for")) { while (!this.is("]")) this.next(); items.push({ t: "comprehension" }); break; }
          if (!this.eat(",")) break;
        }
        this.close("]");
        return { t: "list", items };
      }
      if (tk.value === "{") {
        this.depth++;
        const entries = [];
        while (!this.is("}")) {
          if (this.is("**") || this.is("...")) { this.next(); entries.push({ spread: this.expr() }); }
          else {
            let k;
            if (this.lang === "ts" && (this.is("async") || this.is("get") || this.is("set")) && this.peek(1).type === "name" && this.peek(2).value === "(") this.next();
            const kt = this.peek();
            if (this.lang === "ts" && (kt.type === "name" || kt.type === "str" || kt.type === "num") && [",", "}", ":", "("].includes(this.peek(1).value)) {
              this.next();
              k = { t: "str", v: String(kt.value) };
              if (this.is(",") || this.is("}")) { entries.push({ k, v: { t: "name", id: kt.value } }); if (!this.eat(",")) break; continue; }
              if (this.is("(")) { const fn = Object.assign({ t: "arrow", params: [] }, {}); this.args(); fn.body = this.is("{") ? { t: "block", src: this.skipBlock() } : null; entries.push({ k, v: fn }); if (!this.eat(",")) break; continue; }
            } else if (this.lang === "ts" && kt.value === "[") { this.open("["); k = this.expr(); this.close("]"); }
            else k = this.expr();
            if (this.lang === "py" && this.is("for")) { while (!this.is("}")) this.next(); entries.push({ comprehension: true }); break; }
            if (this.lang === "py" && (this.is(",") || this.is("}")) && !entries.some((e) => e.k)) { // set literal {a, b}
              const items = [k];
              while (this.eat(",") && !this.is("}")) items.push(this.expr());
              this.close("}");
              return { t: "list", items, set: true };
            }
            this.expect(":");
            entries.push({ k, v: this.exprOrArrow() });
            if (this.lang === "py" && this.is("for")) { while (!this.is("}")) this.next(); entries.push({ comprehension: true }); break; }
          }
          if (!this.eat(",")) break;
        }
        this.close("}");
        return { t: "dict", entries };
      }
      if (tk.value === "..." ) return { t: "spread", x: this.expr() };
      throw new Error(`no esperaba "${tk.value}" (línea ${tk.line})`);
    }
  }

  function subExpr(src, lang) {
    try { const p = new Parser(tokenize(src, lang), lang); p.depth = 1; return p.expr(); } catch (e) { return { t: "raw", src }; }
  }
  function parseExpr(src, lang) { const p = new Parser(tokenize(src, lang), lang); p.depth = 1; return p.expr(); }

  // AST → plain JS value when it is a literal (dict/list/str/num/bool/null); otherwise undefined
  function lit(a) {
    if (!a) return undefined;
    switch (a.t) {
      case "str": return a.v;
      case "num": return a.v;
      case "bool": return a.v;
      case "null": return null;
      case "un": if (a.op === "-" && a.x.t === "num") return -a.x.v; return undefined;
      case "list": { const out = []; for (const x of a.items) { const v = lit(x); if (v === undefined) return undefined; out.push(v); } return out; }
      case "dict": { const out = {}; for (const e of a.entries) { if (!e.k) return undefined; const k = lit(e.k); const v = lit(e.v); if (k === undefined || v === undefined) return undefined; out[k] = v; } return out; }
      default: return undefined;
    }
  }
  // Loose version: non-literal leaves become their source-ish description (so configs with expressions still parse)
  function loose(a) {
    if (!a) return undefined;
    const v = lit(a);
    if (v !== undefined) return v;
    if (a.t === "list") return a.items.map(loose);
    if (a.t === "dict") { const out = {}; for (const e of a.entries) if (e.k) out[String(loose(e.k))] = loose(e.v); return out; }
    if (a.t === "call") { const o = { __call: nameOf(a.fn) }; a.args.forEach((x, i) => { o[i] = loose(x); }); Object.assign(o, Object.fromEntries(Object.entries(a.kwargs || {}).map(([k, x]) => [k, loose(x)]))); return o; }
    return { __expr: a };
  }
  function nameOf(a) {
    if (!a) return "";
    if (a.t === "name") return a.id;
    if (a.t === "attr") return nameOf(a.obj) + "." + a.name;
    return "";
  }

  // ------------------------------------------------------------------ statements
  // Statement: {s:"assign",target,value} {s:"expr",value} {s:"if",branches:[{test,body}],orelse} {s:"while",test,body}
  //            {s:"for",target,iter,body} {s:"return",value} {s:"other",src}
  function pyStatements(src) {
    // logical lines with indentation
    const toks = tokenize(src, "py");
    const lines = [];
    let cur = [], depth = 0, indent = 0, atStart = true, lineStartIdx = 0;
    const lineIndent = (ln) => { const s = src.split("\n")[ln - 1] || ""; return s.length - s.trimStart().length; };
    for (const tk of toks) {
      if (tk.type === "eof") break;
      if (tk.type === "nl") { if (depth === 0) { if (cur.length) lines.push({ indent, toks: cur, line: cur[0].line }); cur = []; atStart = true; } else cur.push(tk); continue; }
      if (atStart) { indent = lineIndent(tk.line); atStart = false; }
      if (["(", "[", "{"].includes(tk.value) && tk.type === "op") depth++;
      if ([")", "]", "}"].includes(tk.value) && tk.type === "op") depth--;
      cur.push(tk);
    }
    if (cur.length) lines.push({ indent, toks: cur, line: cur[0].line });
    let pos = 0;
    function block(minIndent) {
      const out = [];
      while (pos < lines.length && lines[pos].indent >= minIndent) {
        const ln = lines[pos];
        const ind = ln.indent;
        if (ind > minIndent && out.length === 0) minIndent = ind;
        if (ind !== minIndent) break;
        out.push(stmt(ln));
      }
      return out;
    }
    function body(ln) {
      // block after a line ending in ':'; inline form "if x: return y"
      const colon = lastTopColon(ln.toks);
      const rest = ln.toks.slice(colon + 1);
      pos++;
      if (rest.length) return [stmtFromToks(rest, ln.line)];
      const nextIndent = pos < lines.length ? lines[pos].indent : -1;
      return nextIndent > ln.indent ? block(nextIndent) : [];
    }
    function lastTopColon(tl) { let d = 0, last = -1; for (let i = 0; i < tl.length; i++) { const v = tl[i].value; if (tl[i].type === "op") { if ("([{".includes(v)) d++; else if (")]}".includes(v)) d--; else if (v === ":" && d === 0) { last = i; if (tl[0].value !== "lambda") break; } } } return last; }
    function exprOf(tl) {
      const p = new Parser(tl.concat([{ type: "eof", value: null }]), "py"); p.depth = 1; p.stopIf = false;
      const first = p.expr();
      if (!p.is(",")) return first;
      const items = [first];
      while (p.eat(",") && p.peek().type !== "eof") items.push(p.expr());
      return { t: "list", items, tuple: true };
    }
    function stmt(ln) {
      const t0 = ln.toks[0].value;
      if (t0 === "if") {
        const branches = [];
        let orelse = null;
        branches.push({ test: exprOf(ln.toks.slice(1, lastTopColon(ln.toks))), body: body(ln) });
        while (pos < lines.length && lines[pos].indent === ln.indent && (lines[pos].toks[0].value === "elif" || lines[pos].toks[0].value === "else")) {
          const l2 = lines[pos];
          if (l2.toks[0].value === "elif") branches.push({ test: exprOf(l2.toks.slice(1, lastTopColon(l2.toks))), body: body(l2) });
          else { orelse = body(l2); break; }
        }
        return { s: "if", branches, orelse, line: ln.line };
      }
      if (t0 === "while") return { s: "while", test: exprOf(ln.toks.slice(1, lastTopColon(ln.toks))), body: body(ln), line: ln.line };
      if (t0 === "for" || (t0 === "async" && ln.toks[1].value === "for")) { const toks = t0 === "async" ? ln.toks.slice(1) : ln.toks; const inIdx = toks.findIndex((x) => x.value === "in"); return { s: "for", target: toks.slice(1, inIdx).map((x) => x.value).join(""), iter: safe(() => exprOf(toks.slice(inIdx + 1, lastTopColon(toks)))), body: body(ln), line: ln.line }; }
      if (t0 === "with" || (t0 === "async" && ln.toks[1].value === "with") || t0 === "try" || t0 === "finally") { return { s: "block", body: body(ln), line: ln.line }; }
      if (t0 === "except") { body(ln); return { s: "other", src: "except", line: ln.line }; }
      if (t0 === "class") {
        const name = ln.toks[1].value;
        const po = ln.toks.findIndex((x) => x.value === "(");
        const bases = po > 0 ? ln.toks.slice(po + 1, ln.toks.findIndex((x) => x.value === ")")).map((x) => x.value).join("") : "";
        return { s: "class", name, bases, body: body(ln), line: ln.line };
      }
      if (t0 === "def" || (t0 === "async" && ln.toks[1].value === "def")) {
        const k = t0 === "def" ? 1 : 2;
        const name = ln.toks[k].value;
        const po = k + 1, pc = lastTopColon(ln.toks);
        const src = ln.toks.slice(po, pc).map((x) => (x.type === "str" ? JSON.stringify(x.value) : x.value)).join(" ");
        const startLine = ln.line;
        const b = body(ln);
        return { s: "def", name, params: src, body: b, line: startLine, endLine: pos < lines.length ? lines[pos].line - 1 : null };
      }
      if (t0 === "@") { pos++; return { s: "decorator", name: ln.toks.slice(1).map((x) => x.value).join(""), line: ln.line }; }
      pos++;
      return stmtFromToks(ln.toks, ln.line);
    }
    function stmtFromToks(tl, line) {
      const t0 = tl[0].value;
      try {
        if (t0 === "return") return { s: "return", value: tl.length > 1 ? exprOf(tl.slice(1)) : null, line };
        if (t0 === "pass" || t0 === "break" || t0 === "continue") return { s: t0, line };
        if (t0 === "raise") return { s: "raise", line };
        // annotation without value:  field: type   (pydantic / dataclass fields)
        if (tl[0].type === "name" && tl[1] && tl[1].value === ":" && !tl.some((x) => x.value === "=" && x.type === "op")) {
          return { s: "ann", name: t0, type: tl.slice(2).map((x) => (x.type === "str" ? JSON.stringify(x.value) : x.value)).join(""), line };
        }
        // assignment: target [: type] = value   (also +=)
        let d = 0;
        for (let i = 0; i < tl.length; i++) {
          const v = tl[i].value;
          if (tl[i].type !== "op") continue;
          if ("([{".includes(v)) d++; else if (")]}".includes(v)) d--;
          else if (d === 0 && (v === "=" || v === "+=" || v === "-=")) {
            let targetToks = tl.slice(0, i);
            const colon = targetToks.findIndex((x) => x.value === ":" && x.type === "op");
            if (colon > 0) targetToks = targetToks.slice(0, colon);
            return { s: "assign", target: exprOf(targetToks), op: v, value: exprOf(tl.slice(i + 1)), line };
          }
        }
        return { s: "expr", value: exprOf(tl), line };
      } catch (e) { return { s: "other", src: tl.map((x) => (x.type === "str" ? JSON.stringify(x.value) : x.value)).join(" "), err: e.message, line }; }
    }
    const out = block(0);
    return out;
  }
  function safe(f) { try { return f(); } catch (e) { return null; } }

  function tsStatements(toks, start, end) {
    // toks: token array; parses statements between [start, end)
    const out = [];
    // keep track of line breaks so statements without ";" end where JavaScript would end them (ASI)
    const t = [];
    let nl = false;
    for (const x of toks) { if (x.type === "nl") { nl = true; continue; } t.push(nl && !x.nlBefore ? Object.assign({}, x, { nlBefore: true }) : x); nl = false; }
    let i = start === undefined ? 0 : start;
    const stop = end === undefined ? t.length - 1 : end;
    const P = (from, to) => { const p = new Parser(t.slice(from, to).concat([{ type: "eof", value: null }]), "ts"); p.depth = 1; return p; };
    function matchClose(j) { let d = 0; for (let k = j; k < stop; k++) { const v = t[k].value; if (t[k].type !== "op") continue; if ("([{".includes(v)) d++; else if (")]}".includes(v)) { d--; if (d === 0) return k; } } return stop; }
    const KW = new Set(["const", "let", "var", "if", "for", "while", "return", "export", "function", "class", "import", "throw", "try", "switch", "do", "type", "interface"]);
    let asi = false;
    function stmtEnd(j) {
      asi = false;
      let d = 0;
      for (let k = j; k < stop; k++) {
        const v = t[k].value;
        if (k > j && d === 0 && t[k].nlBefore) {
          const prev = t[k - 1];
          const prevEnds = prev.type === "name" || prev.type === "str" || prev.type === "fstr" || prev.type === "num" || (prev.type === "op" && ")]}".includes(prev.value));
          if (prevEnds && ((t[k].type === "name" && KW.has(v)) || (t[k].type === "name" && t[k + 1] && ["=", "(", "."].includes(t[k + 1].value) && !["await", "new", "typeof", "in", "of", "as", "instanceof"].includes(v)))) { asi = true; return k; }
        }
        if (t[k].type === "op") { if ("([{".includes(v)) d++; else if (")]}".includes(v)) { if (d === 0) return k; d--; } else if (v === ";" && d === 0) return k; }
      }
      return stop;
    }
    function blockOrStmt(j) { if (t[j].value === "{" && t[j].type === "op") { const c = matchClose(j); return { body: tsStatements(t, j + 1, c), next: c + 1 }; } const e = stmtEnd(j); const skip = asi ? 0 : 1; return { body: tsStatements(t, j, e + skip), next: e + skip }; }
    while (i < stop) {
      const tk = t[i];
      const line = tk.line;
      if (tk.value === ";" || tk.value === "}") { i++; continue; }
      if (tk.value === "if" && tk.type === "name") {
        const branches = [];
        let orelse = null;
        let j = i;
        for (;;) {
          const c = matchClose(j + 1);
          const test = safe(() => P(j + 2, c).expr()) || { t: "raw", src: "?" };
          const b = blockOrStmt(c + 1);
          branches.push({ test, body: b.body });
          j = b.next;
          if (t[j] && t[j].value === "else") {
            if (t[j + 1] && t[j + 1].value === "if") { j = j + 1; continue; }
            const e = blockOrStmt(j + 1);
            orelse = e.body;
            j = e.next;
          }
          break;
        }
        out.push({ s: "if", branches, orelse, line });
        i = j;
        continue;
      }
      if (tk.value === "while" && tk.type === "name") { const c = matchClose(i + 1); const test = safe(() => P(i + 2, c).expr()); const b = blockOrStmt(c + 1); out.push({ s: "while", test, body: b.body, line }); i = b.next; continue; }
      if (tk.value === "for" && tk.type === "name") { const c = matchClose(i + 1); const b = blockOrStmt(c + 1); out.push({ s: "for", target: "", iter: null, body: b.body, line }); i = b.next; continue; }
      if (tk.value === "try" && tk.type === "name") { const b = blockOrStmt(i + 1); out.push({ s: "block", body: b.body, line }); i = b.next; while (t[i] && (t[i].value === "catch" || t[i].value === "finally")) { let j = i + 1; if (t[j].value === "(") j = matchClose(j) + 1; const c = blockOrStmt(j); i = c.next; } continue; }
      if (tk.value === "{" && tk.type === "op") { const c = matchClose(i); out.push({ s: "block", body: tsStatements(t, i + 1, c), line }); i = c + 1; continue; }
      if ((tk.value === "export" || tk.value === "default" || tk.value === "declare") && tk.type === "name" && t[i + 1] && t[i + 1].type === "name") { i++; continue; }
      if ((tk.value === "type" || tk.value === "interface" || tk.value === "enum") && tk.type === "name" && t[i + 1] && t[i + 1].type === "name") {
        let j = i + 2, d = 0;
        for (; j < stop; j++) { const v = t[j].value; if (t[j].type !== "op") continue; if ("([{<".includes(v)) d++; else if (")]}>".includes(v)) { d--; if (d === 0 && v === "}" && tk.value !== "type") { j++; break; } } else if (v === ";" && d === 0) { j++; break; } }
        if (tk.value === "type") { // type X = ... ; may end without ";" — stop at the closing brace of the object type
          j = i + 2; d = 0; for (; j < stop; j++) { const v = t[j].value; if (t[j].type !== "op") continue; if ("([{<".includes(v)) d++; else if (")]}>".includes(v)) { d--; if (d === 0 && (t[j + 1] === undefined || t[j + 1].value !== "|" && t[j + 1].value !== "&")) { j++; break; } } else if (v === ";" && d === 0) { j++; break; } }
        }
        out.push({ s: "other", src: tk.value + " " + t[i + 1].value, line: tk.line });
        i = j;
        continue;
      }
      if (tk.value === "import" && tk.type === "name") { let j = i + 1; while (j < stop && t[j].type !== "str") j++; out.push({ s: "import", src: t[j] ? t[j].value : "", line: tk.line }); i = j + 1; continue; }
      if ((tk.value === "function" || (tk.value === "async" && t[i + 1].value === "function")) ) { let j = i; while (t[j].value !== "{") j++; const c = matchClose(j); out.push({ s: "other", src: "function", line }); i = c + 1; continue; }
      const e = stmtEnd(i);
      const seg = t.slice(i, e);
      i = asi ? e : e + 1;
      if (!seg.length) continue;
      try {
        const v0 = seg[0].value;
        if (v0 === "return") { let v = null; if (seg.length > 1) { const pr = new Parser(seg.slice(1).concat([{ type: "eof" }]), "ts"); pr.depth = 1; v = pr.exprOrArrow(); } out.push({ s: "return", value: v, line }); continue; }
        if (v0 === "break" || v0 === "continue") { out.push({ s: v0, line }); continue; }
        if (v0 === "throw") { out.push({ s: "raise", line }); continue; }
        if (v0 === "const" || v0 === "let" || v0 === "var") {
          let j = 1, target;
          if (seg[1].value === "{" || seg[1].value === "[") {
            let d = 0, k = 1;
            const names = [], keys = [];
            for (; k < seg.length; k++) {
              if ("{[".includes(seg[k].value) && seg[k].type === "op") d++;
              if ("}]".includes(seg[k].value) && seg[k].type === "op") d--;
              if (d === 0) break;
              if (d === 1 && seg[k].type === "name" && (seg[k + 1].value === "," || seg[k + 1].value === "}" || seg[k + 1].value === "]" || seg[k + 1].value === "=")) {
                names.push(seg[k].value);
                keys.push(seg[k - 1].value === ":" ? seg[k - 2].value : seg[k].value);
              }
            }
            target = { t: "destructure", names, keys };
            j = k + 1;
          }
          else { target = { t: "name", id: seg[1].value }; j = 2; }
          if (seg[j] && seg[j].value === ":") { let d = 0; while (j < seg.length && !(d === 0 && seg[j].value === "=")) { if ("<([{".includes(seg[j].value)) d++; if (">)]}".includes(seg[j].value)) d--; j++; } }
          if (!seg[j] || seg[j].value !== "=") { out.push({ s: "decl", target, line }); continue; }
          const p = new Parser(seg.slice(j + 1).concat([{ type: "eof" }]), "ts"); p.depth = 1;
          out.push({ s: "assign", target, op: "=", value: p.exprOrArrow(), line });
          continue;
        }
        let d = 0, eq = -1;
        for (let k = 0; k < seg.length; k++) { const v = seg[k].value; if (seg[k].type !== "op") continue; if ("([{".includes(v)) d++; else if (")]}".includes(v)) d--; else if (d === 0 && (v === "=" || v === "+=" || v === "-=")) { eq = k; break; } }
        if (eq > 0) {
          const pt = new Parser(seg.slice(0, eq).concat([{ type: "eof" }]), "ts"); pt.depth = 1;
          const pv = new Parser(seg.slice(eq + 1).concat([{ type: "eof" }]), "ts"); pv.depth = 1;
          out.push({ s: "assign", target: pt.expr(), op: seg[eq].value, value: pv.exprOrArrow(), line });
          continue;
        }
        const p = new Parser(seg.concat([{ type: "eof" }]), "ts"); p.depth = 1;
        out.push({ s: "expr", value: p.expr(), line });
      } catch (err) { out.push({ s: "other", src: seg.map((x) => x.value).join(" ").slice(0, 200), err: err.message, line }); }
    }
    return out;
  }

  return { tokenize, Parser, parseExpr, subExpr, lit, loose, nameOf, pyStatements, tsStatements };
});
