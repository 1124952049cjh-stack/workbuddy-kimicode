/**
 * 新写的 `lib/*.test.mjs` 不许"写了但没人跑"。
 *
 *   node --test lib/test-registry.test.mjs
 *
 * ## 为什么需要这条
 *
 * `package.json` 的 `test:lib` 是**逐个文件列举**的，不是 glob。这意味着
 * 新加一个 `lib/xxx.test.mjs` 之后，如果忘了把它加进那行命令，它会**永远不跑**，
 * 而且没有任何提示 —— 本地 `npm run test:lib` 绿、CI 绿、`release:check` 绿，
 * 唯独那条新用例从没执行过。写完测试却等于没写，是最容易骗过自己的失败模式。
 *
 * 这个坑本轮真实踩到过：新加的 `diagnostics.credref.test.mjs` 一开始就不在那行
 * 命令里，是靠人工比对 `ls lib/*.test.mjs` 和 `package.json` 才发现的。
 * 人工比对不该是流程的一部分，所以把它固化成这条用例。
 *
 * 反证：往 `lib/` 里放一个 `zzz-not-registered.test.mjs`（内容随意），
 * 这条用例立刻变红并点名该文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', 'package.json');

test('lib/ 下每个 *.test.mjs 都必须出现在 test:lib 里（否则它永远不会被执行）', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  const cmd = pkg.scripts?.['test:lib'] || '';
  assert.ok(cmd, 'package.json 里找不到 test:lib —— 脚本改名了？请同步本用例');

  const onDisk = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();
  assert.ok(onDisk.length > 0, 'lib/ 下没扫到任何 *.test.mjs，本用例的判据失效了');

  const missing = onDisk.filter((f) => !cmd.includes(f));
  assert.deepEqual(
    missing,
    [],
    `这些测试文件没被 test:lib 引用，写了也不会跑：${missing.join(', ')}\n`
    + '把它们加进 package.json 的 test:lib（或改用 glob）。',
  );
});

test('test:lib 里引用的文件必须真实存在（防止删文件后残留死引用）', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  const cmd = pkg.scripts?.['test:lib'] || '';
  // 只认 lib/ 开头的参数，避免把 node 自己的参数也当文件名
  const referenced = [...cmd.matchAll(/\blib\/[A-Za-z0-9._-]+\.test\.mjs\b/g)].map((m) => m[0]);
  assert.ok(referenced.length > 0, 'test:lib 里没解析出任何 lib/*.test.mjs 引用');

  const onDisk = new Set(readdirSync(HERE));
  const dangling = referenced.filter((r) => !onDisk.has(r.replace(/^lib\//, '')));
  assert.deepEqual(
    dangling,
    [],
    `test:lib 引用了不存在的文件，整条命令会直接失败：${dangling.join(', ')}`,
  );
});
