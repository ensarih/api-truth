import {registerHooks} from 'node:module';
import {createPrivateKey, sign, randomUUID} from 'node:crypto';
import {readFile, lstat, writeFile, rename, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
const roots = [new URL('../packages/ir/src/', import.meta.url).href, new URL('../analyzers/nodejs/src/', import.meta.url).href];
registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && roots.some(root => context.parentURL?.startsWith(root))) {
    const target = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (roots.some(root => target.href.startsWith(root))) return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}});
let temporary;
try {
  const values = new Map();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--capture', '--private-key', '--output'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error();
    values.set(args[i], args[i + 1]);
  }
  if (values.size !== 3) throw new Error();
  const bounded = async (path, limit) => {
    if ((await lstat(path)).size > limit) throw new Error();
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new Error();
    return bytes;
  };
  const {parseStrictJson} = await import('../analyzers/nodejs/src/strict-json.ts');
  const {RuntimeBindingReceiptSchema} = await import('../analyzers/nodejs/src/runtime-binding.ts');
  const {Value} = await import('@sinclair/typebox/value');
  const payload = parseStrictJson((await bounded(values.get('--capture'), 700000)).toString('utf8'));
  if (!Value.Check(RuntimeBindingReceiptSchema, payload)) throw new Error();
  const key = createPrivateKey(await bounded(values.get('--private-key'), 10000));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error();
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = JSON.stringify({payload: bytes.toString('base64'), signature: sign(null, bytes, key).toString('base64')});
  if (Buffer.byteLength(envelope) > 1000000) throw new Error();
  const output = resolve(values.get('--output'));
  temporary = join(dirname(output), `.api-truth-receipt-${randomUUID()}.tmp`);
  await writeFile(temporary, envelope, {flag: 'wx', mode: 0o600});
  await rename(temporary, output); temporary = undefined;
} catch {
  process.stderr.write('Runtime binding signing failed: invalid capture, key, arguments, limits, or output.\n');
  process.exitCode = 1;
} finally { if (temporary) await rm(temporary, {force: true}); }
