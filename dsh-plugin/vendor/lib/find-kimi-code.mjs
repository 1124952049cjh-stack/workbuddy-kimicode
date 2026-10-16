/**
 * Kimi Code 配置文件定位 —— 「装在哪都能找到」。
 *
 * 探测顺序（廉价 → 昂贵）：
 *   1. WORKBUDDY_KIMI_CODE_CONFIG —— 显式覆盖，最高优先级（测试与运维均可用）
 *   2. $KIMI_CODE_HOME/config.toml —— Kimi Code 官方支持的重定位变量
 *   3. ~/.kimi-code/config.toml —— 默认安装路径
 *
 * 「装没装」看**目录**在不在（`kimiCodeDir()` 返回的那个），而不是配置文件在不在
 * —— 用户可能还没生成配置文件，但安装目录已经存在。
 *
 * 导出 `kimiCodeDir()` 和 `kimiCodeConfigPath()` 两个函数，均在**调用时**算，
 * 不在模块加载时固化为常量 —— 测试与脚本可以先 import 再设 env，最自然的写法。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME_FALLBACK = homedir();
const homeDir = () => process.env.USERPROFILE || process.env.HOME || HOME_FALLBACK;

/**
 * Kimi Code 的配置目录。
 *
 * `KIMI_CODE_HOME` 是官方约定的重定位变量（与 Codex 的 `CODEX_HOME` 同一套语义）。
 * 空白值不当路径（`KIMI_CODE_HOME="   "` 会拼出一个叫 "   " 的目录）。
 */
export function kimiCodeDir() {
  const fromEnv = process.env.KIMI_CODE_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(homeDir(), '.kimi-code');
}

/**
 * Kimi Code 配置文件的实际路径。
 *
 * 优先级：
 *   1. `WORKBUDDY_KIMI_CODE_CONFIG`（我们自己的显式覆盖，用于测试与运维隔离）
 *   2. `KIMI_CODE_HOME/config.toml`（官方重定位变量）
 *   3. `~/.kimi-code/config.toml`（默认安装路径）
 */
export function kimiCodeConfigPath() {
  const override = process.env.WORKBUDDY_KIMI_CODE_CONFIG;
  if (override && override.trim()) return override.trim();
  return join(kimiCodeDir(), 'config.toml');
}

/**
 * 「装没装」Kimi Code —— 看**目录**在不在，而不是配置文件。
 * 与其他客户端的 `clientInstalled()` 判据一致。
 */
export function kimiCodeInstalled() {
  return existsSync(kimiCodeDir());
}
