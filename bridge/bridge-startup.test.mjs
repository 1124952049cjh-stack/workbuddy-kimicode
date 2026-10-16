/**
 * 桥的**启动参数解析** —— 只关心"参数写错了桥还能不能起来"。
 *
 * 为什么单独一个文件：`bridge.test.mjs` 的 `startBridge()` 总是注入合法端口，
 * 所以「端口写错」这条路径在该文件里**永远走不到**。这正是当年
 * 「未配令牌即放行」那个洞能长期潜伏的同一类盲区：夹具把所有输入都摆成正的，
 * 负的路径没人走。
 *
 * 两层验证：
 *   1. **纯逻辑**：照桥里 `numEnv()` 的规则复刻一份第二实现，逐条对照边界。
 *      便宜、确定、跨平台一致 —— 是主力。
 *   2. **进程级 smoke**：真起一次桥，确认"端口写错不再抛 ERR_SOCKET_BAD_PORT"。
 *      只需 1 例，避免在 CI 上跟别人的端口抢来抢去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'bridge', 'workbuddy-bridge.mjs');
const TOKEN = 'test-token-badport-0123456789';

// ── 第一层：纯逻辑（第二实现） ────────────────────────────────────────────

/**
 * 复刻桥与 config.mjs 共用的规则。
 *
 * 刻意**不复用**被测代码（桥无法被 import，且它的 numEnv 不导出）——
 * 照着规则独立写一份，测试才有证伪能力。
 */
function parseNum(raw, fallback, range = {}) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (value < (range.min ?? -Infinity) || value > (range.max ?? Infinity)) return fallback;
  return range.integer ? Math.trunc(value) : value;
}
const parsePort = (raw, fallback = 8790) => parseNum(raw, fallback, { min: 1, max: 65535, integer: true });

test('端口解析：非数值 / 空白 / 带单位一律回退默认（旧写法会得 NaN）', () => {
  for (const bad of ['879O', 'abc', '8790ms', '  ', 'NaN', 'Infinity', '-']) {
    const got = parsePort(bad);
    assert.equal(got, 8790, `WORKBUDDY_PORT=${JSON.stringify(bad)} 应回退 8790，实际 ${got}`);
    assert.ok(Number.isFinite(got), '绝不能是 NaN —— listen(NaN) 会让桥整个起不来');
  }
});

test('端口解析：越界回退默认，而不是截断到边界', () => {
  // 99999 显然是写错了，静默改成 65535 会让用户以为配置生效了
  for (const bad of ['0', '-1', '65536', '99999']) {
    assert.equal(parsePort(bad), 8790, `端口 ${bad} 越界应回退默认`);
  }
});

test('端口解析：合法值原样保留（含边界）；未设置/空串用默认', () => {
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('8790'), 8790);
  assert.equal(parsePort('65535'), 65535);
  assert.equal(parsePort(undefined), 8790, '未设置时用默认');
  assert.equal(parsePort(''), 8790, '空串视为未设置');
});

test('端口解析：小数端口绝不能原样递给 listen()', () => {
  /*
   * 实测：`WORKBUDDY_PORT=8790.5` 能通过 min/max 检查（1 ≤ 8790.5 ≤ 65535），
   * 于是原样传给 `listen()` → 直接抛
   * `ERR_SOCKET_BAD_PORT: options.port should be >= 0 and < 65536. Received 8790.5`。
   *
   * 与 `879O` 那类错误不同，这一条**看起来完全合法**：用户不会觉得自己写错了，
   * 报错信息里也只有一个裸的数字，没有任何"是你 .env 写错了"的线索。
   *
   * 语义与 config.mjs 的 `integer: true` 对齐：**取整**（不是回退默认），
   * 这样 9999.5 得到 9999 而不是莫名跳回 8790 —— 保留用户意图。
   */
  assert.equal(parsePort('8790.5'), 8790);
  assert.equal(parsePort('8790.9'), 8790);
  // 关键用例：能区分"取整"和"回退默认"两种语义 —— 若实现退化成回退默认，这里会红
  assert.equal(parsePort('9999.5'), 9999, '9999.5 应取整为 9999，而不是回退默认 8790');
  // 小数部分为 0 的写法等价于整数
  assert.equal(parsePort('8790.0'), 8790);
  // 取整后仍在合法区间内，绝不能出现负数或越界
  for (const raw of ['1.9', '65535.9', '8790.5']) {
    const got = parsePort(raw);
    assert.ok(Number.isInteger(got) && got >= 1 && got <= 65535, `${raw} 取整后越界：${got}`);
  }
});

