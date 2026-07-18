export class RelayBufferPool {
  constructor({ targetBytes, highWaterBytes, lowWaterBytes, totalBytes }) {
    if (![targetBytes, highWaterBytes, lowWaterBytes, totalBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('Relay buffer limits must be positive safe integers.');
    }
    if (!(lowWaterBytes <= targetBytes && targetBytes <= highWaterBytes && highWaterBytes <= totalBytes)) {
      throw new RangeError('Relay buffer limits must satisfy low <= target <= high <= total.');
    }

    this.targetBytes = targetBytes;
    this.highWaterBytes = highWaterBytes;
    this.lowWaterBytes = lowWaterBytes;
    this.totalBytes = totalBytes;
    this.totalBufferedBytes = 0;
    this.sessions = new Map();
    this.waiters = new Set();
  }

  register(sessionId) {
    if (!sessionId) throw new TypeError('Relay buffer sessionId is required.');
    if (this.sessions.has(sessionId)) return this.snapshot(sessionId);
    this.sessions.set(sessionId, {
      bufferedBytes: 0,
      reservedBytes: 0,
      highWaterBackpressured: false,
      waitingWriters: 0
    });
    return this.snapshot(sessionId);
  }

  async reserve(sessionId, requestedBytes) {
    this.#validateRequestedBytes(requestedBytes);

    while (true) {
      const reservedBytes = this.tryReserve(sessionId, requestedBytes);
      if (reservedBytes > 0) return reservedBytes;
      const state = this.#requireSession(sessionId);
      await this.#waitForCapacity(sessionId, state);
    }
  }

  tryReserve(sessionId, requestedBytes) {
    const requested = Math.floor(requestedBytes);
    this.#validateRequestedBytes(requested);
    const state = this.#requireSession(sessionId);
    this.#refreshBackpressure(state);
    if (state.highWaterBackpressured) return 0;

    const sessionCapacity = this.highWaterBytes - state.bufferedBytes - state.reservedBytes;
    const totalCapacity = this.totalBytes - this.totalBufferedBytes;
    if (sessionCapacity <= 0 || totalCapacity <= 0) return 0;

    const reservedBytes = Math.min(requested, sessionCapacity, totalCapacity);
    state.reservedBytes += reservedBytes;
    this.totalBufferedBytes += reservedBytes;
    return reservedBytes;
  }

  commit(sessionId, committedBytes) {
    const state = this.#requireSession(sessionId);
    const committed = Math.floor(committedBytes);
    if (!Number.isSafeInteger(committed) || committed <= 0 || committed > state.reservedBytes) {
      throw new RangeError('Relay commit exceeds the reserved bytes.');
    }

    state.reservedBytes -= committed;
    state.bufferedBytes += committed;
    if (state.bufferedBytes + state.reservedBytes >= this.highWaterBytes) {
      state.highWaterBackpressured = true;
    }
  }

  rollback(sessionId, reservedBytes) {
    const state = this.#requireSession(sessionId);
    const released = Math.min(Math.max(Math.floor(reservedBytes), 0), state.reservedBytes);
    if (released === 0) return 0;
    state.reservedBytes -= released;
    this.totalBufferedBytes -= released;
    this.#wakeEligibleWaiters();
    return released;
  }

  release(sessionId, downloadedBytes) {
    const state = this.sessions.get(sessionId);
    if (!state) return 0;
    const released = Math.min(Math.max(Math.floor(downloadedBytes), 0), state.bufferedBytes);
    if (released === 0) return 0;

    state.bufferedBytes -= released;
    this.totalBufferedBytes -= released;
    this.#refreshBackpressure(state);
    this.#wakeEligibleWaiters();
    return released;
  }

  close(sessionId, error = new Error('Relay buffer session closed.')) {
    const state = this.sessions.get(sessionId);
    if (!state) return false;

    this.sessions.delete(sessionId);
    this.totalBufferedBytes -= state.bufferedBytes + state.reservedBytes;
    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId === sessionId) waiter.reject(error);
      else waiter.resolve();
    }
    return true;
  }

  snapshot(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      bufferedBytes: state.bufferedBytes,
      reservedBytes: state.reservedBytes,
      targetBufferBytes: this.targetBytes,
      highWaterBytes: this.highWaterBytes,
      lowWaterBytes: this.lowWaterBytes,
      totalBufferBytes: this.totalBytes,
      totalBufferedBytes: this.totalBufferedBytes,
      backpressured: state.highWaterBackpressured || state.waitingWriters > 0
    };
  }

  #requireSession(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error('Relay buffer session is closed.');
    return state;
  }

  #validateRequestedBytes(requestedBytes) {
    const requested = Math.floor(requestedBytes);
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new TypeError('Relay reservation size must be a positive safe integer.');
    }
  }

  #refreshBackpressure(state) {
    const sessionBuffered = state.bufferedBytes + state.reservedBytes;
    if (state.highWaterBackpressured && sessionBuffered <= this.lowWaterBytes) {
      state.highWaterBackpressured = false;
    } else if (!state.highWaterBackpressured && sessionBuffered >= this.highWaterBytes) {
      state.highWaterBackpressured = true;
    }
  }

  #waitForCapacity(sessionId, state) {
    state.waitingWriters += 1;
    return new Promise((resolve, reject) => {
      const waiter = {
        sessionId,
        resolve: () => {
          if (!this.waiters.delete(waiter)) return;
          state.waitingWriters -= 1;
          resolve();
        },
        reject: error => {
          if (!this.waiters.delete(waiter)) return;
          state.waitingWriters -= 1;
          reject(error);
        }
      };
      this.waiters.add(waiter);
    });
  }

  #wakeEligibleWaiters() {
    if (this.totalBufferedBytes >= this.totalBytes) return 0;
    let woken = 0;
    for (const waiter of [...this.waiters]) {
      const state = this.sessions.get(waiter.sessionId);
      if (!state) {
        waiter.reject(new Error('Relay buffer session is closed.'));
        continue;
      }
      this.#refreshBackpressure(state);
      if (state.highWaterBackpressured) continue;
      if (state.bufferedBytes + state.reservedBytes >= this.highWaterBytes) continue;
      waiter.resolve();
      woken += 1;
    }
    return woken;
  }
}
