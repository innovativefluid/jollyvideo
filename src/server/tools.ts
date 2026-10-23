/**
 * yt-dlp and ffmpeg. Taken from the environment when present, otherwise
 * downloaded into the plugin's data folder, which Sharkord keeps across plugin
 * updates. Every download is checked against a SHA-256: yt-dlp's comes from its
 * GitHub release, ffmpeg's is pinned below.
 */
import { createReadStream, existsSync } from "fs";
import { createGunzip } from "zlib";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { errorText } from "./errors";

type TLog = { log(...args: unknown[]): void; error(...args: unknown[]): void };

type TPinned = { url: string; sha256: string; entry: string };

const exe = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);
const PLATFORM = `${process.platform}-${process.arch}`;

const YT_DLP_ASSETS: Record<string, string> = {
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
  "win32-x64": "yt-dlp.exe",
  "darwin-x64": "yt-dlp_macos",
  "darwin-arm64": "yt-dlp_macos",
};

// the build Sharkord's own music-bot plugin uses: one binary in a .tar.gz
// (Sharkord's Docker image has no xz for the usual .tar.xz builds), with
// libx264 and libopus
const FFMPEG_RELEASE = "https://github.com/diogomartino/plugin-binaries/releases/download/0.0.1";
const FFMPEG_BUILDS: Record<string, TPinned> = {
  "linux-x64": {
    url: `${FFMPEG_RELEASE}/ffmpeg-linux-x64.tar.gz`,
    sha256: "da7f697fc9eaf4c878d4fc7d2dde589538b6856467aa81890afaab0a28114b42",
    entry: "ffmpeg-linux-x64",
  },
  "linux-arm64": {
    url: `${FFMPEG_RELEASE}/ffmpeg-linux-arm64.tar.gz`,
    sha256: "4fc0b07bf69dbaf189eb6f952601a80c2eaa48556e27119a1c5d04defc79c827",
    entry: "ffmpeg-linux-arm64",
  },
  "win32-x64": {
    url: `${FFMPEG_RELEASE}/ffmpeg-win64.tar.gz`,
    sha256: "9099d52959ca4d62162551767856bd81c7dd881a29fa91e6d7ac9d955a6cd4c4",
    entry: "ffmpeg-win64.exe",
  },
};

/** a program on PATH, as PATH is now */
const which = (name: string): string | undefined => Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined;

const USER_AGENT = "jollyvideo (Sharkord plugin)";
const FLUSH_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

/** streams a download to `target`, rejecting it unless its SHA-256 matches */
export const downloadVerified = async (url: string, sha256: string, target: string, log: TLog): Promise<void> => {
  log.log(`[tools] downloading ${path.basename(new URL(url).pathname)}`);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
  const hash = new Bun.CryptoHasher("sha256");
  const file = Bun.file(target).writer();
  let bytes = 0;
  let unflushed = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error("download is larger than expected");
      hash.update(chunk);
      file.write(chunk);
      // a fast network would otherwise pile the download up in memory
      unflushed += chunk.byteLength;
      if (unflushed > FLUSH_BYTES) {
        unflushed = 0;
        await file.flush();
      }
    }
  } finally {
    await file.end();
  }
  if (hash.digest("hex") !== sha256.toLowerCase()) {
    await rm(target, { force: true });
    throw new Error("download does not match its SHA-256");
  }
};

/** reads a stream in pieces of the sizes asked for */
class Bytes {
  private readonly source: AsyncIterator<Uint8Array>;
  private readonly queue: Uint8Array[] = [];
  private queued = 0;
  private ended = false;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.source = stream[Symbol.asyncIterator]();
  }

  private async fill(size: number) {
    while (this.queued < size && !this.ended) {
      const { value, done } = await this.source.next();
      if (done) this.ended = true;
      else {
        this.queue.push(value);
        this.queued += value.byteLength;
      }
    }
  }

  /** up to `size` bytes from the front of what is queued */
  private take(size: number): Uint8Array {
    const first = this.queue[0]!;
    if (first.byteLength <= size) {
      this.queue.shift();
      this.queued -= first.byteLength;
      return first;
    }
    this.queue[0] = first.subarray(size);
    this.queued -= size;
    return first.subarray(0, size);
  }

  /** exactly `size` bytes, or null at the end */
  async read(size: number): Promise<Uint8Array | null> {
    await this.fill(size);
    if (this.queued < size) return null;
    const out = new Uint8Array(size);
    for (let at = 0; at < size; ) {
      const piece = this.take(size - at);
      out.set(piece, at);
      at += piece.byteLength;
    }
    return out;
  }

  /** the next `size` bytes, as they arrive */
  async *pieces(size: number): AsyncGenerator<Uint8Array> {
    for (let left = size; left > 0; ) {
      await this.fill(1);
      if (!this.queued) throw new Error("archive ends early");
      const piece = this.take(left);
      left -= piece.byteLength;
      yield piece;
    }
  }

  async skip(size: number): Promise<void> {
    for await (const _ of this.pieces(size)) {
      // dropped
    }
  }

  async close(): Promise<void> {
    await this.source.return?.()?.catch(() => {});
  }
}

