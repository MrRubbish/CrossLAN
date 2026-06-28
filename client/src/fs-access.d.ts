interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
}

declare module 'streamsaver' {
  const streamSaver: {
    mitm?: string;
    createWriteStream(name: string, options?: { size?: number }): WritableStream<Uint8Array>;
  };
  export default streamSaver;
}