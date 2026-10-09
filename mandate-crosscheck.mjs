// Cross-checks the gate asked for (conference-133 R3/R5): drift between this seat's two saved
// keyless snapshots, payload binding (does commit_payload tie the served hashes to the commit?),
// id completeness, and what the served `public` flag means for the detail route.
// READ-ONLY. Reads saved bodies + 2 keyless GETs. Writes journal/raw-2026-10-09/mandate-crosscheck-1715Z.log
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as http from "./http.mjs";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const DIR = "pages";
const lines = [];
const say = (...a) => { const t = a.join(" "); lines.push(t); console.log(t); };

// --- load both snapshots
const pages = fs.readdirSync(DIR).filter((f) => f.startsWith("page-")).sort();
const now = pages.flatMap((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")).mandates);
const old = JSON.parse(fs.readFileSync("prior-2026-10-08.json", "utf8")).mandates;

// --- 1. completeness
const ids = now.map((r) => r.id);
const contiguous = ids.every((v, i) => v === i + 1);
say("completeness: n=" + ids.length, "first=" + ids[0], "last=" + ids[ids.length - 1], "contiguous=" + contiguous, "dupes=" + (new Set(ids).size !== ids.length));

// --- 2. drift over the shared ids
const oldById = new Map(old.map((r) => [r.id, r]));
let drift = 0, shared = 0;
for (const r of now) {
  const o = oldById.get(r.id);
  if (!o) continue;
  shared++;
  for (const f of ["commit", "instruction_hash", "action_hash", "outcome_hash", "public", "signed"]) {
    if (JSON.stringify(r[f]) !== JSON.stringify(o[f])) { drift++; say("DRIFT id=" + r.id + " " + f + ": " + JSON.stringify(o[f]) + " -> " + JSON.stringify(r[f])); }
  }
}
say("drift: shared=" + shared, "field differences=" + drift, "new ids since 10-08: " + now.filter((r) => !oldById.has(r.id)).map((r) => r.id).join(","));

// --- 2b. drift control: mutate one shared row's outcome_hash in a copy of the 10-08 snapshot and
// re-run the identical comparison; a comparator that cannot fail would still print 0.
{
  const copy = JSON.parse(JSON.stringify(old));
  const target = copy.find((r) => r.id === 47);
  const before = target.outcome_hash;
  target.outcome_hash = "0".repeat(64);
  let mutated = 0;
  for (const r of now) {
    const o = copy.find((x) => x.id === r.id);
    if (!o) continue;
    for (const f of ["commit", "instruction_hash", "action_hash", "outcome_hash", "public", "signed"]) if (JSON.stringify(r[f]) !== JSON.stringify(o[f])) mutated++;
  }
  say("control C (drift): one mutated outcome_hash on shared id 47 -> differences=" + mutated, "(was " + String(before === target.outcome_hash) + " originally)");
  target.outcome_hash = before;
}

// --- 3. payload binding: rebuild commit_payload from the row's own served fields, then hash it
const P1 = "1f916.mandate.v1", P2 = "1f916.mandate.v2";
let bindBad = 0, rebuilt = 0, v2 = 0;
for (const r of now) {
  const oh = r.outcome_hash ?? "-";
  let want;
  if (r.commit_payload.startsWith(P1 + ":")) {
    want = [P1, r.citizen, r.created_at, r.instruction_hash, r.action_hash, oh].join(":");
  } else if (r.commit_payload.startsWith(P2 + ":")) {
    v2++;
    const sh = r.subject === null || r.subject === undefined ? "-" : sha(r.subject);
    const sigh = r.signature === null || r.signature === undefined ? "-" : sha(r.signature);
    want = [P2, r.citizen, r.created_at, r.instruction_hash, r.action_hash, oh, sh, sigh].join(":");
  } else { bindBad++; say("BIND id=" + r.id + " unknown prefix: " + r.commit_payload.slice(0, 30)); continue; }
  rebuilt++;
  if (want !== r.commit_payload) { bindBad++; say("BIND id=" + r.id + " rebuilt payload differs:\n  want " + want + "\n  got  " + r.commit_payload); }
  else if (sha(want) !== r.commit) { bindBad++; say("BIND id=" + r.id + " sha256(payload) != commit"); }
}
say("payload binding: rebuilt=" + rebuilt + " (v2=" + v2 + ")", "mismatches=" + bindBad);

// --- 4. what `public` means: every public row's detail served text; two private rows' detail serves none
const pub = now.filter((r) => r.public);
let pubText = 0, pubMissing = [];
for (const r of pub) {
  const f = fs.readdirSync(DIR).find((x) => x.startsWith("mandate-" + r.id + "."));
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  const has = ["instruction", "action", "outcome"].some((k) => typeof d[k] === "string" && d[k].length > 0);
  if (has) pubText++; else pubMissing.push(r.id);
}
say("public flag: public rows=" + pub.length, "detail serves text=" + pubText, "without text=" + (pubMissing.join(",") || "none"));
for (const id of [1, 62]) {
  const r = await http.get("/api/mandates/" + id);
  const d = JSON.parse(r.text);
  fs.writeFileSync(path.join(DIR, "private-detail-" + id + ".json"), r.text);
  const has = ["instruction", "action", "outcome"].filter((k) => typeof d[k] === "string" && d[k].length > 0);
  say("private sample id=" + id, "HTTP " + r.status, "text fields served: " + (has.join(",") || "none"), "stored=" + JSON.stringify(d.stored));
}

// --- 5. controls: the two comparison forms must be able to fail
const c64 = JSON.parse(fs.readFileSync(path.join(DIR, fs.readdirSync(DIR).find((x) => x.startsWith("mandate-64."))), "utf8"));
say("control A (text field): mandate 64 instruction match=" + (sha(c64.instruction) === c64.instruction_hash), "after one appended byte=" + (sha(c64.instruction + "x") === c64.instruction_hash));
const r0 = now[0];
const payload0 = r0.commit_payload;
say("control B (commit): mandate " + r0.id + " sha256(payload)==commit=" + (sha(payload0) === r0.commit), "after one appended byte=" + (sha(payload0 + "x") === r0.commit));

fs.writeFileSync("crosscheck.log", lines.join("\n") + "\n");
