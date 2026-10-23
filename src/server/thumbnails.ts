/**
 * Video thumbnails, fetched by the server so viewers' browsers never contact
 * YouTube. Only videos someone queued are served, and only the last few are
 * kept in memory.
 *
 * The route has to be public (an <img> sends no token), so its URLs carry a
 * random key per voice channel, made at load: without it nobody can ask which
 * videos were played, and with one, only about that channel.
 */
import type { IncomingMessage, ServerResponse } from "http";

const MAX_KEPT = 200;
const MAX_BYTES = 512 * 1024;
/** a thumbnail YouTube would not give is not asked for again for this long */
const RETRY_AFTER_MS = 5 * 60_000;

type TLog = { error(...args: unknown[]): void };

const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

export class Thumbnails {
  /** video id → image, or the fetch still running; oldest first */
  private readonly kept = new Map<string, Promise<Uint8Array | null>>();
  /** "key/video id" of the videos shown; oldest first */
  private readonly allowed = new Set<string>();
  private readonly keys = new Map<number, string>();

  constructor(
    private readonly base: string,
    private readonly log: TLog,
    private readonly fetchImage: (videoId: string) => Promise<Uint8Array | null> = fetchFromYouTube,
  ) {}

  /** allows the video's thumbnail in a voice channel and returns the URL to show it with */
  url(channelId: number, videoId: string): string {
    let key = this.keys.get(channelId);
    if (!key) {
      key = randomKey();
      this.keys.set(channelId, key);
    }
    const entry = `${key}/${videoId}`;
    this.allowed.delete(entry);
    this.allowed.add(entry);
    while (this.allowed.size > MAX_KEPT) this.allowed.delete(this.allowed.values().next().value as string);
    while (this.kept.size > MAX_KEPT) this.kept.delete(this.kept.keys().next().value as string);
    return `${this.base}/thumb/${entry}.jpg`;
  }

  private image(videoId: string): Promise<Uint8Array | null> {
    let image = this.kept.get(videoId);
    if (!image) {
      image = this.fetchImage(videoId).catch((error) => {
        this.log.error("[thumbnails]", error instanceof Error ? error.message : error);
        return null;
      });
      this.kept.set(videoId, image);
      void image.then((bytes) => {
        if (!bytes) setTimeout(() => this.kept.get(videoId) === image && this.kept.delete(videoId), RETRY_AFTER_MS).unref?.();
      });
    }
    return image;
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const match = /\/thumb\/([0-9a-f]{32})\/([\w-]{11})\.jpg$/.exec(new URL(req.url ?? "/", "http://x").pathname);
    const bytes = match && this.allowed.has(`${match[1]}/${match[2]}`) ? await this.image(match[2]!) : null;
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

const fetchFromYouTube = async (videoId: string): Promise<Uint8Array | null> => {
  const response = await fetch(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, {
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
