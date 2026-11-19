// Validates every schema, catalog, fixture, eval file, and SKILL.md JSON example under skills/.
// Run with bun scripts/validate-skills.cjs.
const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");

const root = path.resolve(__dirname, "..");
const skills = path.join(root, "skills");
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strictTypes: false });
let failures = 0;
const fail = (msg) => { failures++; console.log("FAIL " + msg); };
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const schemaFiles = {
  verdict: "_shared/verdict.schema.json",
  catalog: "_shared/catalog.schema.json",
  triage: "triage/triage.schema.json",
  specLead: "spec-lead/spec-lead.schema.json",
  buildReport: "builder/build-report.schema.json",
  plan: "verifier/plan.schema.json",
  evidence: "verifier/evidence-index.schema.json",
  results: "verifier/results.schema.json",
};
const validators = {};
for (const [k, f] of Object.entries(schemaFiles)) {
  try { validators[k] = ajv.compile(read(path.join(skills, f))); console.log("ok   schema " + f); }
  catch (e) { fail("schema " + f + ": " + e.message); }
}
function check(kind, value, label, expectValid = true) {
  const v = validators[kind];
  const ok = v(value);
  if (ok !== expectValid) fail(`${label} against ${kind}: ${ok ? "unexpectedly valid" : JSON.stringify(v.errors, null, 1)}`);
  else console.log(`ok   ${label} (${kind}${expectValid ? "" : ", rejected as expected"})`);
}

for (const c of ["architect", "infra", "frontend"]) check("catalog", read(path.join(skills, c, "catalog.json")), c + "/catalog.json");

// Fixtures by file name.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(skills);
for (const f of files.filter((x) => x.endsWith(".json"))) {
  const rel = path.relative(skills, f);
  let v;
  try { v = read(f); } catch (e) { fail("parse " + rel + ": " + e.message); continue; }
  if (rel.endsWith(".build-report.json")) check("buildReport", v, rel);
  else if (/taskdirs\/[^/]+\/triage\.json$/.test(rel)) check("triage", v, rel);
  else if (/taskdirs\/[^/]+\/spec-lead\.json$/.test(rel)) check("specLead", v, rel);
  else if (/(-verdict|-review|-audit|security-auditor-r1)\.json$/.test(rel)) check("verdict", v, rel);
  else if (rel.endsWith("sort-plan.json")) check("plan", v, rel);
  else if (/sort-evidence-.*\.json$/.test(rel)) check("evidence", v, rel);
}

// JSON examples in SKILL.md files, matched to a schema by their shape.
for (const f of files.filter((x) => x.endsWith("SKILL.md"))) {
  const rel = path.relative(skills, f);
  const text = fs.readFileSync(f, "utf8");
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  blocks.forEach((b, i) => {
    let v;
    try { v = JSON.parse(b); } catch (e) { fail(`${rel} json block ${i + 1} does not parse: ${e.message}`); return; }
    const kind = v.verdict && v.role ? "verdict" : v.tierReasons ? "triage" : v.acceptanceCriteria && v.team ? "specLead"
      : v.mode ? "buildReport" : v.criteria ? "plan" : v.rows ? "results" : null;
    if (!kind) { console.log(`skip ${rel} json block ${i + 1} (no schema)`); return; }
    check(kind, v, `${rel} example ${i + 1}`);
  });
}

