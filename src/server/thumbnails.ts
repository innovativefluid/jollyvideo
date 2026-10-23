/**
 * Video thumbnails, fetched by the server so viewers' browsers never contact
 * YouTube. Only videos someone queued are served, and only the last few are
 * kept in memory.
 */
import type { IncomingMessage, ServerResponse } from "http";

const MAX_KEPT = 200;
const MAX_BYTES = 512 * 1024;

type TLog = { error(...args: unknown[]): void };

export class Thumbnails {
  /** video id → image, or the fetch still running; oldest first */
  private readonly kept = new Map<string, Promise<Uint8Array | null>>();
  private readonly allowed = new Set<string>();

  constructor(
    private readonly base: string,
    private readonly log: TLog,
    private readonly fetchImage: (videoId: string) => Promise<Uint8Array | null> = fetchFromYouTube,
  ) {}

  /** allows the video's thumbnail and returns the URL to show it with */
  url(videoId: string): string {
    this.allowed.delete(videoId);
    this.allowed.add(videoId);
    while (this.allowed.size > MAX_KEPT) {
      const oldest = this.allowed.values().next().value as string;
      this.allowed.delete(oldest);
      this.kept.delete(oldest);
    }
    return `${this.base}/thumb/${videoId}.jpg`;
  }

  private image(videoId: string): Promise<Uint8Array | null> {
    let image = this.kept.get(videoId);
    if (!image) {
      image = this.fetchImage(videoId).catch((error) => {
        this.log.error("[thumbnails]", error instanceof Error ? error.message : error);
        return null;
      });
      this.kept.set(videoId, image);
      // a failed fetch is tried again next time
      void image.then((bytes) => bytes || this.kept.delete(videoId));
    }
    return image;
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const videoId = /\/thumb\/([\w-]{11})\.jpg$/.exec(new URL(req.url ?? "/", "http://x").pathname)?.[1];
    const bytes = videoId && this.allowed.has(videoId) ? await this.image(videoId) : null;
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
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  // JPEG files start with FF D8
  if (bytes.byteLength > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return bytes;
};
