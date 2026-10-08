const BLOB_PART_SIZE = 1024 * 1024;

export interface ReceiveSinkCloseResult {
  downloadUrl?: string;
  needsUserSave?: boolean;
}

export interface ReceiveSink {
  readonly bytesWritten: number;
  prepare(): Promise<void>;
  write(chunk: Uint8Array, offset?: number): Promise<void>;
  close(): Promise<ReceiveSinkCloseResult>;
  abort(reason?: unknown): Promise<void>;
}

interface BlobReceiveSinkOptions {
  size: number;
  type: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

interface FileSystemWritableTarget {
  write(data: Uint8Array<ArrayBuffer> | {
    type: 'write';
    position: number;
    data: Uint8Array<ArrayBuffer>;
  }): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export class BlobReceiveSink implements ReceiveSink {
  bytesWritten = 0;

  private chunks: Blob[] = [];
  private pending: Uint8Array<ArrayBuffer>;
  private pendingBytes = 0;
  private closePromise: Promise<ReceiveSinkCloseResult> | null = null;
  private aborted = false;
  private downloadUrl: string | undefined;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;

  constructor(private options: BlobReceiveSinkOptions) {
    if (!Number.isSafeInteger(options.size) || options.size < 0) {
      throw new Error('Invalid declared Blob receive size.');
    }
    this.pending = new Uint8Array(Math.min(options.size, BLOB_PART_SIZE));
    this.createObjectUrl = options.createObjectUrl || (blob => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl || (url => URL.revokeObjectURL(url));
  }

  async prepare() {
    this.ensureWritable();
  }

  async write(chunk: Uint8Array, offset = this.bytesWritten) {
    this.ensureWritable();
    if (offset !== this.bytesWritten) {
      throw new Error('Blob receive sink only supports sequential writes.');
    }
    const end = offset + chunk.byteLength;
    if (end > this.options.size) {
      throw new Error('Blob receive sink received more data than declared.');
    }
    // Retain immutable MiB-sized parts rather than a native Blob per RTC message.
    let consumed = 0;
    while (consumed < chunk.byteLength) {
      const count = Math.min(chunk.byteLength - consumed, this.pending.byteLength - this.pendingBytes);
      this.pending.set(chunk.subarray(consumed, consumed + count), this.pendingBytes);
      consumed += count;
      this.pendingBytes += count;
      if (this.pendingBytes === this.pending.byteLength) this.flushPending();
    }
    this.bytesWritten = end;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.ensureWritable();
    this.closePromise = Promise.resolve().then(() => {
      if (this.aborted) throw new Error('Receive sink has been aborted.');
      if (this.bytesWritten !== this.options.size) {
        throw new Error(`Blob receive size mismatch: ${this.bytesWritten}/${this.options.size}`);
      }
      this.flushPending();
      this.pending = new Uint8Array(0);
      const blob = new Blob(this.chunks, { type: this.options.type });
      this.chunks.length = 0;
      this.downloadUrl = this.createObjectUrl(blob);
      return {
        downloadUrl: this.downloadUrl,
        needsUserSave: true
      };
    });
    return this.closePromise;
  }

  async abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.chunks.length = 0;
    this.pending = new Uint8Array(0);
    this.pendingBytes = 0;
    if (this.downloadUrl) {
      this.revokeObjectUrl(this.downloadUrl);
      this.downloadUrl = undefined;
    }
  }

  private ensureWritable() {
    if (this.aborted) throw new Error('Receive sink has been aborted.');
    if (this.closePromise) throw new Error('Receive sink has already been closed.');
  }

  private flushPending() {
    if (!this.pendingBytes) return;
    this.chunks.push(new Blob([this.pending.subarray(0, this.pendingBytes)]));
    this.pendingBytes = 0;
  }
}

export class FileSystemReceiveSink implements ReceiveSink {
  bytesWritten = 0;

  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<ReceiveSinkCloseResult> | null = null;
  private abortPromise: Promise<void> | null = null;
  private aborted = false;

  constructor(private writable: FileSystemWritableTarget) {}

  async prepare() {
    this.ensureWritable();
  }

  write(chunk: Uint8Array, offset?: number) {
    this.ensureWritable();
    const operation = this.queue.then(async () => {
      this.ensureWritable();
      const position = offset ?? this.bytesWritten;
      const writeChunk = chunk as Uint8Array<ArrayBuffer>;
      const payload = offset === undefined
        ? writeChunk
        : { type: 'write' as const, position, data: writeChunk };
      await this.writable.write(payload);
      this.bytesWritten = Math.max(this.bytesWritten, position + chunk.byteLength);
    });
    this.queue = operation;
    return operation;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.ensureWritable();
    this.closePromise = this.queue.then(async () => {
      this.ensureNotAborted();
      await this.writable.close();
      return {};
    });
    return this.closePromise;
  }

  abort(reason?: unknown) {
    if (this.abortPromise) return this.abortPromise;
    this.aborted = true;
    this.abortPromise = this.writable.abort(reason).catch(() => undefined);
    return this.abortPromise;
  }

  private ensureWritable() {
    this.ensureNotAborted();
    if (this.closePromise) throw new Error('Receive sink has already been closed.');
  }

  private ensureNotAborted() {
    if (this.aborted) throw new Error('Receive sink has been aborted.');
  }
}

export class BrowserDownloadReceiveSink implements ReceiveSink {
  bytesWritten = 0;
  private closePromise: Promise<ReceiveSinkCloseResult> | null = null;
  private abortPromise: Promise<void> | null = null;
  private aborted = false;

  constructor(private writer: WritableStreamDefaultWriter<Uint8Array>, private size: number) {
    void writer.closed.catch(() => undefined);
  }

  async prepare() {
    this.ensureWritable();
  }

  async write(chunk: Uint8Array, offset = this.bytesWritten) {
    this.ensureWritable();
    if (offset !== this.bytesWritten || offset + chunk.byteLength > this.size) {
      throw new Error('Invalid browser download offset.');
    }
    await this.writer.write(chunk);
    this.ensureWritable();
    this.bytesWritten += chunk.byteLength;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.ensureWritable();
    if (this.bytesWritten !== this.size) throw new Error('Browser download size mismatch.');
    this.closePromise = this.writer.close().then(() => ({}));
    return this.closePromise;
  }

  abort(reason?: unknown) {
    if (this.abortPromise) return this.abortPromise;
    this.aborted = true;
    this.abortPromise = this.writer.abort(reason);
    return this.abortPromise;
  }

  private ensureWritable() {
    if (this.aborted || this.closePromise) throw new Error('Browser download is no longer writable.');
  }

}
