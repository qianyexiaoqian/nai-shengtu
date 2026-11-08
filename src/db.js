import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const file = config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'relay.db');
if (file !== ':memory:') mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS settings (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 本中继发给调用方的 sk，只存哈希，完整秘钥只在创建时显示一次
  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    key_hash     TEXT    NOT NULL UNIQUE,
    key_hint     TEXT    NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    quota_images INTEGER NOT NULL DEFAULT 0,  -- 0 = 不限
    used_images  INTEGER NOT NULL DEFAULT 0,
    used_points  REAL    NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );

  -- 对外模型名 → 上游模型，附带上游计价规则（用来估算上游扣点）
  CREATE TABLE IF NOT EXISTS models (
    id          TEXT    PRIMARY KEY,
    upstream    TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    price       REAL    NOT NULL DEFAULT 0,  -- 每张基础点数
    tier_after  INTEGER NOT NULL DEFAULT 0,  -- 每天第几张之后涨价，0 = 不分档
    tier_price  REAL    NOT NULL DEFAULT 0,  -- 涨价后每张点数
    large_extra REAL    NOT NULL DEFAULT 0,  -- 大图（总像素超过 1024×1024）每张加点
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     INTEGER NOT NULL,
    day            TEXT    NOT NULL,  -- 北京时间日期，上游按北京时间零点重置每日计数
    key_id         INTEGER,
    key_name       TEXT,
    endpoint       TEXT    NOT NULL,  -- chat / images / novelai
    model          TEXT,
    upstream_model TEXT,
    family         TEXT,              -- 同一代模型共用每日分档计数，如 nai-diffusion-5
    prompt         TEXT,
    size           TEXT,
    n              INTEGER,
    images         INTEGER NOT NULL DEFAULT 0,
    points         REAL    NOT NULL DEFAULT 0,
    status         TEXT    NOT NULL,  -- success / error
    error          TEXT,
    duration_ms    INTEGER,
    ip             TEXT
  );

  -- 上游秘钥，可配多把轮询。调上游要用原文，只能存明文；后台只显示打码后的样子
  CREATE TABLE IF NOT EXISTS upstream_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL DEFAULT '',
    key           TEXT    NOT NULL UNIQUE,
    account       TEXT    NOT NULL DEFAULT '',  -- 同一上游账号的秘钥填同一个名字，每日分档合并计数；空 = 单独计
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    last_error    TEXT,
    last_error_at INTEGER
  );

  -- AI 提示词优化的每次调用：用量和按后台价格算出的成本（元）。生图时的调用回填 log_id
  CREATE TABLE IF NOT EXISTS ai_calls (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at         INTEGER NOT NULL,
    day                TEXT    NOT NULL,
    source             TEXT    NOT NULL,  -- chat / images / prompt（提词器）/ test（后台测试）
    log_id             INTEGER,
    key_id             INTEGER,
    key_name           TEXT,
    model              TEXT    NOT NULL,
    input_tokens       INTEGER NOT NULL DEFAULT 0,  -- 输入总数（OpenAI 口径，含缓存部分）
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cost               REAL    NOT NULL DEFAULT 0,
    status             TEXT    NOT NULL,  -- success / error
    error              TEXT,
    duration_ms        INTEGER,
    prompt             TEXT,
    result             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_calls_day ON ai_calls (day);
  CREATE INDEX IF NOT EXISTS idx_ai_calls_log ON ai_calls (log_id);

  -- 返回给客户端的图片链接：/v1/img/<uuid>.png → 上游真实地址，过期后删除
  CREATE TABLE IF NOT EXISTS images (
    id           TEXT    PRIMARY KEY,
    upstream_url TEXT    NOT NULL,
    log_id       INTEGER,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_images_expires ON images (expires_at);
`);

// 旧库补列：logs 记下用的是哪把上游秘钥、属于哪个上游账号（每日分档按账号计）
const logColumns = new Set(db.prepare('PRAGMA table_info(logs)').all().map((c) => c.name));
if (!logColumns.has('upstream_key_id')) db.exec('ALTER TABLE logs ADD COLUMN upstream_key_id INTEGER');
if (!logColumns.has('account')) db.exec('ALTER TABLE logs ADD COLUMN account TEXT');
// 提示词里的中文转成标签后实际发给上游的提示词；和原文一样时为空
if (!logColumns.has('final_prompt')) db.exec('ALTER TABLE logs ADD COLUMN final_prompt TEXT');

// 调用密钥能不能用 AI 提示词优化：0 = 不能（写 --ai 也不行），1 = 按后台的 AI 设置走
const keyColumns = new Set(db.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name));
if (!keyColumns.has('ai_optimize')) db.exec('ALTER TABLE api_keys ADD COLUMN ai_optimize INTEGER NOT NULL DEFAULT 1');

// 多上游：每把上游秘钥带自己的接口地址（OpenAI 格式，填到 /v1），可限定它支持哪些上游模型（空 = 全部）。
// 旧库里的秘钥接口地址为空，启动时由 seedUpstreamKeys() 补成 UPSTREAM_BASE
const upstreamColumns = new Set(db.prepare('PRAGMA table_info(upstream_keys)').all().map((c) => c.name));
if (!upstreamColumns.has('base_url')) db.exec("ALTER TABLE upstream_keys ADD COLUMN base_url TEXT NOT NULL DEFAULT ''");
if (!upstreamColumns.has('models')) db.exec("ALTER TABLE upstream_keys ADD COLUMN models TEXT NOT NULL DEFAULT ''");
// 上游类型：openai = OpenAI 兼容的 /images/generations；novelai = NovelAI 官方接口（/ai/generate-image）
if (!upstreamColumns.has('type')) db.exec("ALTER TABLE upstream_keys ADD COLUMN type TEXT NOT NULL DEFAULT 'openai'");

// 有的上游直接返回 b64_json 不给链接：图片存到数据目录，file 是文件名，mime 是类型
const imageColumns = new Set(db.prepare('PRAGMA table_info(images)').all().map((c) => c.name));
if (!imageColumns.has('file')) db.exec('ALTER TABLE images ADD COLUMN file TEXT');
if (!imageColumns.has('mime')) db.exec('ALTER TABLE images ADD COLUMN mime TEXT');

// AI 调用补列：请求了几轮、调了几次工具、备注（比如模型不支持工具调用、退回了普通方式）
const aiColumns = new Set(db.prepare('PRAGMA table_info(ai_calls)').all().map((c) => c.name));
if (!aiColumns.has('rounds')) db.exec('ALTER TABLE ai_calls ADD COLUMN rounds INTEGER NOT NULL DEFAULT 1');
if (!aiColumns.has('tool_calls')) db.exec('ALTER TABLE ai_calls ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0');
if (!aiColumns.has('note')) db.exec('ALTER TABLE ai_calls ADD COLUMN note TEXT');

db.exec(`
  DROP INDEX IF EXISTS idx_logs_day;
  CREATE INDEX IF NOT EXISTS idx_logs_tier ON logs (day, account, family);
  CREATE INDEX IF NOT EXISTS idx_logs_key ON logs (key_id);
  CREATE INDEX IF NOT EXISTS idx_logs_upstream_key ON logs (upstream_key_id);
`);

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