// Eval files: shape, fixture paths, inline documents.
const fixtureExists = (evalDir, p) => fs.existsSync(path.resolve(evalDir, p));
const CONTROL_RESPONSES = ["skill-example", "fix-first"];
function checkExpect(label, list, seen = new Set()) {
  for (const e of list) {
    if (!["deterministic", "judge"].includes(e.kind) || !e.id || !e.check || seen.has(e.id)) fail(`${label}: bad expect ${JSON.stringify(e)}`);
    seen.add(e.id);
  }
  return seen;
}
function checkInput(label, dir, input) {
  if (input.repo) {
    const fx = path.resolve(dir, input.repo.fixture);
    if (!fs.existsSync(path.join(fx, "base"))) fail(`${label}: repo fixture ${input.repo.fixture} has no base/`);
    if (input.repo.patch && !fs.existsSync(path.join(fx, input.repo.patch))) fail(`${label}: patch ${input.repo.patch} missing`);
  }
  for (const [target, src] of Object.entries(input.files || {})) {
    if (/^previous\//.test(target)) fail(`${label}: ${target} uses the old previous/ layout`);
    if (typeof src === "string") {
      if (!fixtureExists(dir, src)) { fail(`${label}: fixture ${src} missing`); continue; }
      if (/verdicts\/[a-z-]+\.json$/.test(target)) check("verdict", read(path.resolve(dir, src)), `${label} ${target}`);
      if (/(^|\/)build-report\.json$/.test(target)) check("buildReport", read(path.resolve(dir, src)), `${label} ${target}`);
      if (/(^|\/)spec-lead\.json$/.test(target)) check("specLead", read(path.resolve(dir, src)), `${label} ${target}`);
      continue;
    }
    const v = src.inline;
    if (v === undefined) { fail(`${label}: ${target} has neither a path nor inline`); continue; }
    if (/(^|\/)triage\.json$/.test(target)) check("triage", v, `${label} inline ${target}`);
    if (/(^|\/)spec-lead\.json$/.test(target)) check("specLead", v, `${label} inline ${target}`);
  }
  const prev = (input.brief || {}).previous || {};
  const staged = Object.keys(input.files || {});
  for (const p of [prev.verdict, prev.buildReport, ...(prev.findings || []).map((x) => x.path)].filter(Boolean)) {
    if (!staged.includes(p)) fail(`${label}: previous names ${p}, which is not staged`);
  }
  if (prev.specSetDir && !staged.some((s) => s.startsWith(prev.specSetDir + "/"))) fail(`${label}: nothing staged under ${prev.specSetDir}`);
}
let variantCount = 0;
for (const f of files.filter((x) => x.endsWith(path.join("evals", "evals.json")))) {
  const rel = path.relative(skills, f);
  const dir = path.dirname(f);
  const doc = read(f);
  const skill = rel.split(path.sep)[0];
  if (doc.skill !== skill) fail(`${rel}: skill is ${doc.skill}`);
  if (!fixtureExists(dir, doc.method)) fail(`${rel}: method ${doc.method} missing`);
  if (doc.cases.length < 2 || doc.cases.length > 3) fail(`${rel}: ${doc.cases.length} cases`);
  const ids = new Set();
  for (const c of doc.cases) {
    const label = `${rel} ${c.id}`;
    if (!new RegExp(`^${skill}-\\d\\d-[a-z0-9-]+$`).test(c.id) || ids.has(c.id)) fail(`${rel}: bad or duplicate id ${c.id}`);
    ids.add(c.id);
    for (const k of ["purpose", "pilot"]) if (!(k in c)) fail(`${label}: missing ${k}`);
    const checkControls = (controls, checks, context) => {
      for (const control of controls || []) {
        if (!control.id || !CONTROL_RESPONSES.includes(control.response) ||
            !Array.isArray(control.mustFail) || !control.mustFail.length)
          throw new Error(context + ": invalid control");
        for (const id of control.mustFail)
          if (!checks.has(id)) fail(context + ": control names unknown check " + id);
      }
    };
    if (c.variants) {
      if ("input" in c) fail(`${label}: has both input and variants`);
      if (c.variants.length < 2) fail(`${label}: fewer than two variants`);
      const vids = new Set();
      for (const v of c.variants) {
        const vl = `${label}/${v.id}`;
        if (!/^[a-z0-9-]+$/.test(v.id || "") || vids.has(v.id)) fail(`${vl}: bad or duplicate variant id`);
        vids.add(v.id); variantCount++;
        for (const k of ["purpose", "input", "expect", "pass"]) if (!(k in v)) fail(`${vl}: missing ${k}`);
        const seen = checkExpect(vl, (c.expect || []).concat(v.expect));
        checkControls([...(c.controls || []), ...(v.controls || [])], seen, vl);
        checkInput(vl, dir, v.input);
      }
    } else {
      for (const k of ["input", "expect", "pass"]) if (!(k in c)) fail(`${label}: missing ${k}`);
      checkControls(c.controls, checkExpect(label, c.expect), label);
      checkInput(label, dir, c.input);
    }

  }
  console.log(`ok   ${rel}: ${doc.cases.length} cases`);
}
console.log(`ok   ${variantCount} variants`);

// Mutations: every base is valid, every schemaRejects case is rejected, every joinRejects case is still valid.
const mut = read(path.join(skills, "_shared/evals/mutations.json"));
const bySchema = Object.fromEntries(Object.entries(schemaFiles).map(([k, f]) => [f, k]));
const clone = (x) => JSON.parse(JSON.stringify(x));
const baseDoc = (name) => {
  const b = mut.bases[name];
  if (!b) throw new Error("unknown base " + name);
  return { kind: bySchema[b.schema], doc: clone(b.file ? read(path.join(skills, b.file)) : b.inline) };
};
function apply(doc, op) {
  const parts = op.path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!op.path.startsWith("/") || parts.some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
    throw new Error("invalid mutation pointer " + op.path);
  let cur = doc;
  for (const k of parts.slice(0, -1)) { cur = cur[k]; if (cur === undefined) throw new Error("no such path " + op.path); }
  const last = parts[parts.length - 1];
  if (op.op === "set") cur[last] = clone(op.value);
  else if (op.op === "remove") {
    if (!Object.hasOwn(cur, last)) throw new Error("nothing to remove at " + op.path);
    if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last];
  } else throw new Error("unknown op " + op.op);
}
for (const [name, b] of Object.entries(mut.bases)) {
  if (!bySchema[b.schema]) { fail(`mutations base ${name}: unknown schema ${b.schema}`); continue; }
  const { kind, doc } = baseDoc(name);
  check(kind, doc, `mutations base ${name}`);
}
const mutIds = new Set();
for (const [group, expectValid] of [["schemaRejects", false], ["joinRejects", true]]) {
  for (const c of mut[group].cases) {
    if (mutIds.has(c.id)) fail(`mutations: duplicate id ${c.id}`);
    mutIds.add(c.id);
    try {
      const { kind, doc } = baseDoc(c.base);
      c.ops.forEach((op) => apply(doc, op));
      check(kind, doc, `mutation ${c.id}`, expectValid);
      for (const src of Object.values(c.with || {})) if (!fs.existsSync(path.join(skills, src))) fail(`mutation ${c.id}: ${src} missing`);
    } catch (e) { fail(`mutation ${c.id}: ${e.message}`); }
  }
}
// A rejected mutation must be rejected for its own change: each single-op case's base differs from it by one value only, which the base check above proves valid.

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
