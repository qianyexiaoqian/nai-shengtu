import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { HttpError, bearerToken } from './http.js';

const PUBLIC_COLUMNS =
  'id, name, key_hint, enabled, quota_images, ai_optimize, used_images, used_points, created_at, last_used_at';

const hashKey = (key) => createHash('sha256').update(key).digest('hex');

/** 生成本中继的调用秘钥；完整秘钥只在这里返回一次，库里只存哈希 */
export function createKey({ name, quota_images: quota = 0, ai_optimize: ai = true } = {}) {
  const key = `sk-${randomBytes(24).toString('base64url')}`;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO api_keys (name, key_hash, key_hint, quota_images, ai_optimize, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(keyName(name), hashKey(key), `${key.slice(0, 7)}…${key.slice(-4)}`, quotaValue(quota), ai ? 1 : 0, Date.now());
  return { ...getKey(Number(lastInsertRowid)), key };
}

/** 这把调用密钥能不能用 AI 提示词优化（后台的总开关、生效模型另算） */
export const keyAllowsAi = (row) => row?.ai_optimize !== 0;

export function listKeys() {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY id DESC`).all();
}

export function updateKey(id, patch) {
  const sets = [];
  const args = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    args.push(keyName(patch.name));
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
  }
  if (patch.quota_images !== undefined) {
    sets.push('quota_images = ?');
    args.push(quotaValue(patch.quota_images));
  }
  if (patch.ai_optimize !== undefined) {
    sets.push('ai_optimize = ?');
    args.push(patch.ai_optimize ? 1 : 0);
  }
  if (!sets.length) throw new HttpError(400, '没有要修改的字段');
  const { changes } = db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  if (!changes) throw new HttpError(404, '秘钥不存在');
  return getKey(id);
}

export function deleteKey(id) {
  const { changes } = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  if (!changes) throw new HttpError(404, '秘钥不存在');
  return { deleted: id };
}

/** 校验调用方的 Bearer sk-...，返回秘钥记录 */
export function authenticate(req) {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(bearerToken(req)));
  if (!row) throw new HttpError(401, 'API Key 无效', { type: 'authentication_error', code: 'invalid_api_key' });
  if (!row.enabled) throw new HttpError(401, 'API Key 已被禁用', { type: 'authentication_error', code: 'key_disabled' });
  return row;
}

export function assertQuota(row, images) {
  if (row.quota_images > 0 && row.used_images + images > row.quota_images) {
    throw new HttpError(429, `额度不足：已用 ${row.used_images} / ${row.quota_images} 张`, {
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    });
  }
}

function getKey(id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE id = ?`).get(id);
}

function keyName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 50) throw new HttpError(400, '名称不能为空，且不超过 50 个字');
  return name;
}

function quotaValue(value) {
  const quota = Number(value);
  if (!Number.isInteger(quota) || quota < 0) throw new HttpError(400, '额度必须是不小于 0 的整数（0 表示不限）');
  return quota;
}
