#!/usr/bin/env node
/**
 * 打一个能直接发给同事的包。
 *
 *   node tools/pack-dist.mjs            # 产出 dist/workbuddy-to-kimicode-<version>.zip
 *
 * ## 为什么不用 `git archive` / 直接 zip 整个目录
 *
 * 因为**清单必须是显式的白名单**。这个目录里同时住着两类东西：
 *   · 产品（bridge / dashboard / lib / tools / docs / 启动.cmd …）
 *   · 使用者本机的运行痕迹（`.bridge-token`、`bridge/usage.jsonl`、
 *     `.backup/client-configs/**` 里的配置备份 —— 从第二次写入起里面**就有本地令牌**）
 *
 * 后者一旦被顺手打进包，等于把「谁的令牌」连同「谁用过什么」一起发出去。
 * 所以这里**只拷贝清单里的路径**，而不是「拷贝全部再排除」——
 * 排除法将来新增一个运行时产物就会被漏掉，白名单法不会。
 *
 * ## 包里为什么带 dsh-plugin/
 *
 * 它是同一套桥的另一个前端（DeepSeek Harness 原生插件），对同事是**可选**的：
 * 不装 dsh 也能用桥 + 控制台 + Kimi Code 接入。带上它是因为 `REQUIREMENTS` 与
 * 控制台都会引用那条路径，缺了会让插件用户无从下手；而 vendor/ 已随仓库同步。
 *
 * ## 零依赖
 *
 * 只用 `node:fs` + `node:zlib` 手写 zip（STORED，不压缩）。
 * 不引 `archiver` / `adm-zip`：这个项目的卖点之一就是 `npm install` 都不用跑，
 * 打个包却要先装依赖说不过去。产物大一点（~10MB）换「拿到就能解压」。
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 包内顶层目录名（解压出来就是一个自解释的文件夹）。 */
const PKG_NAME = `${PKG.name}-${PKG.version}`;

/**
 * 要进包的路径（相对仓库根）。**白名单**，见文件头说明。
 *
 * 刻意**不含** `node_modules`：本项目零运行时依赖，`启动.cmd` / `node dashboard/server.mjs`
 * 直接就能跑；带上 48MB 的 devDependencies 只会让同事以为必须先 `npm install`。
 */
const INCLUDE = [
  'bridge',
  'dashboard',
  'lib',
  'tools',
  'scripts',
  'docs',
  // DSH 插件是同一套桥的另一个前端（可选）。**必须在清单里**：它被上游
  // `.gitignore` 当作"发布产物"忽略，但那不适用于本脚本的显式白名单 ——
  // 少了它的后果实测过（包内 /dsh-plugin/ 条目数为 0，插件用户拿到残缺包）。
  'dsh-plugin',
  'config.mjs',
  'package.json',
  'package-lock.json',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'NOTICE.md',
  'LICENSE',
  '.env.example',
  '.gitignore',
  'Dockerfile',
  '.dockerignore',
  'eslint.config.js',
  'jsconfig.json',
  'cordis.patch.yml',
  '启动.cmd',
  // 同事上手用的一页说明（由下面的 REQUIREMENTS.md 生成，不在仓库里）
  'START-HERE.md',
];

/**
 * 无论清单怎么写都**永不进包**的名字（第二道闸门）。
 *
 * 白名单已经不会命中它们，但这一层挡的是「将来有人把整个目录加进 INCLUDE」
 * 这类改动 —— 那时它会直接让打包失败，而不是安静地把令牌发出去。
 */
const NEVER = [
  '.bridge-token', '.env', '.state.json', '.model-prefs.json',
  'usage.jsonl', 'bridge.log', 'applied.json',
];

