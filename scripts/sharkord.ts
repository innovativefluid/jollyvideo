/**
 * Sharkord's source, at the version Jollyvideo is built against, into
 * .sharkord: for the class check, the preview and the end-to-end test. A tag
 * can be moved, so the commit is checked too.
 */
import { rmSync } from "fs";
import path from "path";

const TAG = "v0.0.28";
const COMMIT = "07ab40f7bd8b5102cedb55fa04ed03d22590be6d";
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
