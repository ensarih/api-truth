import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {afterEach, describe, expect, it} from 'vitest';

const require = createRequire(import.meta.url);
const {readDocumentForCapture} = require('../../analyzers/nodejs/src/runtime-document-load-capture.cjs') as {
  readDocumentForCapture(root: string): {text: string; rawSha256: string};
};
const roots: string[] = [];
const fixture = (bytes: Buffer | string): string => {
  const root = mkdtempSync(join(tmpdir(), 'api-truth-document-load-'));
  roots.push(root);
  mkdirSync(join(root, 'api', 'swagger'), {recursive: true});
  writeFileSync(join(root, 'api', 'swagger', 'swagger.yaml'), bytes);
  return root;
};
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});

describe('controlled runtime document bytes', () => {
  it('preserves exact BOM and CRLF raw bytes', () => {
    const bytes = Buffer.from('\uFEFF{"swagger":"2.0",\r\n"paths":{}}', 'utf8');
    const result = readDocumentForCapture(fixture(bytes));
    expect(result.text).toBe(bytes.toString('utf8'));
    expect(result.rawSha256).toBe('sha256:' + createHash('sha256').update(bytes).digest('hex'));
  });
  it('rejects invalid UTF-8 and oversized bytes', () => {
    expect(() => readDocumentForCapture(fixture(Buffer.from([0xc3, 0x28])))).toThrow();
    expect(() => readDocumentForCapture(fixture(Buffer.alloc(1_000_001, 0x41)))).toThrow();
  });
  it('rejects a symlinked selected document or parent', () => {
    const outside = fixture('private-sentinel');
    const root = fixture('ordinary');
    rmSync(join(root, 'api', 'swagger', 'swagger.yaml'));
    symlinkSync(join(outside, 'api', 'swagger', 'swagger.yaml'), join(root, 'api', 'swagger', 'swagger.yaml'));
    expect(() => readDocumentForCapture(root)).toThrow();
    const parentRoot = mkdtempSync(join(tmpdir(), 'api-truth-document-load-'));
    roots.push(parentRoot);
    mkdirSync(join(parentRoot, 'api'));
    symlinkSync(join(outside, 'api', 'swagger'), join(parentRoot, 'api', 'swagger'));
    expect(() => readDocumentForCapture(parentRoot)).toThrow();
  });
});
