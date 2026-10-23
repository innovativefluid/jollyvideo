/** Small helpers around child processes. */

export type TRunResult = { code: number; stdout: string; stderr: string };

export type TRunOptions = {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** called for every stdout line; stdout is then not collected */
  onLine?: (line: string) => void;
};

/** yt-dlp's info JSON is one line, and with every format and caption listed it can run to megabytes */
const MAX_COLLECTED = 32 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const STDERR_TAIL = 4096;

/** calls `onLine` for every line of a byte stream; a line longer than `maxLine` is dropped */
export const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, maxLine = MAX_LINE): Promise<void> => {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    let end = rest.search(/[\r\n]/);
    while (end !== -1) {
      const line = rest.slice(0, end);
      rest = rest.slice(end + 1);
      if (line) onLine(line);
      end = rest.search(/[\r\n]/);
    }
    if (rest.length > maxLine) rest = "";
  }
  rest += decoder.decode();
  if (rest) onLine(rest);
};

/** all of a stream as text, up to `max` characters */
const collect = async (stream: ReadableStream<Uint8Array>, max = MAX_COLLECTED): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    if (text.length < max) text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
};

/** keeps the end of a stream, which is where programs put their errors */
export const tail = async (stream: ReadableStream<Uint8Array>, size = STDERR_TAIL): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text = (text + decoder.decode(chunk, { stream: true })).slice(-size);
  }
  return (text + decoder.decode()).slice(-size);
};

/**
 * Kills a process and everything it started. yt-dlp's release builds are
 * PyInstaller programs, a launcher that runs the real yt-dlp as a child: a
 * kill that reaches only the launcher leaves the download going.
 */
export const killTree = (child: { pid: number; kill(signal?: number | NodeJS.Signals): void }): void => {
  try {
    if (process.platform === "win32") {
      Bun.spawn(["taskkill", "/pid", String(child.pid), "/T", "/F"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } else {
      // spawned detached, so the child leads its own process group
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
};

/** runs a program to its end; never throws for a non-zero exit, only for one that cannot start or is aborted */
export const run = async (cmd: string[], options: TRunOptions = {}): Promise<TRunResult> => {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(cmd, {
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  const kill = () => killTree(child);
  options.signal?.addEventListener("abort", kill, { once: true });
  const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
  try {
    const stdout = options.onLine ? readLines(child.stdout, options.onLine).then(() => "") : collect(child.stdout);
    const [out, stderr, code] = await Promise.all([stdout, tail(child.stderr), child.exited]);
    options.signal?.throwIfAborted();
    return { code, stdout: out, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
};

/**
 * At most `size` tasks at a time; the rest wait their turn. A task whose
 * signal aborts while it waits never starts.
 */
export const limiter = (size: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  // a finished task hands its place straight to the next one
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    if (active < size) {
      active++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          waiting.splice(waiting.indexOf(go), 1);
          reject(signal?.reason ?? new Error("aborted"));
        };
        waiting.push(go);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
};