const textOf = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
};

/** a tar header number: octal text, or big-endian binary when the first bit is set */
const numberOf = (bytes: Uint8Array): number => {
  if (bytes[0]! & 0x80) return bytes.subarray(1).reduce((sum, byte) => sum * 256 + byte, bytes[0]! & 0x7f);
  return parseInt(textOf(bytes).trim() || "0", 8);
};

/**
 * Writes the regular file `entry` of a .tar.gz to `target`, one piece at a
 * time: the unpacked archive never sits in memory whole. Says whether it was
 * there.
 */
export const extractEntry = async (archive: string, entry: string, target: string): Promise<boolean> => {
  // node's gunzip: Bun's DecompressionStream reads far ahead, about 100 MB here
  const gunzip = createReadStream(archive).pipe(createGunzip());
  const bytes = new Bytes(gunzip);
  try {
    // a long name from the entry before: GNU ("L") or pax ("x") style
    let longName: string | null = null;
    for (;;) {
      const header = await bytes.read(512);
      if (!header || header.every((byte) => byte === 0)) return false;
      const size = numberOf(header.subarray(124, 136));
      const type = String.fromCharCode(header[156]!);
      const padded = Math.ceil(size / 512) * 512;
      const prefix = textOf(header.subarray(345, 500));
      const name = longName ?? (prefix ? `${prefix}/${textOf(header.subarray(0, 100))}` : textOf(header.subarray(0, 100)));
      longName = null;
      if (type === "L" || type === "x") {
        if (size > 1024 * 1024) throw new Error("archive header is too large");
        const data = (await bytes.read(padded))?.subarray(0, size);
        if (!data) return false;
        const text = new TextDecoder().decode(data);
        longName = type === "L" ? textOf(data) : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? null);
        continue;
      }
      if ((type === "0" || type === "\0") && name.replace(/^\.\//, "") === entry) {
        const file = Bun.file(target).writer();
        try {
          for await (const piece of bytes.pieces(size)) {
            file.write(piece);
            await file.flush();
          }
        } finally {
          await file.end();
        }
        return true;
      }
      await bytes.skip(padded);
    }
  } finally {
    await bytes.close();
    gunzip.destroy();
  }
};

export class Toolbox {
  readonly binDir: string;
  private running: Promise<void> | null = null;
  /** a refresh asked for during a run: one, however often it is asked for */
  private refreshAfter: Promise<void> | null = null;

  constructor(dataPath: string, private readonly log: TLog) {
    this.binDir = path.join(dataPath, "bin");
  }

  private find(name: string, envVar: string): string | undefined {
    const configured = process.env[envVar]?.trim();
    if (configured) return configured;
    const own = path.join(this.binDir, exe(name));
    if (existsSync(own)) return own;
    return which(exe(name));
  }

  ytDlp = (): string | undefined => this.find("yt-dlp", "JOLLYVIDEO_YT_DLP");
  ffmpeg = (): string | undefined => this.find("ffmpeg", "JOLLYVIDEO_FFMPEG");

  /** cookies.txt in the bin folder, for servers YouTube asks to sign in */
  cookies = (): string | undefined => {
    const file = path.join(this.binDir, "cookies.txt");
    return existsSync(file) ? file : undefined;
  };

  /**
   * yt-dlp solves YouTube's player challenges by running YouTube's JavaScript.
   * It gets every runtime there is and uses the best one it supports: Deno or
   * Node (run with permission limits, but only recent versions qualify), else
   * Bun. Without Bun on PATH, Sharkord's standalone binary is itself a
   * compiled Bun program that acts as `bun` when BUN_BE_BUN=1.
   */
  jsRuntime = (): { args: string[]; env: Record<string, string> } => {
    const args = ["deno", "node"].flatMap((runtime) => {
      const found = which(runtime);
      return found ? ["--js-runtimes", `${runtime}:${found}`] : [];
    });
    const bun = which("bun");
    if (bun) return { args: [...args, "--js-runtimes", `bun:${bun}`], env: {} };
    return { args: [...args, "--js-runtimes", `bun:${process.execPath}`], env: { BUN_BE_BUN: "1" } };
  };

