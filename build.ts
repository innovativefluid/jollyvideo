/**
 * Builds the plugin folder Sharkord loads, then packs it:
 *
 *   dist/jollyvideo/                 manifest.json, server/index.js, client/index.js, docs
 *   dist/jollyvideo-<version>.tar.gz for installing from a URL
 *   dist/jollyvideo-<version>.zip    for unpacking into the plugins folder by hand
 *   dist/*.sha256
 *
 * `bun build.ts --no-pack` stops after the folder.
 */
import type { BunPlugin } from "bun";
import { cp, mkdir, rm } from "fs/promises";
import path from "path";
import manifest from "./manifest.json";
import pkg from "./package.json";

const root = import.meta.dir;
const dist = path.join(root, "dist");
const out = path.join(dist, manifest.id);

if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json says ${manifest.version}, package.json says ${pkg.version}`);
}

/**
 * The client runs inside Sharkord and must use its React: a second copy breaks
 * hooks. Every React import becomes a read of the global the host sets up.
 */
const HOST_REACT: Record<string, string> = {
  react: "__SHARKORD_REACT__",
  "react/jsx-runtime": "__SHARKORD_REACT_JSX__",
  "react/jsx-dev-runtime": "__SHARKORD_REACT_JSX_DEV__",
  "react-dom": "__SHARKORD_REACT_DOM__",
  "react-dom/client": "__SHARKORD_REACT_DOM_CLIENT__",
};

const hostReact: BunPlugin = {
  name: "host-react",
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
      if (!HOST_REACT[args.path]) throw new Error(`no host global for ${args.path}`);
      return { path: args.path, namespace: "host-react" };
    });
    build.onLoad({ filter: /.*/, namespace: "host-react" }, (args) => ({
      contents: `module.exports = window.${HOST_REACT[args.path]};`,
      loader: "js",
    }));
  },
};

const check = (result: Awaited<ReturnType<typeof Bun.build>>, name: string) => {
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error(`${name} build failed`);
  }
};

await rm(dist, { recursive: true, force: true });
await mkdir(out, { recursive: true });

check(
  await Bun.build({
    entrypoints: [path.join(root, "src/server/index.ts")],
    outdir: path.join(out, "server"),
    target: "bun",
    format: "esm",
    minify: { syntax: true, whitespace: true },
    naming: "index.js",
  }),
  "server",
);

check(
  await Bun.build({
    entrypoints: [path.join(root, "src/client/index.ts")],
    outdir: path.join(out, "client"),
    target: "browser",
    format: "esm",
    minify: true,
    naming: "index.js",
    plugins: [hostReact],
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  "client",
);

for (const file of ["manifest.json", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
  await cp(path.join(root, file), path.join(out, file));
}

const sizes = await Promise.all(
  ["server/index.js", "client/index.js"].map(async (file) => `${file} ${(Bun.file(path.join(out, file)).size / 1024).toFixed(1)} KB`),
);
console.log(`built ${manifest.id} ${manifest.version}: ${sizes.join(", ")}`);

if (!process.argv.includes("--no-pack")) {
  const base = `${manifest.id}-${manifest.version}`;
  const files: Record<string, Uint8Array> = {};
  for (const file of new Bun.Glob("**/*").scanSync({ cwd: out })) files[`${manifest.id}/${file}`] = await Bun.file(path.join(out, file)).bytes();
  await Bun.Archive.write(path.join(dist, `${base}.tar.gz`), files, { compress: "gzip" });
  const packed = [`${base}.tar.gz`];
  if (Bun.which("zip")) {
    const zip = Bun.spawn(["zip", "-qrX", `${base}.zip`, manifest.id], { cwd: dist, stdout: "inherit", stderr: "inherit" });
    if ((await zip.exited) !== 0) throw new Error("zip failed");
    packed.push(`${base}.zip`);
  } else {
    console.warn("no zip on PATH: skipped the .zip");
  }
  for (const file of packed) {
    const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(dist, file)).bytes()).digest("hex");
    await Bun.write(path.join(dist, `${file}.sha256`), `${hash}  ${file}\n`);
    console.log(`${file} ${hash}`);
  }
}
