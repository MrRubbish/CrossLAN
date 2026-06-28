import type { DeviceRecord, LocalIdentity } from '../types';

export class DeviceIdentity {
  private current: LocalIdentity | null = null;

  applyServerIdentity(device: DeviceRecord, serverIps: string[]): LocalIdentity {
    this.current = {
      ...device,
      id: device.ip,
      ip: device.ip,
      fingerprint: this.getFingerprint(),
      alias: device.alias ?? null,
      userAgent: navigator.userAgent,
      lastSeen: Date.now(),
      serverIps
    };
    return this.current;
  }

  getDeviceId(): string | null {
    return this.current?.ip ?? null;
  }

  getCurrent(): LocalIdentity | null {
    return this.current;
  }

  getDisplayName(device: DeviceRecord): string {
    const ua = compactUserAgent(device.userAgent);
    return device.alias || (ua ? `${device.ip} - ${ua}` : device.ip);
  }

  getFingerprint(): string | null {
    // V1 intentionally returns null. Future versions can replace only this
    // method with a UserAgent + screen + timezone hash and persist mappings in
    // DeviceStore without touching signaling, WebRTC, or transfer code.
    return null;
  }
}

function compactUserAgent(userAgent?: string | null) {
  if (!userAgent) return '';
  const mobile = /Mobile|Android|iPhone|iPad/i.test(userAgent) ? 'Mobile' : 'Desktop';
  const browser = userAgent.match(/(Edg|Chrome|Firefox|Safari)\/?\d*/i)?.[0] || 'Browser';
  return `${mobile} ${browser}`;
}
