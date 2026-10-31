/**
 * Video thumbnails and storyboards (the small frames the time bar previews),
 * fetched by the server so viewers' browsers never contact YouTube. Only
 * images of videos playing are served, and only the last few are kept in
 * memory.
 *
 * The route has to be public (an <img> sends no token), so its URLs carry a
 * random key per voice channel, made at load: without it nobody can ask which
 * videos were played, and with one, only about that channel.
 */
import type { IncomingMessage, ServerResponse } from "http";

/** images kept in memory; a storyboard sheet is some 30-80 KB */
const MAX_KEPT = 150;
/** paths that may be asked for, with the YouTube image each stands for */
const MAX_ALLOWED = 2_000;
const MAX_BYTES = 512 * 1024;
/** a thumbnail YouTube would not give is not asked for again for this long */
const RETRY_AFTER_MS = 5 * 60_000;

type TLog = { error(...args: unknown[]): void };

const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

/** where YouTube's images come from; nothing else is fetched */
export const isYouTubeImage = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /^i\d?\.ytimg\.com$/.test(parsed.hostname) && !parsed.username && !parsed.port;
  } catch {
    return false;
  }
};

export class Thumbnails {
  /** YouTube image URL → image, or the fetch still running; oldest first */
  private readonly kept = new Map<string, Promise<Uint8Array | null>>();
  /** "key/video id[/sb<n>]" → the YouTube image it serves; oldest first */
  private readonly allowed = new Map<string, string>();
  private readonly keys = new Map<number, string>();

  constructor(
    private readonly base: string,
    private readonly log: TLog,
    private readonly fetchImage: (url: string) => Promise<Uint8Array | null> = fetchFromYouTube,
  ) {}

  private keyOf(channelId: number): string {
    let key = this.keys.get(channelId);
    if (!key) {
      key = randomKey();
      this.keys.set(channelId, key);
    }
    return key;
  }

  private allow(path: string, source: string) {
    this.allowed.delete(path);
    this.allowed.set(path, source);
    while (this.allowed.size > MAX_ALLOWED) this.allowed.delete(this.allowed.keys().next().value as string);
  }

  /** allows the video's thumbnail in a voice channel and returns the URL to show it with */
  url(channelId: number, videoId: string): string {
    const path = `${this.keyOf(channelId)}/${videoId}`;
    this.allow(path, `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
    return `${this.base}/thumb/${path}.jpg`;
  }

  /** allows the video's storyboard sheets in a voice channel; the URL has `{n}` for the sheet's number */
  storyboard(channelId: number, videoId: string, sheets: string[]): string {
    const path = `${this.keyOf(channelId)}/${videoId}`;
    sheets.forEach((sheet, index) => {
      if (isYouTubeImage(sheet)) this.allow(`${path}/sb${index}`, sheet);
    });
    return `${this.base}/thumb/${path}/sb{n}.jpg`;
  }

  private image(source: string): Promise<Uint8Array | null> {
    let image = this.kept.get(source);
    if (!image) {
      image = this.fetchImage(source).catch((error) => {
        this.log.error("[thumbnails]", error instanceof Error ? error.message : error);
        return null;
      });
      this.kept.set(source, image);
      while (this.kept.size > MAX_KEPT) this.kept.delete(this.kept.keys().next().value as string);
      void image.then((bytes) => {
        if (!bytes) setTimeout(() => this.kept.get(source) === image && this.kept.delete(source), RETRY_AFTER_MS).unref?.();
      });
    }
    return image;
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const match = /\/thumb\/([0-9a-f]{32}\/[\w-]{11}(?:\/sb\d{1,3})?)\.jpg$/.exec(new URL(req.url ?? "/", "http://x").pathname);
    const source = match ? this.allowed.get(match[1]!) : undefined;
    const bytes = source ? await this.image(source) : null;
    if (!bytes) {
      res.writeHead(404, { "Cache-Control": "no-store" }).end();
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": bytes.byteLength,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      })
      .end(bytes);
  };
}

const fetchFromYouTube = async (url: string): Promise<Uint8Array | null> => {
  if (!isYouTubeImage(url)) return null;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok || !response.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  // JPEG files start with FF D8
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? new Uint8Array(bytes) : null;
};