/** 同事上手的一页说明 —— 面向「我拿到这个 zip」而不是「我在开发它」。 */
function startHere() {
  return `# 从这里开始（${PKG.name} v${PKG.version}）

把 WorkBuddy 桌面端已登录的模型额度，经一个本机桥接到 **Kimi Code**（以及 Claude Code /
Codex / opencode 等任意 OpenAI 兼容客户端）。**只在本机回环地址上工作，不对外暴露。**

---

## 一、前置条件（三件）

| 条件 | 怎么确认 |
|---|---|
| Node.js 18+ | \`node -v\` |
| WorkBuddy 桌面端**已安装且已登录** | 打开它，能正常对话即可 |
| Kimi Code CLI | \`kimi --version\`（要接 Claude Code 等则换成对应客户端） |

**不需要 \`npm install\`** —— 本项目零运行时依赖，解压即可用。

---

## 二、跑起来（两行命令）

\`\`\`cmd
:: 1) 双击 启动.cmd —— 桥 + 网页控制台一起起来，浏览器自动打开 http://127.0.0.1:8792
::    窗口留着别关；关掉窗口桥会继续在后台跑，下次启动直接复用。

:: 2) 接入 Kimi Code（在该目录里）
npm run connect apply kimi-code
\`\`\`

第 2 步会：把 \`[providers.workbuddy]\` 与各 \`[models."workbuddy/<id>"]\` 写进
\`~/.kimi-code/config.toml\` → **先整份备份** → 收紧文件权限 → 静态读回 →
拿刚写进去的令牌**真打一次桥**验证，最后直接告诉你下一步敲什么。

> **它不会改你的 \`default_model\`**，也不会碰你已有的任何 provider / 模型 / 注释。

---

## 三、用起来

\`\`\`cmd
kimi -m "workbuddy/glm-5.3"     :: 直接用某个 WorkBuddy 模型
kimi                            :: 然后在会话里 /model 选 workbuddy/...
\`\`\`

想默认走桥，就自己把 \`~/.kimi-code/config.toml\` 顶部的 \`default_model\` 改成
\`"workbuddy/glm-5.3"\`。

**如果启动时报 \`provider managed:kimi-code has no credential configured\`**：
那是 Kimi Code 在检查你的**默认模型**有没有凭据（新机器上从没 \`/login\` 过就是这样），
与桥无关。两条路任选：先在 kimi 里 \`/login\` 一次，或把 \`default_model\` 指到
\`workbuddy/glm-5.3\`。

---

## 四、想换模型 / 想反悔

\`\`\`cmd
npm run connect status                              :: 看现状与将要改什么
npm run connect apply kimi-code --models glm-5.3,deepseek-v4.1-flash,deepseek-v4-pro
npm run connect native kimi-code                    :: 暂时切回你自己的模型（配置留着）
npm run connect bridge kimi-code                    :: 再切回走桥
npm run connect undo kimi-code                      :: 彻底拆掉，config.toml 逐字节还原
npm run connect verify kimi-code                    :: 静态读回 + 端到端验证
\`\`\`

模型 id 可以从控制台「可用模型」页签里挑（勾选后点「保存」即可，页面会告诉你写进哪）。

---

## 五、日常运维（网页控制台 http://127.0.0.1:8792）

- **状态卡**：账号、令牌剩余有效期、桥进程、可用模型数、积分余额
- **用量统计**：调用次数 / token / 消耗积分 / 失败数，可导出 CSV（只记元数据，不含对话内容）
- **每日签到**：默认自动签（桥侧定时器），积分不领白不领
- **可用模型**：一键体检每个模型能否调通、一键取消不可用的
- **对话测试**：不下客户端也能直接试桥

---

## 六、边界（务必知道）

1. **非官方路径。** 依赖 WorkBuddy 桌面端未公开的凭据存储格式，上游改动可能让它失效 ——
   把它当作「随时可能需要更新」的互操作性实现，而不是稳定服务。
2. **只驱动你自己的账号。** 只读取**你自己机器上已登录**的那个账号、消耗它自身的配额；
   **不要**拿它做多账号池化、代他人调用或任何转售 / 托管。
3. **别绑 \`0.0.0.0\`。** 那等于把订阅额度暴露给整个局域网。项目全程只绑 \`127.0.0.1\`。
4. **凭据不落盘。** 桥不内置、不缓存、不记录任何上游令牌明文；登录文件始终只读。
   但**本地回环令牌**会写进你客户端的配置文件（那是它的用途），所以同步设置里的
   备份目录权限会被收紧 —— 若看到「权限没能收紧」的警告，按提示手工处理。
5. **先确认你符合 WorkBuddy 的服务条款。** 若条款不允许，请不要使用。
6. **计费口径自行核对。** 桥不引入额外计费，经桥的调用与客户端里直接用消耗同一份额度；
   但两种路径是否按同一口径计入取决于上游，建议头几天对比控制台积分合计与客户端用量页。

排错先跑：\`node tools/doctor.mjs\`（会直接列出缺失项与修法）。
更多细节见 \`README.md\` 与 \`docs/TROUBLESHOOTING.md\`。
`;
}

// ── zip 写入（STORED + 可选 deflate，手写的最小实现） ─────────────────────

/** CRC32（zip 规范要求；zlib 不导出它）。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 极简 zip writer。
 *
 * Windows 上解压必须能正确还原中文文件名（`启动.cmd`），所以统一写 UTF-8
 * 并把「language encoding flag」置位（bit 11）—— 不置位的话资源管理器会按
 * 本地代码页解释，中文名会变乱码。
 */
