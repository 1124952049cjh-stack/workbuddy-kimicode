/**
 * 「凭据引用」这一项不能对着**没装 DSH** 的机器报 fail。
 *
 *   node --test lib/diagnostics.credref.test.mjs
 *
 * ## 缺陷现场（本机实测）
 *
 * 判定原本只有一句 `dsh.hasBridgeKey ? 'ok' : 'fail'`。在**只用 Kimi Code、
 * 从没装过 DSH Desktop** 的机器上，`~/.dsh/` 只有 `settings.yaml`（控制台早期
 * 版本写下的路由）而没有 profile，`hasBridgeKey` 自然是 false —— 于是自检页
 * 报出一个**红色 fail**：
 *
 *   [✗] 凭据引用   缺少占位凭据
 *         └ pi-ai 的 OpenAI 实现要求必须提供 API key 引用
 *   结果  8 项通过 / 1 项警告 / 1 项失败 —— 存在必须修复的问题，
 *         模型不会出现在 dsh 的模型选择器里。
 *
 * 这段结论对这台机器**完全不成立**：DSH Desktop 没装，根本没有"模型选择器"
 * 可谈。用户看到"存在必须修复的问题"只会去追一个不存在的故障。
 *
 * 判据是「DSH 这条路径是否真的在用」，而不是「那个键在不在」：
 *   - 有 profile（`profiles/desktop/package.json`）→ 真在用 → 缺键才 fail；
 *   - 没有 profile → 没用 → 至多 warn（settings.yaml 残留可以顺手清理），
 *     绝不能是 fail，更不能让汇总说"必须修复"。
 *
 * 抽成纯函数 `credRefStatus()` 是为了能直接测：它只吃一个 DSH 状态对象，
 * 不碰文件系统，所以三种现场都能精确构造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credRefStatus } from './diagnostics.mjs';

/** 造一个「只用 Kimi Code、没装 DSH Desktop」的现场：有 settings.yaml，无 profile。 */
const noDshInstalled = () => ({
  hasBridgeKey: false,
  settingsExists: true,
  settingsHasRoute: true,
  profileInstalled: false,
  bundles: [],
});

/** 造一个「DSH Desktop 真的装了」的现场。 */
const dshInstalled = (hasKey) => ({
  hasBridgeKey: hasKey,
  settingsExists: true,
  settingsHasRoute: true,
  profileInstalled: true,
  bundles: [],
});

test('没装 DSH 时，缺 key 绝不能报 fail（那台机器上没有 dsh 模型选择器）', () => {
  const r = credRefStatus(noDshInstalled());
  assert.notEqual(r.status, 'fail', `对没装 DSH 的机器报了 fail：${r.detail}`);
  assert.equal(r.status, 'warn', '没用到的路径，至多提醒一句');
  // 提示里必须说清"这条路径没在用"，否则用户还是会去追
  assert.match(r.hint, /DSH|未安装|没装|不在用/, `提示没解释清楚为什么可以忽略：${r.hint}`);
});

test('装了 DSH 但缺 key：必须 fail（这时它真的会起不来）', () => {
  const r = credRefStatus(dshInstalled(false));
  assert.equal(r.status, 'fail', 'DSH 在用又缺凭据引用，这是真故障');
  assert.match(r.hint, /apiKeyEnv|WORKBUDDY_BRIDGE_KEY|凭据/, '要告诉用户该配什么');
});

test('装了 DSH 且 key 在：ok', () => {
  const r = credRefStatus(dshInstalled(true));
  assert.equal(r.status, 'ok');
});

test('没装 DSH 但 key 恰好在：仍然 ok（不是错，只是用不上）', () => {
  const r = credRefStatus({ ...noDshInstalled(), hasBridgeKey: true });
  assert.equal(r.status, 'ok');
});

test('判定只依赖传入状态，不读文件系统（同输入必同输出）', () => {
  const a = credRefStatus(noDshInstalled());
  const b = credRefStatus(noDshInstalled());
  assert.deepEqual(a, b);
});
