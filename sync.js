// sync.js
// Pushes session data (meta, slide/mark events, PDFs, audio chunks) to the
// Dell receiver over Tailscale as it's created. Nothing here blocks the UI:
// every call is fire-and-forget from app.js's point of view, and anything
// that fails (offline, receiver unreachable, Tailscale not connected) stays
// marked unsynced in IndexedDB and is retried on a timer and whenever the
// browser regains connectivity. The receiver URL and token are per-device
// settings, so they live in localStorage, not IndexedDB.

import { LectureDb } from "./db.js";

const CONFIG_KEY = "lectureSyncConfig"; // { url, token }
const RETRY_MS = 15000;

let statusListeners = [];
let currentStatus = "unconfigured"; // "unconfigured" | "idle" | "syncing" | "offline"

export function getSyncConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function setSyncConfig(url, token) {
  const cleanUrl = url.trim().replace(/\/+$/, "");
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: cleanUrl, token: token.trim() }));
  setStatus("idle");
}

export function clearSyncConfig() {
  localStorage.removeItem(CONFIG_KEY);
  setStatus("unconfigured");
}

export function onSyncStatus(fn) {
  statusListeners.push(fn);
  fn(currentStatus);
}

function setStatus(s) {
  currentStatus = s;
  statusListeners.forEach((fn) => fn(s));
}

export function getSyncStatus() {
  return currentStatus;
}

async function post(path, { headers = {}, body } = {}) {
  const config = getSyncConfig();
  if (!config) throw new Error("sync not configured");
  const res = await fetch(`${config.url}${path}`, {
    method: "POST",
    headers: { "X-Lecture-Token": config.token, ...headers },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function checkHealth() {
  const config = getSyncConfig();
  if (!config) return false;
  try {
    const res = await fetch(`${config.url}/health`, { method: "GET" });
    return res.ok;
  } catch (e) {
    return false;
  }
}

export async function syncMeta(sessionRecord) {
  if (!getSyncConfig()) return false;
  try {
    await post(`/session/${sessionRecord.id}/meta`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionRecord),
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function syncComplete(sessionId, info) {
  if (!getSyncConfig()) return false;
  try {
    await post(`/session/${sessionId}/complete`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(info),
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Pushes every unsynced event/pdf/audio chunk for one session. Safe to call
// repeatedly (from a timer, or after every local write): already-synced
// rows are skipped, so this is always cheap when there's nothing new.
export async function flushSession(sessionId) {
  if (!sessionId || !getSyncConfig()) {
    setStatus(getSyncConfig() ? "idle" : "unconfigured");
    return;
  }
  setStatus("syncing");
  try {
    const events = await LectureDb.getUnsyncedEvents(sessionId);
    for (const e of events) {
      await post(`/session/${sessionId}/event`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: e.type, doc: e.doc, slide: e.slide, tier: e.tier, t: e.t }),
      });
      await LectureDb.markEventSynced(e.id);
    }

    const docs = await LectureDb.getUnsyncedPdfDocs(sessionId);
    for (const d of docs) {
      await post(`/session/${sessionId}/pdf/${d.docIndex}`, {
        headers: { "X-Doc-Name": d.name },
        body: d.blob,
      });
      await LectureDb.markPdfSynced(d.id);
    }

    const chunks = await LectureDb.getUnsyncedAudioChunks(sessionId);
    for (const c of chunks) {
      await post(`/session/${sessionId}/audio/${c.seq}`, {
        headers: { "Content-Type": c.blob.type || "application/octet-stream" },
        body: c.blob,
      });
      await LectureDb.markAudioChunkSynced(c.id);
    }

    setStatus("idle");
  } catch (e) {
    setStatus("offline");
  }
}

let retryTimer = null;

// Starts the background retry loop. getActiveSessionId is called each tick
// so this always syncs whatever session is currently open, without needing
// to be re-armed when a new session starts.
export function startAutoSync(getActiveSessionId) {
  if (retryTimer) return;
  const tick = () => {
    const id = getActiveSessionId();
    if (id) flushSession(id);
  };
  retryTimer = setInterval(tick, RETRY_MS);
  window.addEventListener("online", tick);
  tick();
}
