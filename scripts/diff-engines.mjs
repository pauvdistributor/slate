// One-off parity checker: extracts top-level function bodies from both
// pauv-engine.ts files and reports which shared functions differ.
// Usage: node scripts/diff-engines.mjs
import { readFileSync } from "node:fs";

const A = "C:/Users/Optiplex 7080/Desktop/dtm4.1/src/market/pauv-engine.ts";
const B = "C:/Users/Optiplex 7080/Desktop/indexs/src/market/pauv-engine.ts";

function extractFunctions(path) {
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");
  const fns = new Map();
  const re = /^(?:export )?function (\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    // capture until braces balance
    let depth = 0, started = false, body = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]);
      for (const ch of lines[j]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") depth--;
      }
      if (started && depth === 0) break;
    }
    fns.set(m[1], body.join("\n"));
  }
  return fns;
}

// strip comments + whitespace so doc-comment differences don't count
function normalize(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const a = extractFunctions(A);
const b = extractFunctions(B);

const shared = [...a.keys()].filter((k) => b.has(k));
const onlyA = [...a.keys()].filter((k) => !b.has(k));
const onlyB = [...b.keys()].filter((k) => !a.has(k));

console.log("=== shared functions ===");
for (const k of shared) {
  const same = normalize(a.get(k)) === normalize(b.get(k));
  console.log(`${same ? "SAME " : "DIFF "} ${k}`);
}
console.log("\n=== only in dtm4.1 ===\n" + onlyA.join(", "));
console.log("\n=== only in indexs ===\n" + onlyB.join(", "));
