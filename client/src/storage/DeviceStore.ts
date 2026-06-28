import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DeviceRecord } from '../types';

interface CrossLanDb extends DBSchema {
  devices: {
    key: string;
    value: DeviceRecord;
    indexes: {
      'by-ip': string;
      'by-fingerprint': string;
      'by-last-seen': number;
    };
  };
}

export class DeviceStore {
  private dbPromise: Promise<IDBPDatabase<CrossLanDb>>;

  constructor() {
    this.dbPromise = openDB<CrossLanDb>('crosslan', 1, {
      upgrade(db) {
        const store = db.createObjectStore('devices', { keyPath: 'id' });
        store.createIndex('by-ip', 'ip');
        store.createIndex('by-fingerprint', 'fingerprint');
        store.createIndex('by-last-seen', 'lastSeen');
      }
    });
  }

  async upsert(device: DeviceRecord) {
    const db = await this.dbPromise;
    const normalized = normalizeDevice(device);
    const existing = await db.get('devices', normalized.id);
    await db.put('devices', {
      id: normalized.id,
      ip: normalized.ip,
      fingerprint: normalized.fingerprint ?? existing?.fingerprint ?? null,
      alias: existing?.alias ?? normalized.alias ?? null,
      userAgent: normalized.userAgent ?? existing?.userAgent ?? null,
      lastSeen: normalized.lastSeen || Date.now()
    });
  }

  async upsertMany(devices: DeviceRecord[]) {
    await Promise.all(devices.map(device => this.upsert(device)));
  }

  async listRecent() {
    const db = await this.dbPromise;
    const devices = await db.getAll('devices');
    return devices.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  async setAlias(id: string, alias: string | null) {
    const db = await this.dbPromise;
    const device = await db.get('devices', id);
    if (!device) return;
    await db.put('devices', { ...device, alias: alias ? String(alias) : null });
  }
}

function normalizeDevice(device: DeviceRecord): DeviceRecord {
  return {
    id: String(device.id || device.ip),
    ip: String(device.ip || device.id),
    fingerprint: device.fingerprint ? String(device.fingerprint) : null,
    alias: device.alias ? String(device.alias) : null,
    userAgent: device.userAgent ? String(device.userAgent) : null,
    lastSeen: Number(device.lastSeen || Date.now())
  };
}
