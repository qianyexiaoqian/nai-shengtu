import { db } from './db.js';
import { novelaiAccount, novelaiFamily } from './novelai.js';
import { dispatch } from './queue.js';
import { liveAccount, saveAccount, savedAccount } from './upstreamKeys.js';

// 官方秘钥的账号状态（套餐、Anlas 余额、Opus 用量条）：启动时、每 5 分钟、出过图之后查一次 /user/subscription，
// 存在秘钥上。“只出免费图”靠它判断这次要不要花 Anlas。查失败的 20 秒后再试，直到查成功。
//
// NAI5 的免费额度（用量条）是一张张扣的，扣完之后每张都收 Anlas。所以“只出免费图”的秘钥出 NAI5 前，
// 手上的查询结果得够新（见 needsFreshBar 和 upstream.js）：一分钟内查的，而且用量条还剩不少（≥5%，大约 80 多张）
// 或者是这把秘钥上一张 NAI5 出完之后才发出去的；不够新就先查一次再决定。
const REFRESH_MS = 5 * 60_000;
const AFTER_USE_MS = 30_000;
const RETRY_MS = 20_000;
const BAR_TRUST_PERCENT = 5;
const BAR_TRUST_MS = 60_000;
const inflight = new Map(); // 秘钥 id → { startedAt, base, run } 正在查的
const scheduled = new Set(); // 已经排了“出图后再查”的秘钥 id
const retrying = new Set(); // 查失败、已经排了重试的秘钥 id
const barUsedAt = new Map(); // 秘钥 id → 上一张 NAI5 出完的时间（只在内存里）
let started = false; // 后台定时查、出图后查、失败重试只在服务启动后跑（startAccountRefresh），测试里不会偷偷联网

/** 用这把令牌查账号；接口地址就是出图用的地址（官方的 image.novelai.net 和反代都有 /user/subscription） */
export async function fetchNovelaiAccount(baseUrl, key) {
  const res = await fetch(`${baseUrl}/user/subscription`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}${body?.message ? `：${body.message}` : ''}`);
  // 反代把别的页面当 200 回来时，别当成“查到了一个免费账号”存下去
  if (typeof body?.tier !== 'number') throw new Error('返回的不是订阅信息');
  return novelaiAccount(body);
}

/**
 * 查一把官方秘钥并存下来，返回存下的账号状态（失败时是上次的状态加上错误）。
 * 同一把正在查、而且是 after 之后发出去的查询，就等它；否则另发一次（换了接口地址的也另发）。
 */
export function refreshAccount(row, { after = 0 } = {}) {
  const current = inflight.get(row.id);
  if (current && current.startedAt > after && current.base === row.base_url) return current.run;
  const startedAt = Math.max(Date.now(), after + 1);
  const run = fetchNovelaiAccount(row.base_url, row.key)
    .then(
      (account) => saveAccount(row.id, account, null, startedAt),
      (err) => saveAccount(row.id, null, err.cause?.message || err.message, startedAt),
    )
    .then((saved) => {
      if (saved && !saved.error) dispatch(); // 账号状态变了，排队的请求可能又能发了
      else retryLater(row.id);
      return saved;
    })
    .finally(() => {
      if (inflight.get(row.id)?.run === run) inflight.delete(row.id);
    });
  inflight.set(row.id, { startedAt, base: row.base_url, run });
  return run;
}

const officialKey = (id) => db.prepare("SELECT * FROM upstream_keys WHERE id = ? AND type = 'novelai' AND enabled = 1").get(id);
const officialKeys = (onlyUnchecked) =>
  db.prepare("SELECT * FROM upstream_keys WHERE type = 'novelai' AND enabled = 1").all()
    .filter((row) => !onlyUnchecked || !savedAccount(row)?.checked_at);

/** 查所有启用的官方秘钥；onlyUnchecked 时只查还没查成功过的 */
export function refreshAllAccounts({ onlyUnchecked = false } = {}) {
  return Promise.all(officialKeys(onlyUnchecked).map((row) => refreshAccount(row)));
}

export function startAccountRefresh() {
  started = true;
  refreshAllAccounts().catch(() => {});
  setInterval(() => refreshAllAccounts().catch(() => {}), REFRESH_MS).unref();
}

/** 查失败了 20 秒后再查（秘钥停用、删掉、改成别的类型就不查了） */
function retryLater(id) {
  if (!started || retrying.has(id)) return;
  retrying.add(id);
  setTimeout(() => {
    retrying.delete(id);
    const row = officialKey(id);
    if (row && !liveAccount(row)) refreshAccount(row).catch(() => {});
  }, RETRY_MS).unref();
}

/** 官方秘钥刚出过图：Anlas、用量条可能变了，过两秒再查一次给后台看（同一把 30 秒内查过就不查） */
export function noteAccountUsed(row) {
  if (!started || row.type !== 'novelai' || scheduled.has(row.id)) return;
  const checkedAt = savedAccount(row)?.checked_at ?? 0;
  const wait = Math.max(2_000, checkedAt + AFTER_USE_MS - Date.now());
  scheduled.add(row.id);
  setTimeout(() => {
    scheduled.delete(row.id);
    const current = officialKey(row.id);
    if (current) refreshAccount(current).catch(() => {});
  }, wait).unref();
}

/** 官方秘钥出完（或试过）一张 NAI5：用量条可能扣没了，在这之前的查询结果不能再拿来判断“免费” */
export function markBarUsed(row, model) {
  if (row.type === 'novelai' && novelaiFamily(model) === 'v5') barUsedAt.set(row.id, Date.now());
}

/** 上一张 NAI5 出完的时间，refreshAccount 的 after 用它 */
export const barUsedSince = (row) => barUsedAt.get(row.id) ?? 0;

/**
 * 这次出 NAI5 之前要不要先查一下账号（只管“只出免费图”的官方秘钥）：
 * 查询超过一分钟的要重查（账号主人可能在网页上也在用）；一分钟内的，用量条还剩 5% 以上、
 * 或者查询是这把秘钥上一张 NAI5 出完之后发出的，才不用查。
 */
export function needsFreshBar(row, model, now = Date.now()) {
  if (row.type !== 'novelai' || !row.free_only || novelaiFamily(model) !== 'v5') return false;
  const account = liveAccount(row, now);
  if (!account) return false; // 不知道账号状态的，planFor 已经不接了
  if (now - account.started_at > BAR_TRUST_MS) return true;
  const left = (account.usage_percent ?? 0) + (account.extra_percent ?? 0);
  return !(left >= BAR_TRUST_PERCENT || account.started_at > barUsedSince(row));
}
