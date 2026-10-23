/**
 * The client can only use classes Sharkord's stylesheet already has, and that
 * stylesheet is generated from Sharkord's own source. So every class in
 * `src/client/classes.ts` has to appear in that source, and components may only
 * take their classes from there.
 *
 *   bun run sharkord   # once: Sharkord's source at the version the plugin targets
 *   bun run check
 *
 * SHARKORD_SRC points somewhere else if you keep a checkout already.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { cls } from "../src/client/classes";

const root = path.join(import.meta.dir, "..");
const source = process.env.SHARKORD_SRC ?? path.join(root, ".sharkord");
const scanned = ["apps/client/src", "packages/ui/src"].map((dir) => path.join(source, dir));

if (!scanned.every(existsSync)) {
  console.error(`No Sharkord source at ${source}. Run \`bun run sharkord\`, or set SHARKORD_SRC.`);
  process.exit(1);
}

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => /\.(tsx?|css|html)$/.test(file))
    .map((file) => path.join(dir, file));

const corpus = scanned.flatMap(files).map((file) => readFileSync(file, "utf-8")).join("\n");

/** a class Tailwind picked up: the whole token, not part of a longer one */
const BOUNDARY = /[\s"'`{}()<>,;]/;
const inCorpus = (token: string): boolean => {
  for (let at = corpus.indexOf(token); at !== -1; at = corpus.indexOf(token, at + 1)) {
    const before = corpus[at - 1];
    const after = corpus[at + token.length];
    const quoteInside = token.includes("'");
    const ok = (char: string | undefined) => char === undefined || (BOUNDARY.test(char) && !(quoteInside && char === "'"));
    if (ok(before) && ok(after)) return true;
  }
  return false;
};

const problems: string[] = [];

for (const [name, value] of Object.entries(cls)) {
  for (const token of value.split(/\s+/).filter(Boolean)) {
    if (!inCorpus(token)) problems.push(`cls.${name}: "${token}" is not in Sharkord's source`);
  }
}

// components take classes from `cls` only, so nothing slips past the check above
const clientDir = path.join(root, "src/client");
for (const file of readdirSync(clientDir).filter((name) => name.endsWith(".tsx"))) {
  const text = readFileSync(path.join(clientDir, file), "utf-8");
  for (const match of text.matchAll(/className=(\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
    const value = match[1]!;
    // an expression over `cls` entries, with no strings of its own
    if (!value.startsWith("{") || !value.includes("cls.") || /["'`]/.test(value)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`src/client/${file}:${line}: className must come from cls: ${value}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`classes ok: ${Object.keys(cls).length} groups, all in Sharkord's source`);
