import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { limiter, run } from "../../src/server/proc";

describe("run", () => {
  it("keeps a multi-megabyte line whole, like yt-dlp's info JSON", async () => {
    const size = 3 * 1024 * 1024;
    const result = await run(["bun", "-e", `process.stdout.write(JSON.stringify({ pad: "x".repeat(${size}) }) + "\\n")`]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).pad).toHaveLength(size);
  });

  it("stops a program and what it started when aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    // like yt-dlp's PyInstaller launcher: the work happens in a child that keeps stdout open
    const running = run(["sh", "-c", "sleep 30 & wait"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(running).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("lets a stopped program clean up, and kills one that does not stop", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jv-proc-"));
    const cleaned = path.join(dir, "cleaned");
    const polite = new AbortController();
    const politeRun = run(["sh", "-c", `trap 'touch ${cleaned}; exit 0' TERM; sleep 30 & wait`], { signal: polite.signal });
    setTimeout(() => polite.abort(), 200);
    await expect(politeRun).rejects.toThrow();
    expect(existsSync(cleaned)).toBe(true);

    const stubborn = new AbortController();
    const started = Date.now();
    const stubbornRun = run(["sh", "-c", "trap '' TERM; sleep 30"], { signal: stubborn.signal, graceMs: 300 });
    setTimeout(() => stubborn.abort(), 200);
    await expect(stubbornRun).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops at its timeout", async () => {
    const started = Date.now();
    const result = await run(["sh", "-c", "sleep 30 & wait"], { timeoutMs: 200 });
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("keeps the end of stderr", async () => {
    const result = await run(["sh", "-c", "echo start >&2; head -c 10000 /dev/zero | tr '\\\\0' x >&2; echo ERROR: the end >&2; exit 3"]);
    expect(result.code).toBe(3);
    expect(result.stderr.length).toBeLessThanOrEqual(4096);
    expect(result.stderr).toEndWith("ERROR: the end\n");
  });
});

describe("limiter", () => {
  it("runs at most so many at once, in order", async () => {
    const limit = limiter(2);
    let active = 0;
    let most = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      active++;
      most = Math.max(most, active);
      await Bun.sleep(10);
      order.push(n);
      active--;
      return n;
    };
    expect(await Promise.all([1, 2, 3, 4, 5].map((n) => limit(task(n))))).toEqual([1, 2, 3, 4, 5]);
    expect(most).toBe(2);
    expect(order.slice(0, 2).sort()).toEqual([1, 2]);
  });

  it("starts an urgent task before the others waiting", async () => {
    const limit = limiter(1);
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await Bun.sleep(5);
    };
    await Promise.all([limit(task("first")), limit(task("queued")), limit(task("urgent"), undefined, true)]);
    expect(order).toEqual(["first", "urgent", "queued"]);
  });

  it("lets a waiting task become urgent", async () => {
    const limit = limiter(1);
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await Bun.sleep(5);
    };
    let promoted = false;
    const all = Promise.all([limit(task("first")), limit(task("queued")), limit(task("later"), undefined, () => promoted)]);
    promoted = true;
    await all;
    expect(order).toEqual(["first", "later", "queued"]);
  });

  it("drops a waiting task whose signal aborts", async () => {
    const limit = limiter(1);
    let ran = false;
    const first = limit(() => Bun.sleep(30));
    const controller = new AbortController();
    const second = limit(async () => {
      ran = true;
    }, controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow();
    await first;
    await limit(async () => {});
    expect(ran).toBe(false);
  });
});
