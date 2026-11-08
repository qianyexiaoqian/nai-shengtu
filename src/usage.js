import { db, transaction } from './db.js';
import { getSettings } from './settings.js';

const DAY_MS = 86_400_000;
const LARGE_PIXELS = 1024 * 1024;

/** 北京时间日期；上游的每日分档计数按北京时间零点重置 */
export function beijingDay(ms = Date.now()) {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 同一代模型共用每日计数：nai-diffusion-5-full / -curated → nai-diffusion-5 */
export function modelFamily(upstream) {
  return String(upstream).replace(/-(?:full|curated(?:-preview)?)$/, '');
}

export function isLargeSize(size) {
  const [w, h] = String(size || '1024x1024').split('x').map(Number);
  return w * h > LARGE_PIXELS;
}

/**
 * 按模型计价规则估算这次上游扣了多少点。usedToday 是同代模型今天已成功出的张数，
 * 批量出图时逐张计算，跨过分档线的那几张按涨价后的价格算。
 */
export function estimatePoints(model, images, size, usedToday) {
  const large = isLargeSize(size);
  let points = 0;
  for (let i = 1; i <= images; i++) {
    points += model.tier_after > 0 && usedToday + i > model.tier_after ? model.tier_price : model.price;
    if (large) points += model.large_extra;
  }
  return points;
}

/**
 * 记一次上游调用，同时累加调用密钥的用量；返回日志 id 和估算点数。
 * 上游的每日分档按“上游账号 + 同代模型”计数（网站和该账号所有 sk 合并），account 由上游秘钥决定。
 */
export function recordCall({
  key, endpoint, model, prompt, finalPrompt = null, size, n, images = 0, status, error = null, durationMs, ip,
  upstreamKeyId = null, account = null, queueMs = 0, adjusted = null, anlas = null,
}) {
  const now = Date.now();
  const day = beijingDay(now);
  const family = modelFamily(model.upstream);
  return transaction(() => {
    let points = 0;
    if (status === 'success' && images > 0) {
      const { used } = db
        .prepare(`SELECT COALESCE(SUM(images), 0) AS used FROM logs
                  WHERE day = ? AND account = ? AND family = ? AND status = 'success'`)
        .get(day, account, family);
      points = estimatePoints(model, images, size, used);
    }
    const { lastInsertRowid } = db
      .prepare(`
        INSERT INTO logs (created_at, day, key_id, key_name, endpoint, model, upstream_model, family, prompt, final_prompt,
                          size, n, images, points, status, error, duration_ms, ip, upstream_key_id, account, queue_ms,
                          adjusted, anlas)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        now, day, key.id, key.name, endpoint, model.id, model.upstream, family, String(prompt).slice(0, 2000),
        finalPrompt && finalPrompt !== prompt ? String(finalPrompt).slice(0, 2000) : null,
        size, n, images, points, status, error, durationMs, ip, upstreamKeyId, account, Math.round(queueMs ?? 0),
        adjusted, anlas,
      );
    db.prepare('UPDATE api_keys SET used_images = used_images + ?, used_points = used_points + ?, last_used_at = ? WHERE id = ?')
      .run(images, points, now, key.id);
    return { logId: Number(lastInsertRowid), points };
  });
}

const aggregate = (t = '') => `
  COUNT(*) AS calls,
  COALESCE(SUM(${t}status = 'success'), 0) AS success,
  COALESCE(SUM(${t}images), 0) AS images,
  COALESCE(SUM(${t}points), 0) AS points,
  COALESCE(SUM(${t}anlas), 0) AS anlas`;

/** 某天（不传就是全部）的 AI 提示词优化用量和成本 */
export function aiSummary(day) {
  return db
    .prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(status = 'success'), 0) AS success, COALESCE(SUM(cost), 0) AS cost,
             COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
      FROM ai_calls ${day ? 'WHERE day = ?' : ''}`)
    .get(...(day ? [day] : []));
}

/** 近 14 天：生图（调用、出图、扣点）和 AI 优化（次数、成本）按天合并 */
function dailyStats() {
  const since = beijingDay(Date.now() - 13 * DAY_MS);
  const days = new Map();
  for (const row of db.prepare(`SELECT day, ${aggregate()} FROM logs WHERE day >= ? GROUP BY day`).all(since)) {
    days.set(row.day, { ...row, ai_calls: 0, ai_cost: 0 });
  }
  for (const row of db
    .prepare('SELECT day, COUNT(*) AS ai_calls, COALESCE(SUM(cost), 0) AS ai_cost FROM ai_calls WHERE day >= ? GROUP BY day')
    .all(since)) {
    days.set(row.day, { calls: 0, success: 0, images: 0, points: 0, anlas: 0, ...days.get(row.day), ...row });
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** 按调用密钥：生图统计 + AI 优化成本（只在提词器里用过 AI、没生过图的密钥也列出来） */
function keyStats(today) {
  const rows = db
    .prepare(`SELECT l.key_id, COALESCE(k.name, MAX(l.key_name)) AS name, k.id IS NULL AS deleted, ${aggregate('l.')},
                COALESCE(SUM(CASE WHEN l.day = ? THEN l.images END), 0) AS today_images,
                COALESCE(SUM(CASE WHEN l.day = ? THEN l.points END), 0) AS today_points
              FROM logs l LEFT JOIN api_keys k ON k.id = l.key_id
              GROUP BY l.key_id`)
    .all(today, today)
    .map((r) => ({ ...r, ai_calls: 0, ai_cost: 0 }));
  const byId = new Map(rows.map((r) => [r.key_id, r]));
  for (const ai of db
    .prepare(`SELECT a.key_id, COALESCE(k.name, MAX(a.key_name)) AS name, k.id IS NULL AS deleted,
                     COUNT(*) AS ai_calls, COALESCE(SUM(a.cost), 0) AS ai_cost
              FROM ai_calls a LEFT JOIN api_keys k ON k.id = a.key_id
              WHERE a.key_id IS NOT NULL GROUP BY a.key_id`)
    .all()) {
    const row = byId.get(ai.key_id);
    if (row) Object.assign(row, { ai_calls: ai.ai_calls, ai_cost: ai.ai_cost });
    else rows.push({ ...ai, calls: 0, success: 0, images: 0, points: 0, anlas: 0, today_images: 0, today_points: 0 });
  }
  return rows.sort((a, b) => b.points - a.points || b.ai_cost - a.ai_cost);
}

export function getStats() {
  const today = beijingDay();
  return {
    today: db.prepare(`SELECT ${aggregate()} FROM logs WHERE day = ?`).get(today),
    total: db.prepare(`SELECT ${aggregate()} FROM logs`).get(),
    ai: { today: aiSummary(today), total: aiSummary() },
    daily: dailyStats(),
    // 今天每个上游账号各代模型已出张数，对照分档线（如 NAI5 每账号每天前 300 张便宜）
    todayFamilies: db
      .prepare(`SELECT l.account, l.family, COALESCE(SUM(l.images), 0) AS images,
                       MAX(CASE WHEN l.account LIKE '#%' THEN COALESCE(NULLIF(u.name, ''), '上游秘钥 ' || l.account)
                                ELSE l.account END) AS account_label
                FROM logs l LEFT JOIN upstream_keys u ON u.id = l.upstream_key_id
                WHERE l.day = ? AND l.status = 'success' AND l.account IS NOT NULL
                GROUP BY l.account, l.family ORDER BY images DESC`)
      .all(today),
    byModel: db
      .prepare(`SELECT model, ${aggregate()},
                  COALESCE(SUM(CASE WHEN day = ? THEN images END), 0) AS today_images,
                  COALESCE(SUM(CASE WHEN day = ? THEN points END), 0) AS today_points
                FROM logs GROUP BY model ORDER BY points DESC`)
      .all(today, today),
    byKey: keyStats(today),
    byUpstreamKey: db
      .prepare(`SELECT l.upstream_key_id, COALESCE(NULLIF(u.name, ''), '上游秘钥 #' || l.upstream_key_id) AS name,
                       u.id IS NULL AS deleted, ${aggregate('l.')},
                  COALESCE(SUM(CASE WHEN l.day = ? THEN l.images END), 0) AS today_images,
                  COALESCE(SUM(CASE WHEN l.day = ? THEN l.points END), 0) AS today_points
                FROM logs l LEFT JOIN upstream_keys u ON u.id = l.upstream_key_id
                WHERE l.upstream_key_id IS NOT NULL
                GROUP BY l.upstream_key_id ORDER BY points DESC`)
      .all(today, today),
    pointPrice: getSettings().pointPrice,
  };
}

export function listLogs({ page = 1, pageSize = 20, keyId, status } = {}) {
  const where = [];
  const args = [];
  if (keyId) {
    where.push('l.key_id = ?');
    args.push(keyId);
  }
  if (status) {
    where.push('l.status = ?');
    args.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM logs l ${clause}`).get(...args);
  // 密钥改过名的显示新名字，删掉的显示记录时的名字
  const items = db
    .prepare(`SELECT l.id, l.created_at, l.key_id, COALESCE(k.name, l.key_name) AS key_name, l.endpoint, l.model,
                     l.upstream_model, l.prompt, l.final_prompt, l.size, l.n, l.images, l.points, l.status, l.error,
                     l.duration_ms, l.queue_ms, l.adjusted, l.anlas, l.ip,
                     COALESCE(NULLIF(u.name, ''), '#' || l.upstream_key_id) AS upstream_key_name,
                     a.model AS ai_model, a.input_tokens AS ai_input_tokens, a.output_tokens AS ai_output_tokens,
                     a.cost AS ai_cost
              FROM logs l
              LEFT JOIN api_keys k ON k.id = l.key_id
              LEFT JOIN upstream_keys u ON u.id = l.upstream_key_id
              LEFT JOIN ai_calls a ON a.log_id = l.id
              ${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  return { total, page, pageSize, items };
}
