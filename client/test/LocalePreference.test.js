import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/preferences/LocalePreference.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const { normalizeLocalePreference, resolveUiLocale } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('manual language overrides the browser language', () => {
  assert.equal(resolveUiLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveUiLocale('en-US', 'zh-CN'), 'en-US');
});

test('system language follows Chinese browser locales and otherwise uses English', () => {
  for (const language of ['zh-CN', 'zh-TW', 'ZH-hans']) {
    assert.equal(resolveUiLocale('system', language), 'zh-CN');
  }
  for (const language of ['en-US', 'en-GB', 'ja-JP', '']) {
    assert.equal(resolveUiLocale('system', language), 'en-US');
  }
});

test('stored supported preferences are retained while invalid values follow the system', () => {
  assert.equal(normalizeLocalePreference('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocalePreference('en-US'), 'en-US');
  for (const value of ['system', null, undefined, '', 'invalid', 'zh', 1]) {
    assert.equal(normalizeLocalePreference(value), 'system');
  }
});
