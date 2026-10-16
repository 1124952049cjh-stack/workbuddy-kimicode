/**
 * cordis patch 的 `name` 必须与它要解析的那个包的包名逐字一致。
 *
 *   node --test dsh-plugin/tests/plugin.test.mjs
 *
 * ## 为什么值得单独钉一条
 *
 * dsh 对 Loader 行里 **unknown name 的处理是静默跳过，不报错**（这一点写在两份
 * cordis.patch.yml 的注释里）。于是包名与 patch 里的 name 一旦不一致，症状是
 * **"插件装上了但完全没生效"**，日志里什么都没有 —— 用户只会觉得"这东西坏了"，
 * 而真正的原因只是两个字符串对不上。
 *
 * 本轮改包名（workbuddy-to-dsh → workbuddy-kimicode）时正是踩在这里：根
 * `package.json` 改了，但根 `cordis.patch.yml` 里的 name 没跟着改。当时
 * **没有任何测试会发现**，是人工 grep 才翻出来的。这条用例就是补那个缺口。
 *
 * 两份 patch 各自对应一个包，配对关系是固定的：
 *   - `<root>/cordis.patch.yml`          ↔ `<root>/package.json`（github 直装装的是根包）
 *   - `dsh-plugin/cordis.patch.yml`      ↔ `dsh-plugin/package.json`（单文件夹分发）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_DIR = join(HERE, '..');
const ROOT = join(PLUGIN_DIR, '..');

/** 取出 patch 里 `insert` 那一条的 name（就是我们自己插进去的 Loader 条目）。 */
function loaderName(patchPath) {
  const text = readFileSync(patchPath, 'utf8');
  // 只认真正生效的 YAML 行（`name: xxx` 且不是注释行），注释里也会出现 name 字样
  const m = text.match(/^\s*name:\s*([^\s#]+)\s*$/m);
  assert.ok(m, `${patchPath} 里找不到生效的 name 行`);
  return m[1];
}

/** 配对：patch 文件 ↔ 它要解析的包 */
const PAIRS = [
  { patch: join(ROOT, 'cordis.patch.yml'), pkg: join(ROOT, 'package.json'), label: '仓库根' },
  { patch: join(PLUGIN_DIR, 'cordis.patch.yml'), pkg: join(PLUGIN_DIR, 'package.json'), label: 'dsh-plugin' },
];

for (const { patch, pkg, label } of PAIRS) {
  test(`cordis patch 的 name 必须等于 ${label} 的包名（不一致时 dsh 静默跳过）`, () => {
    const expected = JSON.parse(readFileSync(pkg, 'utf8')).name;
    const actual = loaderName(patch);
    assert.equal(
      actual,
      expected,
      `${label} 的 cordis.patch.yml 里 name="${actual}"，但包名是 "${expected}"。\n`
      + 'dsh 对 unknown name 是**静默跳过**的：插件会"装上但不生效"，没有任何报错。\n'
      + '改包名时这两处必须一起改。',
    );
  });
}

test('两份 cordis.patch.yml 的**生效 YAML** 必须一致（同步契约）', () => {
  /*
   * 两份文件顶部都写着"内容除 name 外完全一致 —— 改动时同步两份"。
   * 靠注释守不住，这里做机器校验。
   *
   * 比对的判据是**剥掉注释后的 YAML 正文**，不是整份文件：
   * 两份的注释头是**故意不同**的 —— 它们各自解释自己服务的那种安装形态
   * （根文件讲 github 直装，插件文件讲单文件夹分发）。把注释也要求一致
   * 会逼着人写一份含糊其辞、两边都适用的说明，反而更差。
   * 真正必须一致的是**生效的配置**：id、name 之外的键、缩进结构。
   */
  const yamlBody = (p) => readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))          // 去掉整行注释
    .map((line) => line.replace(/\s+#.*$/, ''))     // 去掉行尾注释
    .join('\n')
    .replace(/^(\s*name:\s*)\S+\s*$/m, '$1<X>')     // name 归一
    .trim();
  const a = yamlBody(join(ROOT, 'cordis.patch.yml'));
  const b = yamlBody(join(PLUGIN_DIR, 'cordis.patch.yml'));
  assert.equal(
    a,
    b,
    '两份 cordis.patch.yml 的生效 YAML 已经不同步（除 name 外应一致）。\n'
    + '它们是给两种安装形态用的同一份配置，漂移会导致其中一种装法行为不一致。\n'
    + `--- 仓库根 ---\n${a}\n--- dsh-plugin ---\n${b}`,
  );
});

test('两份 cordis.patch.yml 都必须只插一条 Loader 条目（不得夹带官方条目改动）', () => {
  /*
   * 文件注释里承诺"这里**不动**任何官方条目"。用 YAML 正文钉住：
   * 生效内容必须恰好是 `- insert:` 下的一条 `- id: workbuddy`。
   */
  for (const [label, p] of [['仓库根', join(ROOT, 'cordis.patch.yml')], ['dsh-plugin', join(PLUGIN_DIR, 'cordis.patch.yml')]]) {
    const body = readFileSync(p, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
      .trim();
    assert.match(body, /^- insert:\s*$/m, `${label} 的 YAML 必须只有一条顶层 insert`);
    assert.equal((body.match(/^\s*- id:/gm) || []).length, 1, `${label} 只应插一条 Loader 条目`);
    assert.match(body, /^\s*- id: workbuddy\s*$/m, `${label} 的条目 id 应为 workbuddy`);
  }
});
