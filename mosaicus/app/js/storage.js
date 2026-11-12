// Mosaicus — archivio locale (IndexedDB, resta nel browser di questo computer).
//  • sessions: le misure complete (Quaderno delle misure)
//  • boxes:    i tratti selezionati e salvati, con analisi e colonne calcolate (pagina Elaborazione)
const DB = 'mosaicus', VER = 2;

function open() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      for (const name of ['sessions', 'boxes']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
      }
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out.result ?? out);
    t.onerror = () => rej(t.error);
  });
}

// ---------- misure ----------
export const saveSession = (s) => tx('sessions', 'readwrite', (st) => (s.id ? st.put(s) : st.add(s)));
export const getSession = (id) => tx('sessions', 'readonly', (st) => st.get(id));
export const deleteSession = (id) => tx('sessions', 'readwrite', (st) => st.delete(id));
export async function listSessions() {
  const all = await tx('sessions', 'readonly', (st) => st.getAll());
  return all
    .map(({ id, name, experiment, created, raw }) => ({ id, name, experiment, created, n: raw?.length ?? 0 }))
    .sort((a, b) => b.created - a.created);
}

// ---------- riquadri di elaborazione ----------
export const saveBox = (b) => tx('boxes', 'readwrite', (st) => (b.id ? st.put(b) : st.add(b)));
export const deleteBox = (id) => tx('boxes', 'readwrite', (st) => st.delete(id));
export async function listBoxes() {
  const all = await tx('boxes', 'readonly', (st) => st.getAll());
  return all.sort((a, b) => a.created - b.created);
}