class Zip {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
  }

  add(name, data) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    // 只有真能压小才用 deflate（小文件加了头反而更大）
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);              // time
    local.writeUInt16LE(0x21, 12);           // date（1980-01-01，容器无关紧要）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    this.parts.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);                // extra len
    cen.writeUInt16LE(0, 32);                // comment len
    cen.writeUInt16LE(0, 34);                // disk
    cen.writeUInt16LE(0, 36);                // internal attrs
    cen.writeUInt32LE(0, 38);                // external attrs
    cen.writeUInt32LE(this.offset, 42);
    this.central.push(cen, nameBuf);

    this.offset += local.length + nameBuf.length + body.length;
    return data.length;
  }

  finish() {
    const centralBuf = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.central.length / 2, 8);
    end.writeUInt16LE(this.central.length / 2, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...this.parts, centralBuf, end]);
  }
}

// ── 收集文件 ─────────────────────────────────────────────────────────────

/** 收集要进包的文件；跳过的运行时痕迹单独记账。 */
function walk(abs, rel, out, skipped) {
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      // 这些目录里全是本机运行痕迹 / 依赖，永远不进包
      if (['node_modules', '.git', 'dist', '.backup'].includes(name)) continue;
      walk(join(abs, name), childRel, out, skipped);
    }
    return;
  }
  /*
   * 本机运行痕迹：**跳过而不是报错**。
   *
   * 报错看着更严格，实际会挡住所有人 —— 只要本机跑过一次桥，`bridge/bridge.log`
   * 与 `usage.jsonl` 就必然存在，于是"永远打不出包"。而白名单已经保证它们
   * 不可能被打进去（INCLUDE 里没有它们，有的话这里也不会放行）。所以这里是
   * **过滤 + 如实记账**：证明敏感文件被看见了、且被明确排除。
   */
  if (NEVER.includes(rel.split('/').pop())) {
    skipped.push(rel);
    return;
  }
  out.push({ rel, abs });
}

function main() {
  // START-HERE.md 是**生成**的，先写进仓库根（.gitignore 里没有它，因为它
  // 确实是给使用者看的正式文档；同时它也在 INCLUDE 里，保证进包）。
  writeFileSync(join(ROOT, 'START-HERE.md'), startHere(), 'utf8');

  const files = [];
  const skipped = [];
  for (const item of INCLUDE) {
    const abs = join(ROOT, item);
    if (!existsSync(abs)) throw new Error(`打包清单里的路径不存在：${item}`);
    walk(abs, item, files, skipped);
  }

  const zip = new Zip();
  let total = 0;
  for (const f of files) {
    const data = readFileSync(f.abs);
    total += zip.add(`${PKG_NAME}/${f.rel}`, data);
  }

  /*
   * 关键路径的存在性断言。
   *
   * 「白名单少写一项」这件事**不会报任何错** —— 它只会安静地让包少点东西，
   * 而同事要到用的时候才发现（实测：漏了 `dsh-plugin`，包内该目录条目数为 0）。
   * 所以把「少了就说明打包错了」的路径钉下来，让打包自己失败。
   */
  const rels = new Set(files.map((f) => f.rel));
  const REQUIRED = [
    'START-HERE.md',
    '启动.cmd',
    'bridge/workbuddy-bridge.mjs',
    'dashboard/server.mjs',
    'dashboard/public/index.html',
    'lib/client-connect.mjs',
    'lib/find-kimi-code.mjs',
    'tools/connect.mjs',
    'dsh-plugin/lib/index.js',
    'dsh-plugin/vendor/bridge/workbuddy-bridge.mjs',
    'package.json',
    'README.md',
  ];
  const missing = REQUIRED.filter((r) => !rels.has(r));
  if (missing.length) {
    throw new Error('包里缺少关键路径：\n  · ' + missing.join('\n  · ')
      + '\n（多半是 INCLUDE 清单漏了某条，或对应文件被改名/移动）');
  }

  const buf = zip.finish();

  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${PKG_NAME}.zip`);
  writeFileSync(out, buf);

  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(`已打包 ${files.length} 个文件 → ${relative(ROOT, out).split(sep).join('/')}`);
  console.log(`  原始大小 ${(total / 1024 / 1024).toFixed(1)} MB，zip ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  sha256   ${sha}`);
  if (skipped.length) {
    console.log(`  已排除本机运行痕迹 ${skipped.length} 个：${skipped.join(', ')}`);
  }
  console.log('');
  console.log('同事拿到后：解压 → 双击 启动.cmd → npm run connect apply kimi-code');
  console.log('（详见包内 START-HERE.md）');
}

main();
