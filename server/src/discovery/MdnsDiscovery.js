import { Bonjour } from 'bonjour-service';
import os from 'node:os';

export class MdnsDiscovery {
  constructor({ port, serviceName, logger = console }) {
    this.port = port;
    this.serviceName = serviceName;
    this.logger = logger;
    this.bonjour = new Bonjour();
    this.service = null;
    this.browser = null;
    this.peers = new Map();
  }

  async start() {
    const host = os.hostname();
    this.service = this.bonjour.publish({
      name: this.serviceName,
      type: 'crosslan',
      port: this.port,
      txt: {
        app: 'crosslan',
        version: '1.0.0'
      }
    });
    this.service.on('error', error => {
      this.lastError = error;
      this.logger.warn('CrossLAN discovery warning: ' + (error instanceof Error ? error.message : error));
    });

    // mDNS is a discovery hint, while WebSocket remains the live source of
    // truth. Future native wrappers can consume these peers for zero-config
    // bootstrap without changing the WebRTC or transfer engine.
    this.browser = this.bonjour.find({ type: 'crosslan' });
    this.browser.on('error', error => {
      this.logger.warn('CrossLAN discovery browser warning: ' + (error instanceof Error ? error.message : error));
    });
    this.browser.on('up', service => {
      const addresses = service.addresses?.filter(isIpv4) || [];
      for (const address of addresses) {
        this.peers.set(address, {
          id: address,
          ip: address,
          name: service.name || host,
          lastSeen: Date.now()
        });
      }
    });
    this.browser.on('down', service => {
      for (const address of service.addresses || []) {
        this.peers.delete(address);
      }
    });
  }

  getPeers() {
    return [...this.peers.values()];
  }

  async stop() {
    if (this.browser) {
      this.browser.stop();
    }
    if (this.service) {
      await new Promise(resolve => this.service.stop(resolve));
    }
    this.bonjour.destroy();
  }
}

function isIpv4(address) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}