  get installing(): boolean {
    return this.running !== null;
  }

  /** days since our own yt-dlp was downloaded; undefined when it comes from elsewhere */
  ytDlpAge = async (): Promise<number | undefined> => {
    const own = path.join(this.binDir, exe("yt-dlp"));
    if (this.ytDlp() !== own || !existsSync(own)) return undefined;
    return (Date.now() - (await stat(own)).mtimeMs) / 86_400_000;
  };

  /**
   * Fetches what is missing, plus a fresh yt-dlp when asked. Only one run at a
   * time; a failing tool does not stop the other.
   */
  ensure = (options: { refreshYtDlp?: boolean } = {}): Promise<void> => {
    // a refresh asked for during another run happens after it, once
    if (this.running && options.refreshYtDlp) {
      this.refreshAfter ??= this.running
        .catch(() => {})
        .then(() => {
          this.refreshAfter = null;
          return this.ensure(options);
        });
      return this.refreshAfter;
    }
    this.running ??= (async () => {
      await mkdir(this.binDir, { recursive: true });
      const failures: string[] = [];
      if (options.refreshYtDlp || !this.ytDlp()) {
        await this.installYtDlp().catch((error) => failures.push(`yt-dlp: ${errorText(error)}`));
      }
      if (!this.ffmpeg()) {
        await this.installFfmpeg().catch((error) => failures.push(`ffmpeg: ${errorText(error)}`));
      }
      if (failures.length) throw new Error(failures.join("; "));
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  };

  private async installYtDlp(): Promise<void> {
    const asset = YT_DLP_ASSETS[PLATFORM];
    if (!asset) throw new Error(`no build for ${PLATFORM}; install yt-dlp on the server instead`);
    const response = await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
    const release = (await response.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; digest?: string }[] };
    const file = release.assets?.find((item) => item.name === asset);
    const digest = file?.digest?.startsWith("sha256:") ? file.digest.slice(7) : undefined;
    if (!file || !digest) throw new Error(`release ${release.tag_name ?? "?"} has no checksummed ${asset}`);
    const temp = path.join(this.binDir, `.yt-dlp-${crypto.randomUUID()}`);
    try {
      await downloadVerified(file.browser_download_url, digest, temp, this.log);
      await chmod(temp, 0o755);
      await rename(temp, path.join(this.binDir, exe("yt-dlp")));
    } finally {
      await rm(temp, { force: true });
    }
    await this.note("yt-dlp", { version: release.tag_name, sha256: digest });
    this.log.log(`[tools] yt-dlp ${release.tag_name} ready`);
  }

  private async installFfmpeg(): Promise<void> {
    const build = FFMPEG_BUILDS[PLATFORM];
    if (!build) throw new Error(`no build for ${PLATFORM}; install ffmpeg on the server instead`);
    const temp = path.join(this.binDir, `.ffmpeg-${crypto.randomUUID()}`);
    try {
      await downloadVerified(build.url, build.sha256, `${temp}.tar.gz`, this.log);
      // only the one expected entry is written, so paths inside the archive never matter
      if (!(await extractEntry(`${temp}.tar.gz`, build.entry, temp))) throw new Error(`archive has no ${build.entry}`);
      await chmod(temp, 0o755);
      await rename(temp, path.join(this.binDir, exe("ffmpeg")));
    } finally {
      await rm(temp, { force: true });
      await rm(`${temp}.tar.gz`, { force: true });
    }
    await this.note("ffmpeg", { url: build.url, sha256: build.sha256 });
    this.log.log("[tools] ffmpeg ready");
  }

  /** what was installed and from where, next to the binaries */
  private async note(tool: string, details: Record<string, unknown>): Promise<void> {
    const file = path.join(this.binDir, "installed.json");
    let notes: Record<string, unknown> = {};
    try {
      notes = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    } catch {
      // first entry
    }
    notes[tool] = { ...details, installedAt: new Date().toISOString() };
    await writeFile(file, `${JSON.stringify(notes, null, 2)}\n`);
  }
}
