let flight;
function open() {
  return flight ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('anchor-data-bridge', 1);
    request.onupgradeneeded = () => {
      for (const name of ['profiles', 'daily']) request.result.createObjectStore(name, { keyPath: '_key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function putRows(kind, runId, rows) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(kind, 'readwrite');
    for (const row of rows) tx.objectStore(kind).put({ ...row, runId, _key: `${runId}:${row.anchorId}:${row.date || ''}` });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('本地保存失败'));
  });
}
export async function getRows(kind, runId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(`${runId}:`, `${runId}:\uffff`);
    const request = db.transaction(kind).objectStore(kind).getAll(range);
    request.onsuccess = () => resolve(request.result.map(({ _key, runId, ...row }) => row));
    request.onerror = () => reject(request.error);
  });
}
export async function clearData() {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['profiles', 'daily'], 'readwrite');
    tx.objectStore('profiles').clear(); tx.objectStore('daily').clear();
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