test('整数类参数一律取整：小数不得穿透到要求整数的下游', () => {
  /*
   * `integer: true` 是 config.mjs 那份实现早就有的能力，桥这份漏了 ——
   * 两处漂移的直接后果就是上面那条端口用例（桥用 {integer:true} 之后才成立）。
   * 这里把语义钉住，避免以后又只改一处。
   */
  assert.equal(parseNum('10.7', 0, { min: 0, integer: true }), 10);
  assert.equal(parseNum('10.2', 0, { min: 0, integer: true }), 10);
  // 不带 integer 的照旧保留小数（超时 / 间隔类参数需要亚毫秒精度，不能一律截断）
  assert.equal(parseNum('10.7', 0, { min: 0 }), 10.7);
});

// ── 漂移守卫：两份 numEnv 实现必须语义一致 ──────────────────────────────
//
// 桥刻意保持单文件自包含（不 import 项目内模块），所以 `numEnv()` 在
// `bridge/workbuddy-bridge.mjs` 和 `config.mjs` 里各有一份，靠**人工同步**。
// 这个项目已经因此漂移过两次，两次都由注释记录下来：
//   1. `USERPROFILE` 兜底：config.mjs 有，桥漏了 → 登录文件退化成相对路径，
//      表现成"用户没登录"（见本文件下半部分那条用例的注释）。
//   2. `range.integer`：config.mjs 有，桥漏了 → 小数端口穿透到 listen() 崩桥。
//
// 光靠"改动时两处要一起改"的注释守不住，所以在这里做**行为级**断言：
// 从两个文件里各抽一份实现出来，喂同一组输入，要求输出逐个相等。
// 源码改了但两边没对齐 → 这条用例红。

/**
 * 从源码文本里抽出 `function numEnv(...) { ... }`，返回**工厂**：
 * `makeNumEnv(env)` 得到绑定到该 `env` 的 `numEnv`。
 *
 * 两份实现都是闭包取值（桥读 `process.env`，config.mjs 读闭包里的 `env`），
 * 签名同为 `(name, fallback, range)`，所以统一改写成注入的 `__env` 即可同表对比。
 */
