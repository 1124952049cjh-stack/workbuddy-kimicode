/**
 * Kimi Code 一键接入用例。
 *
 *   node --test lib/kimi-code-connect.test.mjs
 *
 * 全部用例使用 WORKBUDDY_KIMI_CODE_CONFIG 把路径指到临时目录，
 * 绝不碰真实的 ~/.kimi-code/config.toml。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyClient, undoClient, verifyWritten, findClient, clientPath, clientMode,
  currentModelFor, currentModelsFor, resolveSelection, switchClientMode,
  contextForClient, CONNECT_CLIENTS,
} from './client-connect.mjs';

// fakeBase/baseWith/MULTI: 与 client-connect.test.mjs 同款，在此重新定义以保持独立
const MULTI = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000 },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000 },
  { id: 'kimi-k3', name: 'Kimi-K3', context: 960000, maxOutput: 32000 },
];
const baseWith = () => ({
  token: 't', baseUrlOpenAI: 'o', baseUrlAnthropic: 'a',
  models: MULTI, catalogById: new Map(MULTI.map((m) => [m.id, m])),
  catalogIds: new Set(MULTI.map((m) => m.id)),
  defaultModel: 'deepseek-v4.1-flash', responsesModel: 'glm-5.3', anthropicModel: 'glm-5.3',
  running: false, bridge: { up: false, authRejected: false }, catalogStale: false, catalogAt: null,
});

// ── Kimi Code 客户端：kimi-toml 格式的完整往返 ─────────────────────────────
//
// Kimi Code config.toml 的独立格式：
//   - 不改 default_model 及其他任何顶层键
//   - 写 [providers.workbuddy]
//   - 写各 [models."workbuddy/<id>"] 节
// 测试全部使用 WORKBUDDY_KIMI_CODE_CONFIG 把路径指到临时目录，绝不碰真实的
// ~/.kimi-code/config.toml。

/** 造一个仅含 kimi-code 路径的小型沙箱。 */
function kimiSandbox({ content } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kc-connect-'));
  const cfgDir = join(dir, '.kimi-code');
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, 'config.toml');
  const backupRoot = join(dir, 'backups');
  if (content !== undefined) writeFileSync(cfgPath, content);
  const savedEnv = {
    WORKBUDDY_KIMI_CODE_CONFIG: process.env.WORKBUDDY_KIMI_CODE_CONFIG,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
  };
  process.env.WORKBUDDY_KIMI_CODE_CONFIG = cfgPath;
  return {
    dir, cfgPath, backupRoot,
    cleanup: () => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const kcCtx = () => ({
  token: 'kc-tok-abc-1234567890',
  baseUrlOpenAI: 'http://127.0.0.1:8790/v1',
  baseUrlAnthropic: 'http://127.0.0.1:8790',
  model: 'deepseek-v4.1-flash',
  models: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1000000, maxOutput: 128000 },
    { id: 'glm-5.3', name: 'GLM-5.3', context: 1000000, maxOutput: 48000 },
  ],
});

const KIMI_ORIGINAL = [
  '# 我的 Kimi Code 配置 —— 这行注释必须活下来',
  'default_model = "4399/gpt-5.6-sol"',
  '',
  '[providers."managed:kimi-code"]',
  'base_url = "https://api.kimi.com/coding/v1"',
  'type = "kimi"',
  'api_key = ""',
  '',
  '[models."4399/claude-sonnet-4-6"]',
  'provider = "4399"',
  'model = "claude-sonnet-4-6"',
  'max_context_size = 900000',
  '',
].join('\n');

