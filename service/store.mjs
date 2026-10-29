import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
export const PROTOCOL = 'douyin-anchor-daily/v1';
export const SNAPSHOT_PROTOCOL = 'douyin-anchor-snapshot/v1';
export function normalizeRecord(row) {
  if (typeof row.anchorId !== 'string' || !/^\d{5,30}$/.test(row.anchorId)) throw new Error('主播 UID 必须是完整字符串');
  if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date) throw new Error('业务日期无效');
  for (const key of ['followers', 'waves', 'liveSeconds', 'acu']) if (row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > Number.MAX_SAFE_INTEGER)) throw new Error(`${key} 数值无效`);
  if (row.followers != null && !Number.isInteger(row.followers) || row.liveSeconds != null && !Number.isInteger(row.liveSeconds)) throw new Error('粉丝数和直播秒数必须为整数');
  const record = { anchorId: row.anchorId, date: row.date, douyinId: row.douyinId || null, nickname: row.nickname || null, followers: row.followers ?? null, waves: row.waves ?? null, liveSeconds: row.liveSeconds ?? null, acu: row.acu ?? null,
    followersApproximate: Boolean(row.followersApproximate), approximate: [...(row.approximate || [])].sort(), missing: [...(row.missing || [])].sort(), profileMissing: Boolean(row.profileMissing), provisional: Boolean(row.provisional) };
  const complete = Boolean(record.douyinId && record.nickname && !record.profileMissing && !record.followersApproximate && !record.approximate.length && !record.missing.length && ['followers', 'waves', 'liveSeconds', 'acu'].every(key => record[key] != null));
  record.ready = complete && !record.provisional;
  record.snapshotReady = complete && record.provisional;
  return record;
}
export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS profiles (anchor_id TEXT PRIMARY KEY, body TEXT NOT NULL, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (record_key TEXT PRIMARY KEY, body TEXT NOT NULL, fingerprint TEXT NOT NULL, ready INTEGER NOT NULL, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY, record_key TEXT NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, record_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, batch_key TEXT NOT NULL, count INTEGER NOT NULL);`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  saveProfiles(rows) { return this.transaction(() => { const stmt = this.db.prepare('INSERT INTO profiles VALUES (?, ?, ?) ON CONFLICT(anchor_id) DO UPDATE SET body=excluded.body, observed_at=excluded.observed_at'); for (const row of rows) stmt.run(row.anchorId, JSON.stringify(row), now()); }); }
  profiles() { return this.db.prepare('SELECT body FROM profiles ORDER BY anchor_id').all().map(row => JSON.parse(row.body)); }
  collectionSelection() { const row = this.db.prepare("SELECT body FROM state WHERE key='collectionSelection'").get(); return row ? JSON.parse(row.body) : null; }
  saveCollectionSelection(value) { this.db.prepare("INSERT INTO state VALUES ('collectionSelection',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify(value)); }
  historyCheckpoint() { const row = this.db.prepare("SELECT body FROM state WHERE key='historyCheckpoint'").get(); return row ? JSON.parse(row.body) : null; }
  completeHistory(dates) { this.db.prepare("INSERT INTO state VALUES ('historyCheckpoint',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify({ dates, completedAt: now() })); }
  expireSnapshots(today) { this.db.prepare("DELETE FROM outbox WHERE json_extract(body,'$.provisional')=1 AND json_extract(body,'$.date')<?").run(today); }
  completeProfiles(rows, scan = {}) {
    this.db.prepare("INSERT INTO state VALUES ('profiles',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body")
      .run(JSON.stringify({ count: rows.length, platformTotal: scan.total ?? rows.length, scanned: scan.scanned ?? rows.length,
        identified: scan.identified ?? rows.length, unidentified: scan.unidentified ?? 0, duplicates: scan.duplicates ?? 0,
        unidentifiedSample: scan.unidentifiedSample || [], completedAt: now() }));
    this.db.prepare("DELETE FROM state WHERE key='profileProgress'").run();
  }
  profileScan() { const row = this.db.prepare("SELECT body FROM state WHERE key='profiles'").get(); return row ? JSON.parse(row.body) : null; }
  updateProfileProgress(progress) {
    this.db.prepare("INSERT INTO state VALUES ('profileProgress',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify(progress));
  }
  profileProgress() { const row = this.db.prepare("SELECT body FROM state WHERE key='profileProgress'").get(); return row ? JSON.parse(row.body) : null; }
  save(rows) {
    const normalized = rows.map(normalizeRecord);
    return this.transaction(() => {
      let changed = 0;
      for (let i = 0; i < rows.length; i++) {
        const record = normalized[i], key = `${record.anchorId}:${record.date}`, stamp = now();
        const capturedAt = rows[i].capturedAt || stamp;
        const fingerprint = hash(record.snapshotReady ? { ...record, capturedAt } : record);
        const body = JSON.stringify({ ...record, source: 'union.bytedance.com', raw: rows[i].raw || null, exactRaw: rows[i].exactRaw || null, followersRaw: rows[i].followersRaw || null, followersCapturedAt: rows[i].followersCapturedAt || null, capturedAt });
        const previous = this.db.prepare('SELECT fingerprint FROM records WHERE record_key=?').get(key);
        if (previous?.fingerprint === fingerprint) { this.db.prepare('UPDATE records SET body=?,observed_at=? WHERE record_key=?').run(body, stamp, key); continue; }
        this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET body=excluded.body,fingerprint=excluded.fingerprint,ready=excluded.ready,observed_at=excluded.observed_at').run(key, body, fingerprint, +record.ready, stamp);
        this.db.prepare('INSERT INTO revisions(record_key,body,fingerprint,observed_at) VALUES (?,?,?,?)').run(key, body, fingerprint, stamp);
        // A newer unverified observation must not leave an obsolete value queued.
        this.db.prepare('DELETE FROM outbox WHERE record_key=?').run(key);
        if (record.ready || record.snapshotReady) this.db.prepare('INSERT INTO outbox(record_key,fingerprint,body) VALUES (?,?,?)').run(key, fingerprint, body);
        changed++;
      }
      return changed;
    });
  }
  records({ start, end } = {}) {
    const filtered = start != null && end != null;
    return this.db.prepare(`SELECT body,observed_at FROM records ${filtered ? "WHERE json_extract(body,'$.date') BETWEEN ? AND ?" : ''} ORDER BY record_key`)
      .all(...(filtered ? [start, end] : [])).map(row => ({ ...JSON.parse(row.body), observedAt: row.observed_at }));
  }
  pending(at = Date.now(), limit = 50, anchorIds, snapshot = false) {
    if (anchorIds && !anchorIds.length) return [];
    const today = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const type = snapshot ? "json_extract(body,'$.snapshotReady')=1 AND json_extract(body,'$.date')=?" : "json_extract(body,'$.ready')=1";
    return this.db.prepare(`SELECT * FROM outbox WHERE next_at<=? AND ${type}
      ${anchorIds ? "AND json_extract(body,'$.anchorId') IN (SELECT value FROM json_each(?))" : ''} ORDER BY id LIMIT ?`)
      .all(at, ...(snapshot ? [today] : []), ...(anchorIds ? [JSON.stringify(anchorIds)] : []), limit);
  }
  collectionSummary({ start, end }) {
    return { ...this.db.prepare(`SELECT count(*) AS records, count(DISTINCT json_extract(body,'$.date')) AS days,
      coalesce(sum(json_extract(body,'$.acu') IS NULL),0) AS missingAcu,
      coalesce(sum(json_extract(body,'$.waves') IS NULL),0) AS missingWaves,
      coalesce(sum(json_extract(body,'$.liveSeconds') IS NULL),0) AS missingDuration,
      coalesce(sum(ready=0 AND coalesce(json_extract(body,'$.snapshotReady'),0)=0),0) AS review,
      max(json_extract(body,'$.capturedAt')) AS capturedAt
      FROM records WHERE json_extract(body,'$.date') BETWEEN ? AND ?`).get(start, end) };
  }
  queueStatus({ at = Date.now(), anchorIds, enabled = false } = {}) {
    const today = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    return this.db.prepare(`WITH queued AS (
      SELECT (coalesce(json_extract(body,'$.ready'),0)=1 OR
        (coalesce(json_extract(body,'$.snapshotReady'),0)=1 AND json_extract(body,'$.date')=?)) AS eligible,
        ${anchorIds ? "json_extract(body,'$.anchorId') IN (SELECT value FROM json_each(?))" : '1'} AS allowed, attempts FROM outbox
    ) SELECT count(*) AS total,
      count(CASE WHEN eligible AND allowed AND ? THEN 1 END) AS pending,
      count(CASE WHEN eligible AND NOT allowed THEN 1 END) AS unbound,
      count(CASE WHEN eligible AND allowed AND NOT ? THEN 1 END) AS paused,
      count(CASE WHEN NOT eligible THEN 1 END) AS archived,
      count(CASE WHEN eligible AND allowed AND ? AND attempts>0 THEN 1 END) AS retrying FROM queued`)
      .get(today, ...(anchorIds ? [JSON.stringify(anchorIds)] : []), +enabled, +enabled, +enabled);
  }
  delivered(batch, batchKey) { this.transaction(() => { for (const row of batch) this.db.prepare('DELETE FROM outbox WHERE id=? AND fingerprint=?').run(row.id, row.fingerprint); this.db.prepare('INSERT INTO deliveries(created_at,batch_key,count) VALUES (?,?,?)').run(now(), batchKey, batch.length); }); }
  fail(batch, message, at = Date.now()) { this.transaction(() => { for (const row of batch) this.db.prepare('UPDATE outbox SET attempts=attempts+1,next_at=?,error=? WHERE id=? AND fingerprint=?').run(at + Math.min(1800000, 30000 * 2 ** Math.min(row.attempts, 6)), String(message).slice(0, 240), row.id, row.fingerprint); }); }
  beginRun() { return Number(this.db.prepare("INSERT INTO runs(started_at,status) VALUES (?,'running')").run(now()).lastInsertRowid); }
  finishRun(id, status, detail) { this.db.prepare('UPDATE runs SET ended_at=?,status=?,detail=? WHERE id=?').run(now(), status, JSON.stringify(detail), id); }
  status() { const count = table => this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; return { profiles: count('profiles'), profileScan: this.profileScan(), profileProgress: this.profileProgress(), records: count('records'), revisions: count('revisions'), queued: count('outbox'), snapshots: this.db.prepare("SELECT count(*) AS n FROM records WHERE json_extract(body,'$.snapshotReady')=1").get().n, needsReview: this.db.prepare("SELECT count(*) AS n FROM records WHERE ready=0 AND coalesce(json_extract(body,'$.snapshotReady'),0)=0").get().n, lastRun: this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() || null, lastDelivery: this.db.prepare('SELECT * FROM deliveries ORDER BY id DESC LIMIT 1').get() || null }; }
  export(range) { const records = this.records(range); return { protocol: PROTOCOL, snapshotProtocol: SNAPSHOT_PROTOCOL, generatedAt: now(), timezone: 'Asia/Shanghai', ...(range ? { range } : {}), status: this.status(), readyRecords: records.filter(row => row.ready), snapshotRecords: records.filter(row => row.snapshotReady), reviewRecords: records.filter(row => !row.ready && !row.snapshotReady), note: 'readyRecords 为历史日汇总，snapshotRecords 为当日累计快照；通过对应协议同步 ERP，当日快照不参与结算。' }; }
  close() { this.db.close(); }
}
// A later A -> B -> A observation is a new version, even when its metrics
// equal an old acknowledged batch. Retries keep the same persisted body.
export const batchKey = rows => hash(rows.map(row => [row.record_key, row.fingerprint, JSON.parse(row.body).capturedAt]).sort((a,b) => a[0].localeCompare(b[0])));
