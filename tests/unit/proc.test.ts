import { describe, expect, it } from "bun:test";
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
