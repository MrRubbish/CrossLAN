self.onmessage = event => {
  const { type } = event.data || {};
  if (type === 'hash-placeholder') {
    self.postMessage({
      type: 'hash-placeholder-result',
      implemented: false,
      message: 'SHA-256 and diagnostics work must stay in this worker in V2.'
    });
  }
};

export {};
