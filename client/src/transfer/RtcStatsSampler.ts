export interface RtcStatsSample {
  bytesAcknowledged: number;
  speedBytesPerSecond: number;
  averageBytesPerSecond: number;
  peakBytesPerSecond: number;
}

interface RtcStatsSamplerOptions {
  windowMs?: number;
  ewmaAlpha?: number;
  now?: () => number;
}

interface DeliveredPoint {
  at: number;
  bytes: number;
}

export class RtcStatsSampler {
  private readonly windowMs: number;
  private readonly ewmaAlpha: number;
  private readonly now: () => number;
  private points: DeliveredPoint[] = [];
  private bytesAcknowledged = 0;
  private firstPayloadAt: number | null = null;
  private firstPayloadBytes = 0;
  private smoothedSpeed = 0;
  private peakSpeed = 0;

  constructor(options: RtcStatsSamplerOptions = {}) {
    this.windowMs = Math.max(250, options.windowMs ?? 2000);
    this.ewmaAlpha = Math.min(1, Math.max(0.01, options.ewmaAlpha ?? 0.35));
    this.now = options.now ?? (() => performance.now());
  }

  record(bytesAcknowledged: number, at = this.now()): RtcStatsSample {
    const bytes = Math.max(this.bytesAcknowledged, Math.max(0, bytesAcknowledged));
    this.bytesAcknowledged = bytes;
    if (bytes > 0 && this.firstPayloadAt === null) {
      this.firstPayloadAt = at;
      this.firstPayloadBytes = bytes;
    }

    const previous = this.points.at(-1);
    if (previous?.at === at) {
      previous.bytes = bytes;
    } else {
      this.points.push({ at, bytes });
    }

    const cutoff = at - this.windowMs;
    while (this.points.length > 1 && this.points[0].at < cutoff) {
      this.points.shift();
    }

    const oldest = this.points[0];
    const newest = this.points.at(-1)!;
    const elapsedMs = newest.at - oldest.at;
    const rawSpeed = elapsedMs > 0
      ? Math.max(0, newest.bytes - oldest.bytes) * 1000 / elapsedMs
      : 0;
    this.smoothedSpeed =
      this.ewmaAlpha * rawSpeed +
      (1 - this.ewmaAlpha) * this.smoothedSpeed;
    if (rawSpeed === 0 && previous && at - previous.at >= this.windowMs) {
      this.smoothedSpeed = 0;
    }
    this.peakSpeed = Math.max(this.peakSpeed, this.smoothedSpeed);

    const averageElapsedMs = this.firstPayloadAt === null ? 0 : at - this.firstPayloadAt;
    const averageSpeed = averageElapsedMs > 0
      ? Math.max(0, bytes - this.firstPayloadBytes) * 1000 / averageElapsedMs
      : 0;

    return {
      bytesAcknowledged: bytes,
      speedBytesPerSecond: this.smoothedSpeed,
      averageBytesPerSecond: averageSpeed,
      peakBytesPerSecond: this.peakSpeed
    };
  }
}
