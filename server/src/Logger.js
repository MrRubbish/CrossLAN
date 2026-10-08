import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const LOG_LEVEL_RANK = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4
};

export class Logger {
  constructor({
    filePath = process.env.CROSSLAN_LOG_FILE || '',
    maxBytes = readMaxBytes(process.env.CROSSLAN_LOG_MAX_MB)
  } = {}) {
    this.filePath = String(filePath || '').trim();
    this.maxBytes = maxBytes || DEFAULT_MAX_BYTES;
    this.level = normalizeLogLevel(
      process.env.CROSSLAN_LOG_LEVEL,
      this.filePath ? 'error' : 'info'
    );
    this.bytes = 0;

    if (!this.filePath) return;

    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.bytes = statSync(this.filePath).size;
    } catch {
      this.bytes = 0;
    }
  }

  debug(...args) {
    this.write('DEBUG', args, 'log');
  }

  info(...args) {
    this.write('INFO', args, 'log');
  }

  warn(...args) {
    this.write('WARN', args, 'warn');
  }

  error(...args) {
    this.write('ERROR', args, 'error');
  }

  ready(...args) {
    // Keep the readiness marker visible to process supervisors without adding
    // routine startup noise to the configured log file.
    this.write('INFO', args, 'log', true);
  }

  write(level, args, consoleMethod, echoToConsole = false) {
    const shouldWrite = shouldWriteLevel(level, this.level);

    if (!this.filePath) {
      if (shouldWrite || echoToConsole) {
        console[consoleMethod](...args);
      }
      return;
    }

    if (shouldWrite) {
      const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatArgument).join(' ')}\n`;
      try {
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (this.bytes > 0 && this.bytes + lineBytes > this.maxBytes) {
          rotateLog(this.filePath);
          this.bytes = 0;
        }
        appendFileSync(this.filePath, line, { encoding: 'utf8' });
        this.bytes += lineBytes;
      } catch (error) {
        console.error(`CrossLAN logger failed to write ${this.filePath}: ${formatArgument(error)}`);
      }
    }

    if (echoToConsole || level === 'ERROR') {
      console[consoleMethod](...args);
    }
  }
}

function formatArgument(value) {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  return inspect(value, { depth: 4, breakLength: Infinity, compact: true });
}

function rotateLog(filePath) {
  const rotatedPath = `${filePath}.1`;
  try {
    if (existsSync(rotatedPath)) unlinkSync(rotatedPath);
    if (existsSync(filePath)) renameSync(filePath, rotatedPath);
  } catch {
    // Logging must never stop the transfer service.
  }
}

function readMaxBytes(value) {
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return DEFAULT_MAX_BYTES;
  return Math.max(1, Math.floor(megabytes)) * 1024 * 1024;
}

function normalizeLogLevel(value, fallback) {
  const level = String(value || fallback).toLowerCase();
  return Object.hasOwn(LOG_LEVEL_RANK, level) ? level : fallback;
}

function shouldWriteLevel(level, configuredLevel) {
  const normalizedLevel = String(level || '').toLowerCase();
  return LOG_LEVEL_RANK[normalizedLevel] >= LOG_LEVEL_RANK[configuredLevel];
}
