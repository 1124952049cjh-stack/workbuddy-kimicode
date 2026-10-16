/**
 * find-kimi-code 的单元测试。
 *
 *   node --test lib/find-kimi-code.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kimiCodeConfigPath, kimiCodeDir, kimiCodeInstalled } from './find-kimi-code.mjs';

const setEnv = (key, value) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
};

test('kimiCodeDir：KIMI_CODE_HOME 存在时跟它走，否则回落到 ~/.kimi-code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kc-find-'));
  try {
    const restoreKCH = setEnv('KIMI_CODE_HOME', join(dir, 'custom'));
    const restoreHP = setEnv('USERPROFILE', dir);
    const restoreHH = setEnv('HOME', dir);
    try {
      assert.equal(kimiCodeDir(), join(dir, 'custom'), 'KIMI_CODE_HOME 应生效');
      restoreKCH();
      delete process.env.KIMI_CODE_HOME;
      assert.equal(kimiCodeDir(), join(dir, '.kimi-code'), '未设 KIMI_CODE_HOME 时回落到家目录');
    } finally {
      restoreKCH(); restoreHP(); restoreHH();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kimiCodeDir：空白值不当路径（避免拼出 "   " 这样的目录名）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kc-blank-'));
  try {
    const rHP = setEnv('USERPROFILE', dir);
    const rHH = setEnv('HOME', dir);
    const rKCH = setEnv('KIMI_CODE_HOME', '   ');
    try {
      assert.equal(kimiCodeDir(), join(dir, '.kimi-code'), '空白 KIMI_CODE_HOME 应忽略');
    } finally { rHP(); rHH(); rKCH(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kimiCodeConfigPath：WORKBUDDY_KIMI_CODE_CONFIG 最优先，其次 KIMI_CODE_HOME，最后默认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kc-path-'));
  try {
    const rHP = setEnv('USERPROFILE', dir);
    const rHH = setEnv('HOME', dir);
    const explicit = join(dir, 'explicit', 'config.toml');
    try {
      // 1. 我们自己的显式覆盖最优先
      const rWKC = setEnv('WORKBUDDY_KIMI_CODE_CONFIG', explicit);
      assert.equal(kimiCodeConfigPath(), explicit);
      rWKC();

      // 2. KIMI_CODE_HOME 优先于默认
      const rKCH = setEnv('KIMI_CODE_HOME', join(dir, 'custom'));
      assert.equal(kimiCodeConfigPath(), join(dir, 'custom', 'config.toml'));
      rKCH();

      // 3. 默认
      delete process.env.KIMI_CODE_HOME;
      assert.equal(kimiCodeConfigPath(), join(dir, '.kimi-code', 'config.toml'));
    } finally { rHP(); rHH(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kimiCodeInstalled：目录存在则 true，不存在则 false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kc-inst-'));
  try {
    const rHP = setEnv('USERPROFILE', dir);
    const rHH = setEnv('HOME', dir);
    try {
      delete process.env.KIMI_CODE_HOME;
      assert.equal(kimiCodeInstalled(), false, '目录不存在时应返回 false');
      mkdirSync(join(dir, '.kimi-code'), { recursive: true });
      assert.equal(kimiCodeInstalled(), true, '目录存在时应返回 true');
    } finally { rHP(); rHH(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
