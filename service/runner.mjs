import '../extension/core.js';
const C = globalThis.AnchorCore;
export function rangeDates(start, end, today = C.shanghaiToday()) {
  const first = C.day(start), last = C.day(end);
  if (+first > +last) throw new Error('开始日期不能晚于结束日期');
  if (end > today) throw new Error('不能采集未来日期');
  const count = (+last - +first) / 86400000 + 1;
  if (count > 31) throw new Error('单次最多采集 31 天，请分批采集');
  return Array.from({ length: count }, (_, i) => new Date(+first + i * 86400000).toISOString().slice(0, 10));
}
export function validateSelection(value, today = C.shanghaiToday()) {
  if (value?.mode === 'auto') return { mode: 'auto' };
  if (value?.mode !== 'custom') throw new Error('请选择自动日期或指定日期区间');
  rangeDates(value.start, value.end, today);
  return { mode: 'custom', start: value.start, end: value.end };
}
export function selectedDates(config, today = C.shanghaiToday()) {
  if (config.start || config.end) return rangeDates(config.start, config.end, today).filter(date => date < today);
  const count = config.lookbackDays ?? 2;
  if (!Number.isInteger(count) || count < 1 || count > 31) throw new Error('lookbackDays 必须为 1–31');
  const end = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - count * 86400000).toISOString().slice(0, 10);
  return C.days(start, end, today);
}
export async function runCycle(store, source, config = {}) {
  const dates = selectedDates(config), run = store.beginRun(), profiles = [];
  const today = C.shanghaiToday();
  const counts = { profiles: 0, daily: 0, changed: 0, dates, today: config.includeToday ? 'pending' : 'not-requested' };
  try {
    store.expireSnapshots(C.shanghaiToday());
    let profileScan;
    store.updateProfileProgress({ kind: 'profiles', scanned: 0, total: null, identified: 0, unidentified: 0, unidentifiedSample: [] });
    await source.collect('profiles', null, (rows, progress) => {
      store.saveProfiles(rows); profiles.push(...rows); counts.profiles += rows.length;
      if (progress) { profileScan = progress; store.updateProfileProgress(progress); config.onProgress?.(progress); }
    });
    store.completeProfiles(profiles, profileScan);
    counts.platformRows = profileScan?.scanned ?? profiles.length;
    counts.unidentified = profileScan?.unidentified ?? 0;
    config.onProfiles?.();
    const checkpoint = store.historyCheckpoint();
    const historyDue = config.forceHistory || !checkpoint || JSON.stringify(checkpoint.dates) !== JSON.stringify(dates) || Date.now() - Date.parse(checkpoint.completedAt) >= (config.historyRefreshSeconds ?? 21600) * 1000;
    const dailyDates = [...(config.includeToday ? [today] : []), ...(historyDue ? dates : [])];
    const collectDate = async (date, provisional = false) => {
      const progress = { kind: 'daily', date, dayIndex: dailyDates.indexOf(date) + 1, days: dailyDates.length, scanned: 0, total: null };
      config.onProgress?.(progress);
      await source.collect('daily', date, (rows, pageProgress) => {
        counts.changed += store.save(C.merge(profiles, rows).map(row => ({ ...row, provisional }))); counts.daily += rows.length;
        config.onProgress?.({ ...progress, ...pageProgress, kind: 'daily', date });
      });
    };
    if (config.includeToday) {
      try { await collectDate(today, true); counts.today = 'collected-provisional'; }
      catch (error) { counts.today = 'unavailable'; counts.todayReason = error.message; }
    }
    if (historyDue) {
      for (const date of dates) await collectDate(date);
      store.completeHistory(dates);
    }
    counts.history = historyDue ? 'collected' : 'unchanged-schedule';
    store.finishRun(run, counts.today === 'unavailable' ? 'partial' : 'completed', counts);
    return counts;
  } catch (error) {
    store.finishRun(run, 'error', { ...counts, message: error.message, code: error.code || null, diagnostic: error.diagnostic || null });
    throw error;
  }
}
