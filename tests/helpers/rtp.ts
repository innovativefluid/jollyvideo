/**
 * Watching what a mediasoup producer sends, the way a viewer would get it:
 * consumed through a plain transport into a local UDP socket.
 */
import type { Producer, Router } from "mediasoup/types";

export type TCapture = {
  packets: number;
  /** distinct RTP timestamps, one per video frame */
  frames: number;
  /** frames per second of video time, from the timestamps (90 kHz): unlike `frames`, not thrown off by a late or bursty sender */
  fps(): number;
  keyframes: number;
  /** from the H.264 SPS: profile_idc and level_idc */
  profile?: number;
  level?: number;
  payloadTypes: Set<number>;
  close(): void;
};

/** the H.264 NAL unit type at the start of an RTP payload, looking into STAP-A and FU-A */
const nalTypes = (payload: Uint8Array): { type: number; offset: number }[] => {
  const type = payload[0]! & 0x1f;
  if (type === 24) {
    // STAP-A: 16-bit sizes, then units
    const units: { type: number; offset: number }[] = [];
    for (let at = 1; at + 2 < payload.length; ) {
      const size = (payload[at]! << 8) | payload[at + 1]!;
      units.push({ type: payload[at + 2]! & 0x1f, offset: at + 2 });
      at += 2 + size;
    }
    return units;
  }
  if (type === 28) {
    // FU-A: only the start of a fragmented unit counts
    return payload[1]! & 0x80 ? [{ type: payload[1]! & 0x1f, offset: -1 }] : [];
  }
  return [{ type, offset: 0 }];
};

export const capture = async (router: Router, producer: Producer): Promise<TCapture> => {
  const timestamps = new Set<number>();
  const result: TCapture = {
    packets: 0,
    frames: 0,
    keyframes: 0,
    payloadTypes: new Set(),
    fps: () => {
      // the typical step from one frame to the next, so the starting point and wrap-around do not matter
      const all = [...timestamps];
      const steps = all.slice(1).map((timestamp, index) => (timestamp - all[index]!) >>> 0).sort((x, y) => x - y);
      const step = steps[Math.floor(steps.length / 2)];
      return step ? 90_000 / step : 0;
    },
    close: () => {},
  };
  let lastKeyframeTs = -1;
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    socket: {
      data(_socket, data) {
        const bytes = new Uint8Array(data);
        const payloadType = bytes[1]! & 0x7f;
        // RTCP shares the port
        if (payloadType >= 72 && payloadType <= 79) return;
        result.packets++;
        result.payloadTypes.add(payloadType);
        if (producer.kind !== "video") return;
        const timestamp = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4);
        timestamps.add(timestamp);
        result.frames = timestamps.size;
        const csrcs = bytes[0]! & 0x0f;
        let start = 12 + csrcs * 4;
        if (bytes[0]! & 0x10) {
          const length = new DataView(bytes.buffer, bytes.byteOffset).getUint16(start + 2);
          start += 4 + length * 4;
        }
        const payload = bytes.subarray(start);
        for (const unit of nalTypes(payload)) {
          if (unit.type === 5 && timestamp !== lastKeyframeTs) {
            lastKeyframeTs = timestamp;
            result.keyframes++;
          }
          if (unit.type === 7 && unit.offset >= 0) {
            result.profile = payload[unit.offset + 1];
            result.level = payload[unit.offset + 3];
          }
        }
      },
    },
  });
  const transport = await router.createPlainTransport({ listenInfo: { protocol: "udp", ip: "127.0.0.1" }, rtcpMux: true, comedia: false });
  await transport.connect({ ip: "127.0.0.1", port: socket.port });
  const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: false });
  result.close = () => {
    consumer.close();
    transport.close();
    socket.close();
  };
  return result;
};
