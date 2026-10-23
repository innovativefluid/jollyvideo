/**
 * The stream viewers see in the voice channel. Every ffmpeg run gets its own
 * pair of plain transports: mediasoup locks a comedia transport to the first
 * address that sends to it, and a new ffmpeg sends from a new port. The stream
 * keeps its place in the channel and just swaps to the new producers.
 */
import type { PlainTransport, Producer, Router } from "mediasoup/types";
import type { TRtpTarget } from "./encoder";

type TStreamHandle = {
  remove(): void;
  update(options: { title?: string; bannerUrl?: string; producers?: { audio?: Producer; video?: Producer } }): void;
};

/** the slice of `ctx.voice` the output uses */
export type TVoice = {
  getRouter(channelId: number): Router;
  createStream(options: {
    channelId: number;
    title: string;
    key: string;
    bannerUrl?: string;
    producers: { audio?: Producer; video?: Producer };
  }): TStreamHandle;
};

export type TLabel = { title: string; bannerUrl?: string };

/** two transports with a producer each, ready for one ffmpeg run */
export type TConnection = {
  video: TRtpTarget;
  audio: TRtpTarget;
  close(): void;
};

export type TOutput = {
  connect(profileLevelId: string): Promise<TConnection>;
  /** puts this connection on air, creating the stream the first time */
  publish(connection: TConnection, label: TLabel): void;
  /** changes what the stream card says without touching the media */
  relabel(label: TLabel): void;
  remove(): void;
};

const VIDEO_PT = 96;
const AUDIO_PT = 111;

const randomSsrc = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! || 1;

type TOwnConnection = TConnection & { producers: { audio: Producer; video: Producer } };

export const createOutput = (voice: TVoice, channelId: number, key: string): TOutput => {
  let stream: TStreamHandle | null = null;
  let live: TOwnConnection | null = null;
  let label: TLabel | null = null;

  const open = async (router: Router): Promise<PlainTransport> =>
    router.createPlainTransport({ listenInfo: { protocol: "udp", ip: "127.0.0.1" }, rtcpMux: true, comedia: true });

  return {
    async connect(profileLevelId) {
      const router = voice.getRouter(channelId);
      const transports: PlainTransport[] = [];
      const close = () => transports.forEach((transport) => transport.close());
      try {
        const videoTransport = await open(router);
        transports.push(videoTransport);
        const audioTransport = await open(router);
        transports.push(audioTransport);
        const videoSsrc = randomSsrc();
        const audioSsrc = randomSsrc();
        const video = await videoTransport.produce({
          kind: "video",
          rtpParameters: {
            codecs: [
              {
                mimeType: "video/H264",
                payloadType: VIDEO_PT,
                clockRate: 90000,
                parameters: { "packetization-mode": 1, "level-asymmetry-allowed": 1, "profile-level-id": profileLevelId },
              },
            ],
            encodings: [{ ssrc: videoSsrc }],
          },
        });
        const audio = await audioTransport.produce({
          kind: "audio",
          rtpParameters: {
            codecs: [{ mimeType: "audio/opus", payloadType: AUDIO_PT, clockRate: 48000, channels: 2, parameters: { "sprop-stereo": 1 } }],
            encodings: [{ ssrc: audioSsrc }],
          },
        });
        const connection: TOwnConnection = {
          video: { port: videoTransport.tuple.localPort, payloadType: VIDEO_PT, ssrc: videoSsrc },
          audio: { port: audioTransport.tuple.localPort, payloadType: AUDIO_PT, ssrc: audioSsrc },
          producers: { audio, video },
          close,
        };
        return connection;
      } catch (error) {
        close();
        throw error;
      }
    },

    publish(connection, next) {
      const own = connection as TOwnConnection;
      const previous = live;
      if (!stream) {
        stream = voice.createStream({ channelId, key, title: next.title, bannerUrl: next.bannerUrl, producers: own.producers });
      } else {
        stream.update({ title: next.title, bannerUrl: next.bannerUrl, producers: own.producers });
      }
      live = own;
      label = next;
      if (previous && previous !== own) previous.close();
    },

    relabel(next) {
      if (stream && (next.title !== label?.title || next.bannerUrl !== label?.bannerUrl)) {
        stream.update({ title: next.title, bannerUrl: next.bannerUrl });
        label = next;
      }
    },

    remove() {
      try {
        stream?.remove();
      } finally {
        stream = null;
        label = null;
        live?.close();
        live = null;
      }
    },
  };
};
