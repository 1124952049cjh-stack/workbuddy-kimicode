# 从这里开始（workbuddy-to-kimicode v1.5.1）

把 WorkBuddy 桌面端已登录的模型额度，经一个本机桥接到 **Kimi Code**（以及 Claude Code /
Codex / opencode 等任意 OpenAI 兼容客户端）。**只在本机回环地址上工作，不对外暴露。**

---

## 一、前置条件（三件）

| 条件 | 怎么确认 |
|---|---|
| Node.js 18+ | `node -v` |
| WorkBuddy 桌面端**已安装且已登录** | 打开它，能正常对话即可 |
| Kimi Code CLI | `kimi --version`（要接 Claude Code 等则换成对应客户端） |

**不需要 `npm install`** —— 本项目零运行时依赖，解压即可用。

---

## 二、跑起来（两行命令）

```cmd
:: 1) 双击 启动.cmd —— 桥 + 网页控制台一起起来，浏览器自动打开 http://127.0.0.1:8792
::    窗口留着别关；关掉窗口桥会继续在后台跑，下次启动直接复用。

:: 2) 接入 Kimi Code（在该目录里）
npm run connect apply kimi-code
```

第 2 步会：把 `[providers.workbuddy]` 与各 `[models."workbuddy/<id>"]` 写进
`~/.kimi-code/config.toml` → **先整份备份** → 收紧文件权限 → 静态读回 →
拿刚写进去的令牌**真打一次桥**验证，最后直接告诉你下一步敲什么。

> **它不会改你的 `default_model`**，也不会碰你已有的任何 provider / 模型 / 注释。

---

## 三、用起来

```cmd
kimi -m "workbuddy/glm-5.3"     :: 直接用某个 WorkBuddy 模型
kimi                            :: 然后在会话里 /model 选 workbuddy/...
```

想默认走桥，就自己把 `~/.kimi-code/config.toml` 顶部的 `default_model` 改成
`"workbuddy/glm-5.3"`。

**如果启动时报 `provider managed:kimi-code has no credential configured`**：
那是 Kimi Code 在检查你的**默认模型**有没有凭据（新机器上从没 `/login` 过就是这样），
与桥无关。两条路任选：先在 kimi 里 `/login` 一次，或把 `default_model` 指到
`workbuddy/glm-5.3`。

---

## 四、想换模型 / 想反悔

```cmd
npm run connect status                              :: 看现状与将要改什么
npm run connect apply kimi-code --models glm-5.3,deepseek-v4.1-flash,deepseek-v4-pro
npm run connect native kimi-code                    :: 暂时切回你自己的模型（配置留着）
npm run connect bridge kimi-code                    :: 再切回走桥
npm run connect undo kimi-code                      :: 彻底拆掉，config.toml 逐字节还原
npm run connect verify kimi-code                    :: 静态读回 + 端到端验证
```

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
3. **别绑 `0.0.0.0`。** 那等于把订阅额度暴露给整个局域网。项目全程只绑 `127.0.0.1`。
4. **凭据不落盘。** 桥不内置、不缓存、不记录任何上游令牌明文；登录文件始终只读。
   但**本地回环令牌**会写进你客户端的配置文件（那是它的用途），所以同步设置里的
   备份目录权限会被收紧 —— 若看到「权限没能收紧」的警告，按提示手工处理。
5. **先确认你符合 WorkBuddy 的服务条款。** 若条款不允许，请不要使用。
6. **计费口径自行核对。** 桥不引入额外计费，经桥的调用与客户端里直接用消耗同一份额度；
   但两种路径是否按同一口径计入取决于上游，建议头几天对比控制台积分合计与客户端用量页。

排错先跑：`node tools/doctor.mjs`（会直接列出缺失项与修法）。
更多细节见 `README.md` 与 `docs/TROUBLESHOOTING.md`。
