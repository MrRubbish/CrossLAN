import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const { RtcStatsSampler } = await loadModule('../src/transfer/RtcStatsSampler.ts');

test('acknowledged bytes never move backwards', () => {
  const sampler = new RtcStatsSampler({ ewmaAlpha: 1 });

  sampler.record(1024, 1000);
  const sample = sampler.record(512, 1500);

  assert.equal(sample.bytesAcknowledged, 1024);
});

test('current speed uses a roughly two-second delivered-byte window', () => {
  const sampler = new RtcStatsSampler({ ewmaAlpha: 1, windowMs: 2000 });

  sampler.record(0, 0);
  sampler.record(1000, 1000);
  const sample = sampler.record(3000, 3000);

  assert.equal(sample.speedBytesPerSecond, 1000);
});

test('current speed is smoothed with an EWMA', () => {
  const sampler = new RtcStatsSampler({ ewmaAlpha: 0.5, windowMs: 1000 });

  sampler.record(0, 0);
  const first = sampler.record(1000, 1000);
  const second = sampler.record(3000, 2000);

  assert.equal(first.speedBytesPerSecond, 500);
  assert.equal(second.speedBytesPerSecond, 1250);
});

test('average speed excludes bytes already acknowledged at the start baseline', () => {
  const sampler = new RtcStatsSampler({ ewmaAlpha: 1 });

  sampler.record(0, 0);
  sampler.record(100, 500);
  const sample = sampler.record(1100, 1500);

  assert.equal(sample.averageBytesPerSecond, 1000);
});

test('current speed decays to zero after an idle window', () => {
  const sampler = new RtcStatsSampler({ ewmaAlpha: 1, windowMs: 2000 });

  sampler.record(0, 0);
  sampler.record(1000, 1000);
  const sample = sampler.record(1000, 4000);

  assert.equal(sample.speedBytesPerSecond, 0);
  assert.equal(sample.peakBytesPerSecond, 1000);
});

async function loadModule(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    },
    fileName: sourceUrl.pathname
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}
