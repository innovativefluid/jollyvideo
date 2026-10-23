/**
 * Looks at the panel without a Sharkord server: Sharkord's own stylesheet,
 * built from its source, around the built client and a pretend store.
 *
 *   bun run sharkord && bun run build && bun run preview
 *
 * Then open the printed address; scripts/preview/harness.tsx lists the
 * scenarios.
 */
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const root = path.join(import.meta.dir, "..");
const source = process.env.SHARKORD_SRC ?? path.join(root, ".sharkord");
const out = path.join(root, "dist/preview");
const client = path.join(root, "dist/jollyvideo/client/index.js");
if (!existsSync(path.join(source, "apps/client/src/index.css"))) throw new Error("No Sharkord source: run `bun run sharkord`");
if (!existsSync(client)) throw new Error("No client build: run `bun run build`");
await mkdir(out, { recursive: true });

// Sharkord's index.css, pointed at its source rather than ours
const css = readFileSync(path.join(source, "apps/client/src/index.css"), "utf-8")
  .replace("@import 'tailwindcss';", `@import 'tailwindcss' source(none);\n@source "${path.join(source, "apps/client/src")}";`)
  .replace(/@source "[^"]*packages\/ui\/src";/, `@source "${path.join(source, "packages/ui/src")}";`);
await writeFile(path.join(out, "in.css"), css);
const tailwind = Bun.spawn([path.join(root, "node_modules/.bin/tailwindcss"), "-i", path.join(out, "in.css"), "-o", path.join(out, "host.css")], { stdout: "ignore", stderr: "inherit" });
if ((await tailwind.exited) !== 0) throw new Error("tailwind failed");

const harness = await Bun.build({ entrypoints: [path.join(import.meta.dir, "preview/harness.tsx")], outdir: out, target: "browser", external: ["/client.js"] });
if (!harness.success) throw new AggregateError(harness.logs, "harness build failed");

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Jollyvideo preview</title><link rel="stylesheet" href="/host.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`;
const files: Record<string, string> = { "/host.css": path.join(out, "host.css"), "/harness.js": path.join(out, "harness.js"), "/client.js": client };
const server = Bun.serve({
  port: Number(process.env.PORT ?? 4999),
  hostname: "127.0.0.1",
  fetch: (req) => {
    const file = files[new URL(req.url).pathname];
    return file ? new Response(Bun.file(file)) : new Response(page, { headers: { "Content-Type": "text/html" } });
  },
});
console.log(`preview at http://127.0.0.1:${server.port}/?scenario=playing`);