function extractNumEnv(src, label) {
  const start = src.indexOf('function numEnv(');
  assert.notEqual(start, -1, `${label} 里找不到 function numEnv —— 守卫失效，请同步更新本用例`);
  /*
   * 先剥掉块注释再做花括号配平：两份实现的 JSDoc 里都写了 `@param {{ min, max }}`，
   * 那个 `{` 会让朴素配平提前收尾，切出半个函数 → new Function 直接 SyntaxError。
   */
  const stripped = src.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
  /*
   * 从**参数表之后**开始配平：签名里就带 `range = {}` 这种默认值，
   * 它自己成对的 `{}` 会让 depth 在函数体开始前就归零，切出半截。
   */
  const parenEnd = stripped.indexOf(')');
  assert.notEqual(parenEnd, -1, `${label} 的 numEnv 参数表不完整`);
  let i = stripped.indexOf('{', parenEnd);
  assert.notEqual(i, -1, `${label} 的 numEnv 找不到函数体起始花括号`);
  let depth = 0;
  for (; i < stripped.length; i += 1) {
    if (stripped[i] === '{') depth += 1;
    else if (stripped[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.equal(depth, 0, `${label} 的 numEnv 花括号不配平`);
  const body = stripped.slice(0, i + 1);
  /*
   * 统一取值来源：
   *   1. 桥写 `process.env[name]` → 先换成 `__env[`；
   *   2. config.mjs 写 `env[name]` → 再换（lookbehind 挡掉上一步已生成的
   *      `__env[`，`_` 属于 \w，所以不会被二次替换）。
   * 顺序不能颠倒，否则桥的 `process.env[` 会被第二步切坏。
   */
  const normalized = body
    .replace(/process\.env\[/g, '__env[')
    .replace(/(?<![\w.$])env\[/g, '__env[');
  const factory = new Function('__env', `${normalized}; return numEnv;`);
  return (env) => factory(env);
}

/** 造一个只含 PROBE 的假 env，避免用例受真实进程环境影响。 */
const probeEnv = (raw) => (raw === undefined ? {} : { PROBE: raw });

test('漂移守卫：桥与 config.mjs 的 numEnv 对同一组输入必须给出相同结果', () => {
  const bridgeSrc = readFileSync(BRIDGE, 'utf8');
  const configSrc = readFileSync(join(HERE, '..', 'config.mjs'), 'utf8');
  const bridgeNumEnv = extractNumEnv(bridgeSrc, 'workbuddy-bridge.mjs');
  const configNumEnv = extractNumEnv(configSrc, 'config.mjs');

  const cases = [
    // [环境变量值, 默认值, range]
    [undefined, 8790, { min: 1, max: 65535 }],
    ['', 8790, { min: 1, max: 65535 }],
    ['8790', 8790, { min: 1, max: 65535 }],
    ['8790.5', 8790, { min: 1, max: 65535, integer: true }],
    ['8790.5', 8790, { min: 1, max: 65535 }],
    ['879O', 8790, { min: 1, max: 65535 }],
    ['abc', 0, { min: 0 }],
    ['30000', 0, { min: 0 }],
    ['-5', 0, { min: 0 }],
    ['NaN', 0, { min: 0 }],
    ['Infinity', 0, { min: 0 }],
    ['0', 8790, { min: 1, max: 65535 }],
    ['65536', 8790, { min: 1, max: 65535 }],
    ['10.7', 0, { min: 0, integer: true }],
    ['10.7', 0, { min: 0 }],
  ];

  const mismatches = [];
  for (const [raw, fallback, range] of cases) {
    const env = probeEnv(raw);
    const a = bridgeNumEnv(env)('PROBE', fallback, range);
    const b = configNumEnv(env)('PROBE', fallback, range);
    if (!Object.is(a, b)) {
      mismatches.push(
        `PROBE=${JSON.stringify(raw)} range=${JSON.stringify(range)}：`
        + `桥得 ${a}，config.mjs 得 ${b}`,
      );
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    '两份 numEnv 已经漂移。桥是单文件自包含、只能手工同步，'
    + '所以改任意一份都必须同时改另一份：\n' + mismatches.join('\n'),
  );
});

test('漂移守卫：桥的端口解析必须是整数语义（否则 listen() 崩）', () => {
  const makeNumEnv = extractNumEnv(readFileSync(BRIDGE, 'utf8'), 'workbuddy-bridge.mjs');
  for (const raw of ['8790.5', '1.9', '65535.9']) {
    const got = makeNumEnv(probeEnv(raw))('PROBE', 8790, { min: 1, max: 65535, integer: true });
    assert.ok(
      Number.isInteger(got),
      `桥的 numEnv 对 ${raw} 返回了 ${got}（非整数）—— 真跑起来 listen() 会抛 ERR_SOCKET_BAD_PORT`,
    );
  }
});

test('桥的整数语义参数必须显式声明 integer（不得靠调用点 Math.floor 兜底）', () => {
  /*
   * `numEnv` 补上 `integer` 之前，调用点是用 `Math.floor(numEnv(...))` 兜的。
   * 那种写法的问题是：**每个新调用点都要记得自己包一层**，漏了就是隐患
   * （端口那条就是这么漏掉的）。现在统一由 range.integer 承担。
   *
   * 这条用例把"哪些参数是整数语义"钉住：端口、限流计数 —— 它们要么递给
   * 要求整数的 API，要么参与整数比较，拿到小数会静默出错。
   */
  const src = readFileSync(BRIDGE, 'utf8');
  const integerVars = ['WORKBUDDY_PORT', 'WORKBUDDY_RATE_LIMIT_RPM', 'WORKBUDDY_RATE_LIMIT_MIN_INTERVAL_MS'];
  for (const name of integerVars) {
    const m = src.match(new RegExp(`numEnv\\('${name}'[^)]*\\)`));
    assert.ok(m, `桥里找不到 ${name} 的 numEnv 调用 —— 参数改名了？请同步本用例`);
    assert.match(
      m[0],
      /integer:\s*true/,
      `${name} 是整数语义，但调用没写 integer: true：${m[0]}`,
    );
  }
  // 也不该再有人用 Math.floor 包 numEnv —— 那是旧兜底，留着说明又漂回去了
  assert.doesNotMatch(
    src,
    /Math\.floor\(\s*numEnv\(/,
    '出现 Math.floor(numEnv(...))：请改用 { integer: true }，别在调用点各包各的',
  );
});

test('上限类解析：NaN 绝不能"静默取消限制"（MAX_BODY_BYTES 的安全含义）', () => {
  /*
   * 这是本轮最要紧的一条：`readBody` 里是 `if (size > limit)`。
   * 若 limit 变成 NaN，`size > NaN` **恒为 false** —— 请求体上限彻底消失，
   * 同机任何进程都能灌爆内存。所以上限类参数必须回退到**有限正数**默认。
   */
  const DEFAULT_32MB = 32 * 1024 * 1024;
  for (const bad of ['abc', '8790ms', 'NaN', '', '  ']) {
    const got = parseNum(bad, DEFAULT_32MB, { min: 1024 });
    assert.equal(got, DEFAULT_32MB, `上限参数 ${JSON.stringify(bad)} 必须回退默认`);
    assert.ok(Number.isFinite(got) && got > 0, '上限必须是有限正数，否则限制消失');
  }
});

test('超时类解析：非法值与负数一律归 0（NaN 会让 setTimeout 立即触发）', () => {
  for (const bad of ['abc', 'nope', '-5', 'NaN']) {
    assert.equal(parseNum(bad, 0, { min: 0 }), 0, `超时 ${JSON.stringify(bad)} 应归 0`);
  }
  assert.equal(parseNum('30000', 0, { min: 0 }), 30000, '合法超时原样保留');
});

// ── 第二层：进程级 smoke ─────────────────────────────────────────────────
//
// 只留 1 例。断言的是**行为类别**（不再抛端口解析异常），不是具体端口 ——
// 因为 CI runner 上 8790 可能空闲也可能被占，两种都算正确，
// 真去断言"必须监听 8790"反而会和同 job 的其它测试抢端口（本机就踩过这个坑：
// 8790 上跑着用户的真桥，回 401，于是"子进程崩了"也被判成就绪）。

test('桥 smoke：端口写成非数值时不再抛 ERR_SOCKET_BAD_PORT', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-port-'));
  const authFile = join(dir, 'fake-auth.info');
  writeFileSync(authFile, JSON.stringify({
    auth: {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      domain: 'example.invalid',
      expiresAt: Date.now() + 30 * 86_400_000,
    },
  }));

  const child = spawn(process.execPath, [BRIDGE], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOST: '127.0.0.1',
      WORKBUDDY_PORT: '879O', // ← 字母 O：旧写法得到 NaN
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      WORKBUDDY_AUTH_FILE: authFile,
      WORKBUDDY_USAGE_FILE: join(dir, 'usage.jsonl'),
      WORKBUDDY_AUTO_CHECKIN: '0',
      WORKBUDDY_LOG: '0',
    },
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  try {
    const deadline = Date.now() + 12_000;
    // 等它要么成功监听，要么以可解释的原因退出
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (/listening|已监听|LISTENING|EADDRINUSE/iu.test(output)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(
      !/ERR_SOCKET_BAD_PORT|options\.port should be/u.test(output),
      `端口写错时仍死在解析上（用户看不出是自己 .env 写错了）：\n${output.slice(-500)}`,
    );
    if (child.exitCode !== null) {
      assert.match(
        output,
        /EADDRINUSE|listen/iu,
        `若非正常退出，输出里必须能看出原因，实际：\n${output.slice(-500)}`,
      );
    }
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 顺带钉住"桥确实用了这条规则" ─────────────────────────────────────────

/**
 * 登录文件目录必须在**真实环境变量缺失**时仍然给出绝对路径。
 *
 * 现场（子进程实测）：Windows 默认**只有 `USERPROFILE`、没有 `HOME`**，而桥的
 * `AUTH_DIRS` 只认 `LOCALAPPDATA` / `HOME` / `XDG_DATA_HOME`。一旦 `LOCALAPPDATA`
 * 也没了（精简过的环境、从计划任务启动、CI），三个都为空 → 最后那行
 * `join(AUTH_DIRS[0] || '.', 'workbuddy-desktop.info')` 拼出**相对路径**
 * `workbuddy-desktop.info`。相对路径按 cwd 解析 → 桥找不到登录文件，
 * 而用户看到的是"没登录"，跟环境变量毫无关系，根本猜不到。
 * （同一份实现在 config.mjs 里有 `USERPROFILE` 兜底，桥这边漏了 —— 两套实现必然漂移。）
 */
test('登录文件目录：LOCALAPPDATA / HOME 都缺时也必须给出绝对路径', async () => {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: HERE,
    env: {
      ...process.env,
      WORKBUDDY_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      WORKBUDDY_LOCAL_TOKEN: TOKEN,
      // 模拟"精简过 / 非交互式"的 Windows 环境：三者全空，只剩 USERPROFILE
      LOCALAPPDATA: '', HOME: '', XDG_DATA_HOME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/auth file/iu.test(output) && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const m = output.match(/auth file\s*:\s*(.+)/iu);
    assert.ok(m, `桥没打印 auth file 行，输出：\n${output.slice(-400)}`);
    const authPath = m[1].trim();
    assert.ok(
      /^[A-Za-z]:[\\/]|^\//u.test(authPath),
      `登录文件路径是**相对路径**（${authPath}）—— 它会按启动目录解析，`
      + '于是"桥找不到登录文件"会表现成"用户没登录"，而真凶是环境变量缺失。',
    );
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000);
    });
  }
});

test('桥源码里不再有裸 Number(process.env.*) 的数值读取（防止回退）', () => {
  /*
   * 规则写对了、但某处忘了改，是这个 bug 最可能的复发方式（本轮就是
   * config.mjs 修了、桥没修）。所以直接扫源码：**所有**数值型 env 读取
   * 都必须经过 numEnv()。
   *
   * 字符串/开关类（HOST / 版本号 / LOG 等）本来就不该走 numEnv，不在其列。
   */
  const src = readFileSync(BRIDGE, 'utf8');
  const offenders = [];
  for (const [i, line] of src.split(/\r?\n/).entries()) {
    // 只看代码：注释里会引用旧写法作对照（`Number(process.env.X || 默认)`），
    // 那是文档不是实现，不该被判为违规。
    const code = line.replace(/\/\/.*$/u, '');
    if (/^\s*\*|^\s*\/\*/u.test(line)) continue;
    for (const m of code.matchAll(/\bNumber\(\s*process\.env\.([A-Z0-9_]+)/gu)) {
      offenders.push(`${m[1]} (第 ${i + 1} 行)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些 env 读取绕过了 numEnv()，非法值会变 NaN：${offenders.join(', ')}`,
  );
});

/**
 * 任何**起了桥进程**的测试都必须显式隔离账本。
 *
 * ## 为什么是"扫源码"而不是"跑一遍看有没有写脏"
 *
 * 后者测的是"当前这几个文件"，新增一个测试文件时它无效 —— 而漏掉隔离的
 * 恰恰是新增文件。扫源码能把**未来**的文件也覆盖住。
 *
 * ## 这条守的是什么（2026-10-13 实测的数据损失）
 *
 * `usageFile()` = `WORKBUDDY_USAGE_FILE`，否则退回**桥脚本所在目录**下的
 * `usage.jsonl` —— 也就是使用者的真实账本。它**与 cwd 无关**，所以测试里
 * 惯用的 `cwd: dir`（临时目录）根本挡不住。
 *
 * 实测后果：`bridge-responses.test.mjs` 一次运行就往真实账本写进 **36 行**
 * 测试记录（真实账本里累计 914 条 `resolved-default` + 58 条 `resolved-fast`
 * + 14 条 `stub-model`，占总量一半以上）。而账本到 `MAX_USAGE_LINES`(2000)
 * 会**截断保留最近一半** —— 等于把用户自己的用量历史挤掉。
 *
 * `bridge.test.mjs` / `bridge-startup.test.mjs` 早就设了这一项，
 * `bridge-responses.test.mjs` 与 `bridge-cors.test.mjs` 是漏的（已补）。
 */
test('起了桥进程的测试文件必须隔离账本（否则会写坏使用者的真实账本）', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    // 只有"真的 spawn 了桥"的文件才需要隔离；纯逻辑用例不产生上游请求
    if (!/spawn\(\s*process\.execPath/u.test(src)) continue;
    /*
     * 判据必须看**赋值**，不能只搜名字。
     *
     * 第一版就是搜 `WORKBUDDY_USAGE_FILE` 这个字符串，结果把**注释里的解释**也算
     * 成"已隔离" —— 反证时（把赋值删掉、注释留着）守卫照样变绿，等于这条用例
     * 测不出它该测的东西。现在要求出现 `WORKBUDDY_USAGE_FILE:` 或
     * `WORKBUDDY_USAGE_FILE =` 这样真正的赋值形状。
     */
    if (!/WORKBUDDY_USAGE_FILE\s*[:=]/u.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些测试文件起了桥却没设 WORKBUDDY_USAGE_FILE，会往仓库 bridge/usage.jsonl `
    + `（使用者的真实账本）里写测试记录：${offenders.join(', ')}`,
  );
});
