export class NetworkProber {
  constructor() {
    this.stressSessions = new Map();
  }

  async quickProbe() {
    return {
      implemented: false,
      mode: 'quick',
      throughputMbps: null,
      rttMs: null,
      message: 'NetworkProber.quickProbe is reserved for V2 diagnostics.'
    };
  }

  async startStress({ targetDeviceId, durationMs = 10000, bytesPerSecond = null } = {}) {
    const sessionId = `${targetDeviceId || 'unknown'}-${Date.now()}`;
    const session = {
      sessionId,
      targetDeviceId,
      durationMs,
      bytesPerSecond,
      startedAt: Date.now(),
      implemented: false
    };
    this.stressSessions.set(sessionId, session);
    return session;
  }

  async stopStress(sessionId) {
    const session = this.stressSessions.get(sessionId);
    if (session) {
      this.stressSessions.delete(sessionId);
    }
    return {
      sessionId,
      stopped: Boolean(session),
      implemented: false
    };
  }

  createMockRealtimeSample() {
    return {
      implemented: false,
      at: Date.now(),
      throughputMbps: 0,
      rttMs: 0,
      note: 'Reserved WebSocket channel for future per-second probe samples.'
    };
  }
}
