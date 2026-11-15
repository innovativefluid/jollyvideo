/**
 * Sharkord's source, at the version Jollyvideo is built against, into
 * .sharkord: for the class check, the preview and the end-to-end test. A tag
 * can be moved, so the commit is checked too.
 */
import { rmSync } from "fs";
import path from "path";

const TAG = "v0.0.31";
const COMMIT = "0da5bc193e45a8bd2d0ae46ef3c46c4a16cc7641";
const target = path.join(import.meta.dir, "../.sharkord");

const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.toString().trim();
};

git("-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", TAG, "https://github.com/sharkord/sharkord.git", target);
const head = git("-C", target, "rev-parse", "HEAD");
if (head !== COMMIT) {
  rmSync(target, { recursive: true, force: true });
  throw new Error(`Sharkord ${TAG} is at ${head}, expected ${COMMIT}`);
}
