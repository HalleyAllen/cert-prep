import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Problem, publicLink, validated } from './services.mjs';

const keyInput = z.string().trim().min(1, '请输入密钥。').max(4096)
  .regex(/^[!-~]+$/, '密钥不能包含空格或换行。').nullable().optional();
const settingsInput = z.strictObject({
  aiBaseUrl: z.string().trim().max(2048).refine((value) => {
    if (!value) return true;
    const link = publicLink(value);
    return !!link && !/[?#]/.test(link);
  }, '请输入服务商提供的 HTTP 或 HTTPS 基础地址，地址中不要带查询参数。').optional(),
  aiModel: z.string().trim().max(300).optional(),
  aiKey: keyInput,
  tavilyKey: keyInput,
});

const envNames = {
  aiBaseUrl: 'AI_BASE_URL', aiModel: 'AI_MODEL', aiKey: 'AI_API_KEY', tavilyKey: 'TAVILY_API_KEY',
};

export function createServiceSettings(root, defaults = process.env) {
  const file = join(root, 'service-settings.json');
  const env = { ...defaults };
  let overrides = {};
  try {
    overrides = settingsInput.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('无法读取本机服务配置，已使用启动配置。');
  }
  function apply(values) {
    for (const [name, value] of Object.entries(values)) env[envNames[name]] = value ?? '';
  }
  apply(overrides);

  return {
    env,
    read() {
      const link = publicLink(env.AI_BASE_URL);
      const url = link && new URL(link);
      return {
        aiBaseUrl: url ? url.origin + url.pathname : '',
        aiModel: env.AI_MODEL?.trim() || '',
        hasAiKey: Boolean(env.AI_API_KEY?.trim()),
        hasTavilyKey: Boolean(env.TAVILY_API_KEY?.trim()),
      };
    },
    save(input) {
      const updates = validated(settingsInput, input);
      if (!Object.keys(updates).length) return;
      const next = { ...overrides, ...updates };
      const temp = join(root, '.service-settings-' + randomUUID() + '.tmp');
      try {
        writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(temp, file);
      } catch {
        try { rmSync(temp, { force: true }); } catch { /* Keep the original save error. */ }
        throw new Problem(500, '无法保存服务配置。请检查本机数据目录的写入权限后重试。');
      }
      overrides = next;
      apply(updates);
    },
  };
}
