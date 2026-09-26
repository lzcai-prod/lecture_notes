// db.js
// Thin IndexedDB wrapper for the lecture app.
//
// Stores, in one database ("lecture-app"):
//   - sessions:  { id, courseName, createdAt, docs: [{docIndex,name,pageCount}],
//                  currentDocIndex, currentSlide,
//                  status: "active" | "ended", endedAt, recordingActive }
//   - events:    { id (auto), sessionId, type: "slide" | "mark" | "doc",
//                  doc, slide, tier, t }
//   - pdfFiles:  { id (auto), sessionId, docIndex, name, pageCount, blob }
//                (one row per document added to the lecture; a lecture can
//                have several, when the lecturer moves on to a new file)
//   - audioChunks: { id (auto), sessionId, seq, blob, t }   (recorded audio, in order)
//
// Every write is small and immediate, so an accidental close loses at most
// the event or chunk that was mid-flight, never anything already saved.

const DB_NAME = "lecture-app";
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("events")) {
        const store = db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
      // v1 stored one PDF per session, keyed by sessionId. v2 stores one row
      // per document, since a lecture can now have more than one file.
      // There is no real user data to migrate at this point in development,
      // so the old store is simply replaced.
      if (db.objectStoreNames.contains("pdfFiles") && event.oldVersion < 2) {
        db.deleteObjectStore("pdfFiles");
      }
      if (!db.objectStoreNames.contains("pdfFiles")) {
        const store = db.createObjectStore("pdfFiles", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains("audioChunks")) {
        const store = db.createObjectStore("audioChunks", { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function tx(storeNames, mode) {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        const stores = storeNames.map((n) => t.objectStore(n));
        t.oncomplete = () => {};
        t.onerror = () => reject(t.error);
        resolve({ t, stores });
      })
  );
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const LectureDb = {
  // --- sessions ---
  async putSession(session) {
    const { stores } = await tx(["sessions"], "readwrite");
    return reqToPromise(stores[0].put(session));
  },

  async getSession(id) {
    const { stores } = await tx(["sessions"], "readonly");
    return reqToPromise(stores[0].get(id));
  },

  // Returns the most recent session with status "active", or null.
  async getActiveSession() {
    const { stores } = await tx(["sessions"], "readonly");
    const all = await reqToPromise(stores[0].getAll());
    const active = all.filter((s) => s.status === "active");
    active.sort((a, b) => b.createdAt - a.createdAt);
    return active[0] || null;
  },

  async getAllSessions() {
    const { stores } = await tx(["sessions"], "readonly");
    const all = await reqToPromise(stores[0].getAll());
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all;
  },

  // --- events (slide changes + marks) ---
  // Every row starts with synced:false; the sync module flips it to true
  // once the Dell receiver has confirmed it, and a background retry loop
  // re-sends anything still false.
  async addEvent(event) {
    const { stores } = await tx(["events"], "readwrite");
    return reqToPromise(stores[0].add({ ...event, synced: false }));
  },

  async getEvents(sessionId) {
    const { stores } = await tx(["events"], "readonly");
    const idx = stores[0].index("sessionId");
    const events = await reqToPromise(idx.getAll(IDBKeyRange.only(sessionId)));
    events.sort((a, b) => a.t - b.t);
    return events;
  },

  async getUnsyncedEvents(sessionId) {
    const events = await this.getEvents(sessionId);
    return events.filter((e) => !e.synced);
  },

  async markEventSynced(id) {
    const { stores } = await tx(["events"], "readwrite");
    const row = await reqToPromise(stores[0].get(id));
    if (row) {
      row.synced = true;
      await reqToPromise(stores[0].put(row));
    }
  },

  // --- pdf storage (one row per document in the lecture) ---
  async addPdfDoc(sessionId, docIndex, blob, name, pageCount) {
    const { stores } = await tx(["pdfFiles"], "readwrite");
    return reqToPromise(stores[0].add({ sessionId, docIndex, blob, name, pageCount, synced: false }));
  },

  // Returns all documents for a session, in the order they were added.
  async getPdfDocs(sessionId) {
    const { stores } = await tx(["pdfFiles"], "readonly");
    const idx = stores[0].index("sessionId");
    const docs = await reqToPromise(idx.getAll(IDBKeyRange.only(sessionId)));
    docs.sort((a, b) => a.docIndex - b.docIndex);
    return docs;
  },

  async getUnsyncedPdfDocs(sessionId) {
    const docs = await this.getPdfDocs(sessionId);
    return docs.filter((d) => !d.synced);
  },

  async markPdfSynced(id) {
    const { stores } = await tx(["pdfFiles"], "readwrite");
    const row = await reqToPromise(stores[0].get(id));
    if (row) {
      row.synced = true;
      await reqToPromise(stores[0].put(row));
    }
  },

  // --- audio chunks ---
  async addAudioChunk(sessionId, seq, blob, t) {
    const { stores } = await tx(["audioChunks"], "readwrite");
    return reqToPromise(stores[0].add({ sessionId, seq, blob, t, synced: false }));
  },

  async getAudioChunks(sessionId) {
    const { stores } = await tx(["audioChunks"], "readonly");
    const idx = stores[0].index("sessionId");
    const chunks = await reqToPromise(idx.getAll(IDBKeyRange.only(sessionId)));
    chunks.sort((a, b) => a.seq - b.seq);
    return chunks;
  },

  async getUnsyncedAudioChunks(sessionId) {
    const chunks = await this.getAudioChunks(sessionId);
    return chunks.filter((c) => !c.synced);
  },

  async markAudioChunkSynced(id) {
    const { stores } = await tx(["audioChunks"], "readwrite");
    const row = await reqToPromise(stores[0].get(id));
    if (row) {
      row.synced = true;
      await reqToPromise(stores[0].put(row));
    }
  },

  async countAudioChunks(sessionId) {
    const chunks = await this.getAudioChunks(sessionId);
    return chunks.length;
  },

  // Permanently removes a session and everything recorded under it (events,
  // stored PDFs, audio chunks). Used for "quit without saving", so nothing
  // orphaned is left taking up storage.
  async deleteSession(sessionId) {
    const { stores } = await tx(["sessions", "events", "pdfFiles", "audioChunks"], "readwrite");
    const [sessionsStore, eventsStore, pdfStore, audioStore] = stores;

    await reqToPromise(sessionsStore.delete(sessionId));

    for (const store of [eventsStore, pdfStore, audioStore]) {
      const idx = store.index("sessionId");
      await new Promise((resolve, reject) => {
        const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    }
  },
};

// Ask iOS to keep this origin's storage around (best effort; iOS may still
// evict data for a page that is never opened, but this reduces the risk and
// costs nothing to call even if unsupported).
export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      return await navigator.storage.persist();
    } catch (e) {
      return false;
    }
  }
  return false;
}
