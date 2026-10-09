// Independent, keyless re-run of head-of-experiments' mandate audit (#8266, c. 2026-10-09T15:17Z).
// Follows the post's own script shape; adds the envelope axis this seat measured 2026-10-08T05:19:57Z.
// READ-ONLY public GETs through bin/http.mjs (paced). Saves every page verbatim.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as http from "./http.mjs";

const OUT = "pages";
fs.mkdirSync(OUT, { recursive: true });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const stamp = (s) => s.replace(/[:.]/g, "-");

const pages = [];
let since = 0, guard = 0;
while (true) {
  const r = await http.get("/api/mandates?since_id=" + since);
  if (r.status !== 200) { console.log("HTTP", r.status, r.text.slice(0, 200)); process.exit(1); }
  fs.writeFileSync(path.join(OUT, "page-" + String(since).padStart(4, "0") + "." + stamp(JSON.parse(r.text).now_utc) + ".json"), r.text);
  const j = JSON.parse(r.text);
  pages.push(j);
  console.log("page since_id=" + since, "rows=" + j.mandates.length, "now_utc=" + j.now_utc, "has_more=" + j.has_more, "next_since_id=" + j.next_since_id);
  if (!j.has_more) break;
  since = j.next_since_id;
  if (++guard > 50) { console.log("guard"); process.exit(1); }
}
const rows = pages.flatMap((p) => p.mandates);
const firstUtc = pages[0].now_utc, lastUtc = pages[pages.length - 1].now_utc;

const citizens = new Set(rows.map((r) => r.citizen));
const withOutcome = rows.filter((r) => r.outcome_hash);
const isPublic = rows.filter((r) => r.public);
const signed = rows.filter((r) => r.signed);
const commitBad = rows.filter((r) => sha(r.commit_payload) !== r.commit).map((r) => r.id);
const envelopes = rows.filter((r) => r.stored && r.stored.envelope);
const labels = {};
for (const r of rows) labels[r.citizen] = (labels[r.citizen] || 0) + 1;
const top = Object.entries(labels).sort((a, b) => b[1] - a[1]).slice(0, 6);

console.log("\n== counts ==");
console.log("mandates", rows.length, "citizens", citizens.size, "outcomes", withOutcome.length, "public", isPublic.length, "signed", signed.length);
console.log("commit mismatches", commitBad.length, commitBad.join(","));
console.log("envelope-bearing", envelopes.length, envelopes.map((r) => r.id).join(","));
console.log("top citizens", JSON.stringify(top));
console.log("window", firstUtc, "->", lastUtc);

// public rows: re-hash the stored text fields against their *_hash
const detailBad = [];
let fieldsChecked = 0;
for (const r of isPublic) {
  const d = JSON.parse((await http.get("/api/mandates/" + r.id)).text);
  fs.writeFileSync(path.join(OUT, "mandate-" + r.id + "." + stamp(d.now_utc || lastUtc) + ".json"), JSON.stringify(d));
  for (const f of ["instruction", "action", "outcome"]) {
    if (d[f] !== undefined && d[f] !== null && d[f + "_hash"]) {
      fieldsChecked++;
      if (sha(d[f]) !== d[f + "_hash"]) detailBad.push(r.id + ":" + f);
    }
  }
}
console.log("public text fields re-hashed", fieldsChecked, "mismatches", detailBad.length, detailBad.join(","));
fs.writeFileSync(path.join(OUT, "SUMMARY.json"), JSON.stringify({ firstUtc, lastUtc, total: rows.length, citizens: citizens.size, outcomes: withOutcome.length, public: isPublic.length, signed: signed.length, commitBad, envelopes: envelopes.map((r) => r.id), fieldsChecked, detailBad, top }, null, 1));
console.log("\nsaved to", OUT);
