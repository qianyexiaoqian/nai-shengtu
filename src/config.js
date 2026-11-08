import { resolve } from 'node:path';

const env = process.env;

// 启动级配置走环境变量；上游地址、上游秘钥、计价等运行时配置在后台“设置”里改，存数据库（见 settings.js）
export const config = {
  host: env.HOST || '0.0.0.0',
  port: Number(env.PORT) || 3000,
  // 数据库所在目录；测试时可设为 :memory:
  dataDir: env.DATA_DIR === ':memory:' ? ':memory:' : resolve(env.DATA_DIR || 'data'),
  // 设置后每次启动都把后台密码重置成它；不设则沿用后台里改过的密码，首次启动随机生成并打印到控制台
  adminPassword: env.ADMIN_PASSWORD || '',
  // 上游生成包含排队时间，文档建议不少于 180 秒
  timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS) || 300_000,
};
