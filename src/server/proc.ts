/** Small helpers around child processes. */

export type TRunResult = { code: number; stdout: string; stderr: string };

export type TRunOptions = {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** called for every stdout line; stdout is then not collected */
  onLine?: (line: string) => void;
};

const MAX_COLLECTED = 8 * 1024 * 1024;
const STDERR_TAIL = 4096;

/** calls `onLine` for every line of a byte stream */
export const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> => {
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
    // a runaway line without a newline is dropped rather than kept growing
    if (rest.length > 64 * 1024) rest = "";
  }
  rest += decoder.decode();
  if (rest) onLine(rest);
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

/** runs a program to its end; never throws for a non-zero exit, only for one that cannot start */
export const run = async (cmd: string[], options: TRunOptions = {}): Promise<TRunResult> => {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(cmd, { env: options.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", kill, { once: true });
  const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
  try {
    let stdout = "";
    const out = options.onLine
      ? readLines(child.stdout, options.onLine)
      : readLines(child.stdout, (line) => {
          if (stdout.length < MAX_COLLECTED) stdout += `${line}\n`;
        });
    const [stderr, code] = await Promise.all([tail(child.stderr), child.exited, out]);
    options.signal?.throwIfAborted();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
};