test('kimi-code：apply 写入后静态自检通过，不改 default_model', () => {
  const sb = kimiSandbox({ content: KIMI_ORIGINAL });
  try {
    const c = kcCtx();
    const r = applyClient('kimi-code', c, { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true, `apply 失败：${r.error}`);
    assert.equal(r.changed, true);

    const after = readFileSync(sb.cfgPath, 'utf8');
    // default_model 不能被动
    assert.match(after, /default_model = "4399\/gpt-5\.6-sol"/, 'default_model 必须保持不变');
    // [providers.workbuddy] 节
    assert.match(after, /\[providers\.workbuddy\]/, '[providers.workbuddy] 节必须写入');
    assert.match(after, /base_url = "http:\/\/127\.0\.0\.1:8790\/v1"/, 'base_url 必须写入');
    // 两个模型节
    assert.match(after, /\[models\."workbuddy\/deepseek-v4\.1-flash"\]/, 'flash 模型节必须写入');
    assert.match(after, /\[models\."workbuddy\/glm-5\.3"\]/, 'glm 模型节必须写入');
    // 原有的别人节不能动
    assert.match(after, /\[models\."4399\/claude-sonnet-4-6"\]/, '原有别人节必须保留');
    assert.match(after, /# 我的 Kimi Code 配置/, '注释必须保留');

    // 静态自检
    const v = verifyWritten(findClient('kimi-code'), c);
    assert.equal(v.ok, true, `静态自检失败：${v.reason}`);
  } finally { sb.cleanup(); }
});

test('kimi-code：写入后 clientMode = bridge，撤销后 = native', () => {
  const sb = kimiSandbox({ content: KIMI_ORIGINAL });
  try {
    const c = kcCtx();
    assert.equal(clientMode(findClient('kimi-code')), 'native', '写入前应是 native');
    assert.equal(applyClient('kimi-code', c, { backupRoot: sb.backupRoot }).ok, true);
    assert.equal(clientMode(findClient('kimi-code')), 'bridge', '写入后应是 bridge');
    assert.equal(undoClient('kimi-code', { backupRoot: sb.backupRoot }).ok, true);
    assert.equal(clientMode(findClient('kimi-code')), 'native', '撤销后应是 native');
  } finally { sb.cleanup(); }
});

test('kimi-code：撤销后与原始内容逐字节相同（往返可逆）', () => {
  const sb = kimiSandbox({ content: KIMI_ORIGINAL });
  try {
    const c = kcCtx();
    assert.equal(applyClient('kimi-code', c, { backupRoot: sb.backupRoot }).ok, true);
    assert.equal(undoClient('kimi-code', { backupRoot: sb.backupRoot }).ok, true);
    const after = readFileSync(sb.cfgPath, 'utf8');
    assert.equal(after, KIMI_ORIGINAL, '撤销后内容必须与原始内容完全一致');
  } finally { sb.cleanup(); }
});

test('kimi-code：幂等 —— 重复写入不再报 changed，不覆盖首次 restore', () => {
  const sb = kimiSandbox({ content: KIMI_ORIGINAL });
  try {
    const c = kcCtx();
    const r1 = applyClient('kimi-code', c, { backupRoot: sb.backupRoot });
    assert.equal(r1.ok, true);
    assert.equal(r1.changed, true);
    const r2 = applyClient('kimi-code', c, { backupRoot: sb.backupRoot });
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false, '内容没变时不应再报 changed');

    // 撤销仍应还原到最初那份（不是中间态）
    assert.equal(undoClient('kimi-code', { backupRoot: sb.backupRoot }).ok, true);
    const after = readFileSync(sb.cfgPath, 'utf8');
    assert.equal(after, KIMI_ORIGINAL, '幂等写入后撤销仍应还原到最初');
  } finally { sb.cleanup(); }
});

test('kimi-code：空配置文件也能写入（首次使用场景）', () => {
  const sb = kimiSandbox({ content: '' });
  try {
    const c = kcCtx();
    const r = applyClient('kimi-code', c, { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true, `空文件应当能写入：${r.error}`);
    const after = readFileSync(sb.cfgPath, 'utf8');
    assert.match(after, /\[providers\.workbuddy\]/);
    assert.match(after, /\[models\."workbuddy\/deepseek-v4\.1-flash"\]/);
    // 撤销后回到空文件（或文件被删）
    assert.equal(undoClient('kimi-code', { backupRoot: sb.backupRoot }).ok, true);
  } finally { sb.cleanup(); }
});

test('kimi-code：配置文件不存在时也能写入（自动创建目录与文件）', () => {
  const sb = kimiSandbox(/* 不写文件 */);
  try {
    const c = kcCtx();
    const r = applyClient('kimi-code', c, { backupRoot: sb.backupRoot });
    assert.equal(r.ok, true, `文件不存在时应当能写入：${r.error}`);
    assert.match(readFileSync(sb.cfgPath, 'utf8'), /\[providers\.workbuddy\]/);
    // 撤销：文件是我们建的，还原后应当删掉它（或置空）
    assert.equal(undoClient('kimi-code', { backupRoot: sb.backupRoot }).ok, true);
  } finally { sb.cleanup(); }
});

test('kimi-code：currentModelFor / currentModelsFor 正确读回', () => {
  const sb = kimiSandbox({ content: '' });
  try {
    const c = kcCtx();
    assert.equal(currentModelFor(findClient('kimi-code')), null, '写入前读不到模型');
    assert.equal(applyClient('kimi-code', c, { backupRoot: sb.backupRoot }).ok, true);

    const model = currentModelFor(findClient('kimi-code'));
    // currentModelFor 返回第一个找到的 [models."workbuddy/<id>"] 的 id
    assert.equal(model, 'deepseek-v4.1-flash', `currentModelFor 应返回首个模型 id，实际 ${model}`);

    const models = currentModelsFor(findClient('kimi-code'), baseWith());
    assert.ok(models.includes('deepseek-v4.1-flash'), 'currentModelsFor 必须包含 flash');
    assert.ok(models.includes('glm-5.3'), 'currentModelsFor 必须包含 glm-5.3');
    assert.equal(models.length, 2);
  } finally { sb.cleanup(); }
});

test('kimi-code：native/bridge 模式切换（换挡，记录留着）', () => {
  const sb = kimiSandbox({ content: KIMI_ORIGINAL });
  try {
    const c = kcCtx();
    assert.equal(applyClient('kimi-code', c, { backupRoot: sb.backupRoot }).ok, true);
    // 切到原始模型模式
    const sn = switchClientMode('kimi-code', 'native', null, { backupRoot: sb.backupRoot });
    assert.equal(sn.ok, true, `切到 native 失败：${sn.error}`);
    assert.equal(clientMode(findClient('kimi-code')), 'native');

    // 切回桥模式（沿用上次的参数）
    const sb2 = switchClientMode('kimi-code', 'bridge', c, { backupRoot: sb.backupRoot });
    assert.equal(sb2.ok, true, `切回 bridge 失败：${sb2.error}`);
    assert.equal(clientMode(findClient('kimi-code')), 'bridge');
  } finally { sb.cleanup(); }
});

test('kimi-code：路径优先级 WORKBUDDY_KIMI_CODE_CONFIG > KIMI_CODE_HOME > 默认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kc-prio-'));
  const savedWKC = process.env.WORKBUDDY_KIMI_CODE_CONFIG;
  const savedKCH = process.env.KIMI_CODE_HOME;
  const savedUP = process.env.USERPROFILE;
  const savedHM = process.env.HOME;
  try {
    process.env.USERPROFILE = dir;
    process.env.HOME = dir;
    delete process.env.WORKBUDDY_KIMI_CODE_CONFIG;
    delete process.env.KIMI_CODE_HOME;

    // 默认
    assert.equal(clientPath(findClient('kimi-code')), join(dir, '.kimi-code', 'config.toml'));

    // KIMI_CODE_HOME
    process.env.KIMI_CODE_HOME = join(dir, 'kchome');
    assert.equal(clientPath(findClient('kimi-code')), join(dir, 'kchome', 'config.toml'));

    // WORKBUDDY_KIMI_CODE_CONFIG 最优先
    process.env.WORKBUDDY_KIMI_CODE_CONFIG = join(dir, 'explicit.toml');
    assert.equal(clientPath(findClient('kimi-code')), join(dir, 'explicit.toml'));
  } finally {
    if (savedWKC === undefined) delete process.env.WORKBUDDY_KIMI_CODE_CONFIG; else process.env.WORKBUDDY_KIMI_CODE_CONFIG = savedWKC;
    if (savedKCH === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = savedKCH;
    if (savedUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUP;
    if (savedHM === undefined) delete process.env.HOME; else process.env.HOME = savedHM;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kimi-code：KIMI_CODE_HOME 在 import 之后设置仍然生效（getter 语义）', async () => {
  // 直接引用路径函数而非缓存值 —— 用子进程验同一套场景。
  const dir = mkdtempSync(join(tmpdir(), 'kc-getter-'));
  const { spawn } = await import('node:child_process');
  const url = new URL('./find-kimi-code.mjs', import.meta.url).href;
  const target = join(dir, 'moved-kimi-code');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { kimiCodeDir } = await import(${JSON.stringify(url)});
      const before = kimiCodeDir();
      process.env.KIMI_CODE_HOME = ${JSON.stringify(target)};
      const after = kimiCodeDir();
      process.stdout.write(JSON.stringify({ before, after }));
    `], {
      env: { ...process.env, KIMI_CODE_HOME: undefined, USERPROFILE: dir, HOME: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`子进程退出码 ${code}`));
      const { before, after } = JSON.parse(out);
      assert.ok(before.endsWith('.kimi-code'), `设置前应是默认路径，实际 ${before}`);
      assert.equal(after, target, `KIMI_CODE_HOME 改了之后应立刻生效，实际 ${after}`);
      resolve();
    });
  });
  rmSync(dir, { recursive: true, force: true });
});

test('kimi-code：模型集合缩小时裁掉僵尸节；用户手写的同名节不动', () => {
  const USER_OWN = [
    '[models."workbuddy/mine"]',
    'provider = "workbuddy"',
    'model = "mine"',
    'max_context_size = 128000',
    '',
  ].join('\n');
  const sb = kimiSandbox({ content: `# 注释\n${USER_OWN}` });
  try {
    const c = kcCtx(); // models: deepseek-v4.1-flash + glm-5.3
    assert.equal(applyClient('kimi-code', c, { backupRoot: sb.backupRoot }).ok, true);
    assert.match(readFileSync(sb.cfgPath, 'utf8'), /workbuddy\/glm-5\.3/);

    // 只接 deepseek 一个：glm-5.3 是我们写的 → 应被裁掉；workbuddy/mine 是用户手写 → 保留
    const c2 = { ...c, model: 'deepseek-v4.1-flash', models: [c.models[0]] };
    const r2 = applyClient('kimi-code', c2, { backupRoot: sb.backupRoot });
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.changed, true, '裁掉僵尸节必须算改动（否则界面显示"无需改动"而文件里留着必败的选项）');
    const after = readFileSync(sb.cfgPath, 'utf8');
    assert.ok(!after.includes('workbuddy/glm-5.3'), 'glm-5.3 的旧节应被裁掉');
    assert.ok(after.includes('workbuddy/deepseek-v4.1-flash'), '选中的保留');
    assert.ok(after.includes('workbuddy/mine'), '用户手写的 workbuddy/* 节一条不碰');

    // 撤销：回到最初（连裁掉的 glm 也从原始记录里正确消失）
    assert.equal(undoClient('kimi-code', { backupRoot: sb.backupRoot }).ok, true);
    assert.equal(readFileSync(sb.cfgPath, 'utf8'), `# 注释\n${USER_OWN}`, '撤销后与初始逐字节一致');
  } finally { sb.cleanup(); }
});

test('kimi-code：CONNECT_CLIENTS 里排第一（主路径）', () => {
  assert.equal(CONNECT_CLIENTS[0].id, 'kimi-code', 'kimi-code 应是主路径，排在 CONNECT_CLIENTS 第一位');
});

test('kimi-code：currentModelsFor / resolveSelection 从文件读回', () => {
  const content = [
    'default_model = "4399/gpt-5.6-sol"',
    '',
    '[providers.workbuddy]',
    'type = "openai"',
    'base_url = "http://127.0.0.1:8790/v1"',
    'api_key = "tok"',
    '',
    '[models."workbuddy/glm-5.3"]',
    'provider = "workbuddy"',
    'model = "glm-5.3"',
    'max_context_size = 1000000',
    'capabilities = ["tool_use"]',
    'display_name = "GLM-5.3 (WorkBuddy)"',
    '',
    '[models."workbuddy/kimi-k3"]',
    'provider = "workbuddy"',
    'model = "kimi-k3"',
    'max_context_size = 960000',
    'capabilities = ["tool_use"]',
    'display_name = "Kimi-K3 (WorkBuddy)"',
    '',
  ].join('\n');
  const sb = kimiSandbox({ content });
  try {
    const base = baseWith();
    const client = findClient('kimi-code');
    const models = currentModelsFor(client, base);
    assert.ok(models.includes('glm-5.3'));
    assert.ok(models.includes('kimi-k3'));
    assert.equal(models.length, 2);
    // 显式勾选优先
    assert.deepEqual(resolveSelection(base, client, ['glm-5.3']), ['glm-5.3']);
    // 无显式勾选时用文件里现有那批
    assert.deepEqual(resolveSelection(base, client, null), ['glm-5.3', 'kimi-k3']);
  } finally { sb.cleanup(); }
});

test('kimi-code：能力元数据按桥目录写入（image_in / thinking / 档位过滤 minimal）', () => {
  const sb = kimiSandbox({ content: '' });
  try {
    const c = {
      token: 'kc-tok', baseUrlOpenAI: 'http://127.0.0.1:8790/v1', baseUrlAnthropic: 'http://127.0.0.1:8790',
      model: 'vision-r',
      models: [
        { id: 'vision-r', name: 'Vision-R', context: 200000, maxOutput: 8000,
          images: true, supportsReasoning: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
        { id: 'only-r', name: 'Only-R', context: 128000, maxOutput: 4096,
          onlyReasoning: true, efforts: ['low', 'max'] },
        { id: 'plain', name: 'Plain', context: 128000, maxOutput: 4096 },
      ],
    };
    assert.equal(applyClient('kimi-code', c, { backupRoot: sb.backupRoot }).ok, true);
    const after = readFileSync(sb.cfgPath, 'utf8');

    // 视觉 + 推理 + 实测档位：minimal 被过滤（Kimi 无此档），xhigh 实测收了才写
    assert.match(after, /capabilities = \["tool_use", "thinking", "image_in"\]/);
    assert.match(after, /support_efforts = \["low", "medium", "high", "xhigh"\]/);
    assert.match(after, /default_effort = "medium"/);

    // only_reasoning：不能关思考 → thinking + always_thinking；无 medium 取第一档
    assert.match(after, /capabilities = \["tool_use", "thinking", "always_thinking"\]/);
    assert.match(after, /support_efforts = \["low", "max"\]/);
    assert.match(after, /default_effort = "low"/);

    // 元数据缺失 → 保守只声明 tool_use，档位两行不写
    assert.match(after, /capabilities = \["tool_use"\]/);
    const allLines = after.split('\n');
    const plainIdx = allLines.findIndex((l) => l.trim() === '[models."workbuddy/plain"]');
    assert.ok(plainIdx >= 0);
    const nextSec = allLines.findIndex((l, i) => i > plainIdx && /^\s*\[/.test(l));
    const plainBody = allLines.slice(plainIdx + 1, nextSec < 0 ? allLines.length : nextSec).join('\n');
    assert.ok(!plainBody.includes('support_efforts'), '无实测档位时不写 support_efforts');
    assert.ok(!plainBody.includes('default_effort'), '无实测档位时不写 default_effort');

    // 幂等：再写一次不应报 changed
    const r2 = applyClient('kimi-code', c, { backupRoot: sb.backupRoot });
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false, '能力行有档位时也必须幂等');
  } finally { sb.cleanup(); }
});
