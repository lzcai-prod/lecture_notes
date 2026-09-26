// app.js
// Lecture viewer + marker + recorder. Everything persists to IndexedDB as it
// happens, so closing the tab (accidentally or not) and reopening resumes
// the same session with no data lost and no re-upload of any file.
//
// A lecture session can hold more than one PDF ("doc"): when the lecturer
// moves on to a new file, the current one tapping "+" adds it without
// interrupting recording. Slide numbers are per-document (each new doc
// starts back at slide 1), so every logged event carries both a doc index
// and a slide number.

import { LectureDb, requestPersistentStorage } from "./db.js";
import { getSyncConfig, setSyncConfig, checkHealth, syncMeta, syncComplete, flushSession, startAutoSync, onSyncStatus, getSyncStatus } from "./sync.js";
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const TIERS = [
  { n: 1, label: "Perfectly" },
  { n: 2, label: "Mostly" },
  { n: 3, label: "About" },
  { n: 4, label: "Blurry" },
  { n: 5, label: "Lost" },
];

const CHUNK_MS = 5000; // audio chunk length; each chunk is saved as it arrives

const el = {
  picker: document.getElementById("picker-screen"),
  filePicker: document.getElementById("file-picker"),
  demoBanner: document.getElementById("demo-banner"),
  demoDismissBtn: document.getElementById("demo-dismiss-btn"),
  resumeBanner: document.getElementById("resume-banner"),
  resumeInfo: document.getElementById("resume-info"),
  resumeBtn: document.getElementById("resume-btn"),
  discardBtn: document.getElementById("discard-btn"),

  viewer: document.getElementById("viewer-screen"),
  docSwitcher: document.getElementById("doc-switcher"),
  addFileBtn: document.getElementById("add-file-btn"),
  addFilePicker: document.getElementById("add-file-picker"),
  canvas: document.getElementById("pdf-canvas"),
  slideLabel: document.getElementById("slide-label"),
  prevBtn: document.getElementById("prev-btn"),
  nextBtn: document.getElementById("next-btn"),
  tierRow: document.getElementById("tier-row"),
  markStartBtn: document.getElementById("mark-start-btn"),
  markStartResult: document.getElementById("mark-start-result"),
  recBtn: document.getElementById("rec-btn"),
  recDot: document.getElementById("rec-dot"),
  endBtn: document.getElementById("end-btn"),
  discardSessionBtn: document.getElementById("discard-session-btn"),
  statusLine: document.getElementById("status-line"),
  syncStatus: document.getElementById("sync-status"),

  settingsBtn: document.getElementById("settings-btn"),
  settingsPanel: document.getElementById("settings-panel"),
  settingsUrl: document.getElementById("settings-url"),
  settingsToken: document.getElementById("settings-token"),
  settingsSave: document.getElementById("settings-save"),
  settingsTest: document.getElementById("settings-test"),
  settingsClose: document.getElementById("settings-close"),
  settingsResult: document.getElementById("settings-result"),
};

let state = {
  sessionId: null,
  docs: [], // [{ docIndex, name, pageCount, pdfDoc, lastSlide }]
  currentDocIndex: 0,
  currentSlide: 1,
  mediaRecorder: null,
  audioSeq: 0,
  wakeLock: null,
  recording: false,
};

function nowIso() {
  // ISO 8601 with local timezone offset preserved (not "Z"), so the Dell can
  // reconstruct exact local wall-clock time regardless of where it runs.
  const d = new Date();
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return d.toISOString().replace("Z", "") + `${sign}${hh}:${mm}`;
}

function newSessionId() {
  return "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

function currentDoc() {
  return state.docs[state.currentDocIndex];
}

async function renderPage(num) {
  const doc = currentDoc();
  const page = await doc.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: 1 });
  // Fit to the canvas's CSS width, capped for memory.
  const targetWidth = Math.min(el.canvas.clientWidth || 1024, 1600) * (window.devicePixelRatio || 1);
  const scale = targetWidth / viewport.width;
  const scaledViewport = page.getViewport({ scale });
  el.canvas.width = scaledViewport.width;
  el.canvas.height = scaledViewport.height;
  const ctx = el.canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
  el.slideLabel.textContent =
    state.docs.length > 1 ? `${doc.name} — Slide ${num} / ${doc.pageCount}` : `Slide ${num} / ${doc.pageCount}`;
}

async function goToSlide(num, { log = true } = {}) {
  const doc = currentDoc();
  if (num < 1 || num > doc.pageCount) return;
  state.currentSlide = num;
  doc.lastSlide = num;
  await renderPage(num);
  await LectureDb.putSession(await currentSessionRecord());
  if (log) {
    await LectureDb.addEvent({
      sessionId: state.sessionId,
      type: "slide",
      doc: doc.docIndex,
      slide: num,
      t: nowIso(),
    });
    flushSession(state.sessionId);
  }
}

async function switchDoc(docIndex) {
  if (docIndex === state.currentDocIndex) return;
  state.currentDocIndex = docIndex;
  const doc = currentDoc();
  const target = doc.lastSlide || 1;
  state.currentSlide = target;
  await renderPage(target);
  await LectureDb.putSession(await currentSessionRecord());
  await LectureDb.addEvent({
    sessionId: state.sessionId,
    type: "slide",
    doc: doc.docIndex,
    slide: target,
    t: nowIso(),
  });
  flushSession(state.sessionId);
  renderDocSwitcher();
}

async function currentSessionRecord() {
  const existing = await LectureDb.getSession(state.sessionId);
  return {
    ...existing,
    id: state.sessionId,
    docs: state.docs.map((d) => ({ docIndex: d.docIndex, name: d.name, pageCount: d.pageCount })),
    currentDocIndex: state.currentDocIndex,
    currentSlide: state.currentSlide,
  };
}

async function mark(tier) {
  const doc = currentDoc();
  await LectureDb.addEvent({
    sessionId: state.sessionId,
    type: "mark",
    doc: doc.docIndex,
    slide: state.currentSlide,
    tier,
    t: nowIso(),
  });
  flushSession(state.sessionId);
  flashStatus(`Marked slide ${state.currentSlide}: ${TIERS[tier - 1].label}`);
}

// Logs a precise anchor timestamp for "this is the instant Voice Memos was
// started" -- Phase 3 alignment uses this (plus the audio file's own known
// duration) to estimate where the recording actually sits on the same
// clock as the slide/mark events, instead of guessing purely from content.
// Safe to tap again (e.g. if the first attempt was a false start): each tap
// logs a new anchor, and the display always shows the latest one.
async function markRecordingStart() {
  const t = nowIso();
  await LectureDb.addEvent({ sessionId: state.sessionId, type: "audio_anchor", t });
  flushSession(state.sessionId);
  showLastAudioAnchor(t);
}

function showLastAudioAnchor(isoTime) {
  const label = new Date(isoTime).toLocaleTimeString();
  el.markStartResult.textContent = `Marked at ${label}. Tap again to redo if that was a false start.`;
}

function flashStatus(msg) {
  el.statusLine.textContent = msg;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => {
    el.statusLine.textContent = state.recording ? "Recording" : "Not recording";
  }, 1500);
}

async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    }
  } catch (e) {
    // Not fatal: recording still works, screen may just lock (Safari then
    // pauses recording; the user is warned in the UI copy).
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

// Re-acquire the wake lock if the tab becomes visible again while recording
// (iOS releases it automatically on backgrounding).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.recording) {
    acquireWakeLock();
  }
});

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
    ? "audio/mp4"
    : MediaRecorder.isTypeSupported("audio/webm")
    ? "audio/webm"
    : "";
  state.mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  state.mediaRecorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0) {
      const seq = state.audioSeq++;
      await LectureDb.addAudioChunk(state.sessionId, seq, e.data, nowIso());
      flushSession(state.sessionId);
    }
  };
  state.mediaRecorder.start(CHUNK_MS);
  state.recording = true;
  await acquireWakeLock();
  const rec = await currentSessionRecord();
  rec.recordingActive = true;
  await LectureDb.putSession(rec);
  syncMeta(rec);
  updateRecordingUi();
}

async function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    state.mediaRecorder.stop();
  }
  state.recording = false;
  releaseWakeLock();
  const rec = await currentSessionRecord();
  rec.recordingActive = false;
  await LectureDb.putSession(rec);
  syncMeta(rec);
  flushSession(state.sessionId);
  updateRecordingUi();
}

function updateRecordingUi() {
  el.recBtn.textContent = state.recording ? "Stop recording" : "Start recording";
  el.recDot.classList.toggle("live", state.recording);
  el.statusLine.textContent = state.recording ? "Recording" : "Not recording";
}

async function endLecture() {
  if (state.recording) await stopRecording();
  const rec = await currentSessionRecord();
  rec.status = "ended";
  rec.endedAt = nowIso();
  await LectureDb.putSession(rec);
  await syncMeta(rec);
  await flushSession(state.sessionId);
  await syncComplete(state.sessionId, { endedAt: rec.endedAt });

  // The Dell already has everything once sync succeeds (and more: audio and
  // the PDFs too), so the local download is only useful as a fallback when
  // sync isn't configured or didn't fully go through this time.
  if (getSyncStatus() === "idle") {
    flashStatus("Lecture ended and synced to the Dell.");
  } else {
    await exportMarksFile(rec);
    flashStatus("Lecture ended. Could not confirm sync, so the marks file was also saved here as a backup.");
  }
}

// Permanently deletes the current session (recording, slide log, marks,
// stored PDFs) and returns to the picker screen. No marks file is exported.
async function quitWithoutSaving() {
  if (state.recording) {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
      state.mediaRecorder.stop();
    }
    state.recording = false;
    releaseWakeLock();
  }
  await LectureDb.deleteSession(state.sessionId);

  state.sessionId = null;
  state.docs = [];
  state.currentDocIndex = 0;
  state.currentSlide = 1;
  state.mediaRecorder = null;
  state.audioSeq = 0;

  el.viewer.classList.add("hidden");
  el.resumeBanner.classList.add("hidden");
  el.picker.classList.remove("hidden");
}

// Builds the v3 marks file and triggers a download via the Share sheet /
// Files save. v3 adds multi-document support: a "docs" manifest, and every
// view/mark now carries a "doc" index alongside its slide number (slide
// numbers are only unique within a document).
async function exportMarksFile(sessionRecord) {
  const events = await LectureDb.getEvents(state.sessionId);
  const views = events
    .filter((e) => e.type === "slide")
    .map((e) => ({ doc: e.doc, slide: e.slide, t: e.t }));
  const marksOnly = events
    .filter((e) => e.type === "mark")
    .map((e) => ({ doc: e.doc, slide: e.slide, tier: e.tier, t: e.t }));
  const audioAnchors = events.filter((e) => e.type === "audio_anchor");
  const audioAnchor = audioAnchors.length ? audioAnchors[audioAnchors.length - 1].t : null;

  const payload = {
    version: 3,
    lecture_start: sessionRecord.createdAt ? new Date(sessionRecord.createdAt).toISOString() : nowIso(),
    lecture_end: sessionRecord.endedAt || nowIso(),
    audio_anchor: audioAnchor, // precise moment Voice Memos was started, if marked; null otherwise
    docs: (sessionRecord.docs || []).map((d) => ({
      index: d.docIndex,
      name: d.name,
      page_count: d.pageCount,
    })),
    views, // full slide-change log, for content-independent sync
    marks: marksOnly, // worst tier per (doc, slide) is derived by the script
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `marks_${state.sessionId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Loads a PDF as either the first document of a brand new session, or an
// additional document appended to the session already in progress.
async function loadPdfFile(file, { additional = false } = {}) {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;

  if (!additional) {
    const sessionId = newSessionId();
    state.sessionId = sessionId;
    state.docs = [];
    state.currentDocIndex = 0;

    const sessionRecord = {
      id: sessionId,
      courseName: null,
      createdAt: Date.now(),
      currentDocIndex: 0,
      currentSlide: 1,
      status: "active",
      recordingActive: false,
    };
    await LectureDb.putSession(sessionRecord);
  }

  const docIndex = state.docs.length;
  await LectureDb.addPdfDoc(state.sessionId, docIndex, file, file.name, doc.numPages);
  state.docs.push({ docIndex, name: file.name, pageCount: doc.numPages, pdfDoc: doc, lastSlide: 1 });

  const rec = await currentSessionRecord();
  await LectureDb.putSession(rec);
  await LectureDb.addEvent({ sessionId: state.sessionId, type: "slide", doc: docIndex, slide: 1, t: nowIso() });

  state.currentDocIndex = docIndex;
  state.currentSlide = 1;

  showViewer();
  renderDocSwitcher();
  await renderPage(1);

  syncMeta(rec);
  flushSession(state.sessionId);

  if (additional) flashStatus(`Added ${file.name}. Recording continues uninterrupted.`);
}

async function resumeSession(sessionRecord) {
  const pdfRows = await LectureDb.getPdfDocs(sessionRecord.id);
  if (!pdfRows.length) {
    flashStatus("Could not find the stored PDF(s) for this session.");
    return;
  }

  state.sessionId = sessionRecord.id;
  state.docs = [];
  for (const row of pdfRows) {
    const buf = await row.blob.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    state.docs.push({ docIndex: row.docIndex, name: row.name, pageCount: row.pageCount, pdfDoc: doc, lastSlide: 1 });
  }

  state.currentDocIndex = sessionRecord.currentDocIndex || 0;
  state.currentSlide = sessionRecord.currentSlide || 1;
  const doc = currentDoc();
  if (doc) doc.lastSlide = state.currentSlide;

  // Continue the audio sequence numbering rather than restarting at 0.
  state.audioSeq = await LectureDb.countAudioChunks(sessionRecord.id);

  showViewer();
  renderDocSwitcher();
  await renderPage(state.currentSlide);
  flushSession(state.sessionId); // catch up on anything left unsynced from before the close

  const events = await LectureDb.getEvents(state.sessionId);
  const anchors = events.filter((e) => e.type === "audio_anchor");
  if (anchors.length) showLastAudioAnchor(anchors[anchors.length - 1].t);

  flashStatus("Resumed previous session. Recording is paused; press Start to continue.");
}

function showViewer() {
  el.picker.classList.add("hidden");
  el.viewer.classList.remove("hidden");
}

function renderDocSwitcher() {
  el.docSwitcher.innerHTML = "";
  if (state.docs.length <= 1) {
    el.docSwitcher.classList.add("hidden");
  } else {
    el.docSwitcher.classList.remove("hidden");
    state.docs.forEach((d) => {
      const btn = document.createElement("button");
      btn.className = "doc-tab" + (d.docIndex === state.currentDocIndex ? " active" : "");
      btn.textContent = d.name.replace(/\.pdf$/i, "");
      btn.title = d.name;
      btn.addEventListener("click", () => switchDoc(d.docIndex));
      el.docSwitcher.appendChild(btn);
    });
  }
}

function buildTierButtons() {
  el.tierRow.innerHTML = "";
  TIERS.forEach(({ n, label }) => {
    const btn = document.createElement("button");
    btn.className = `tier-btn tier-${n}`;
    btn.innerHTML = `<span class="tier-num">${n}</span><span class="tier-label">${label}</span>`;
    btn.addEventListener("click", () => mark(n));
    el.tierRow.appendChild(btn);
  });
}

function wireControls() {
  el.filePicker.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadPdfFile(file, { additional: false });
    e.target.value = "";
  });

  el.addFileBtn.addEventListener("click", () => el.addFilePicker.click());
  el.addFilePicker.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadPdfFile(file, { additional: true });
    e.target.value = "";
  });

  el.prevBtn.addEventListener("click", () => goToSlide(state.currentSlide - 1));
  el.nextBtn.addEventListener("click", () => goToSlide(state.currentSlide + 1));

  // Swipe left/right on the canvas.
  let touchStartX = null;
  el.canvas.addEventListener("touchstart", (e) => {
    touchStartX = e.changedTouches[0].clientX;
  });
  el.canvas.addEventListener("touchend", (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) {
      if (dx < 0) goToSlide(state.currentSlide + 1);
      else goToSlide(state.currentSlide - 1);
    }
    touchStartX = null;
  });

  el.markStartBtn.addEventListener("click", () => markRecordingStart());

  el.recBtn.addEventListener("click", () => {
    if (state.recording) stopRecording();
    else startRecording();
  });

  el.endBtn.addEventListener("click", () => {
    if (confirm("End the lecture? This stops recording and saves the marks file.")) {
      endLecture();
    }
  });

  el.discardSessionBtn.addEventListener("click", () => {
    if (
      confirm(
        "Quit without saving? This permanently deletes the recording, slide log and marks for this session. This cannot be undone."
      )
    ) {
      quitWithoutSaving();
    }
  });

  el.settingsBtn.addEventListener("click", () => {
    const config = getSyncConfig();
    el.settingsUrl.value = config?.url || "";
    el.settingsToken.value = config?.token || "";
    el.settingsResult.textContent = "";
    el.settingsPanel.classList.remove("hidden");
  });

  el.settingsClose.addEventListener("click", () => el.settingsPanel.classList.add("hidden"));

  el.settingsSave.addEventListener("click", () => {
    setSyncConfig(el.settingsUrl.value, el.settingsToken.value);
    el.settingsResult.textContent = "Saved.";
    updateDemoBanner();
    if (state.sessionId) flushSession(state.sessionId);
  });

  el.settingsTest.addEventListener("click", async () => {
    setSyncConfig(el.settingsUrl.value, el.settingsToken.value);
    el.settingsResult.textContent = "Checking...";
    const ok = await checkHealth();
    el.settingsResult.textContent = ok ? "Reachable." : "Could not reach the receiver. Check Tailscale and the URL.";
  });
}

function updateSyncStatusUi(status) {
  const labels = {
    unconfigured: "Sync: not set up",
    idle: "Synced",
    syncing: "Syncing...",
    offline: "Sync: offline, queued",
  };
  el.syncStatus.textContent = labels[status] || status;
  el.syncStatus.className = "sync-status sync-" + status;
}

// One-time auto-configure from a link's query params, e.g.
//   ?sync_url=https%3A%2F%2Fyour-dell...ts.net%2Flecture&sync_token=...
// so setup on a new device is "open this one link" instead of typing into
// the settings panel. The params are stripped from the address bar right
// away so the token doesn't linger in Safari's URL/history after the first
// load; from then on it's read from localStorage like any saved setting.
function applyUrlConfigIfPresent() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get("sync_url");
  const token = params.get("sync_token");
  if (url && token) {
    setSyncConfig(url, token);
    window.history.replaceState({}, "", window.location.pathname);
  }
}

const DEMO_DISMISSED_KEY = "demoBannerDismissed";

// No sync configured on this device means there's no owner-specific setup
// here at all -- either a real first run before the owner configures sync,
// or (far more likely for a link shared publicly) a visitor who isn't the
// owner. Either way the honest thing to show is "this is a demo," rather
// than silently behaving like a real app and only failing later.
function updateDemoBanner() {
  const isDemo = !getSyncConfig();
  const dismissed = localStorage.getItem(DEMO_DISMISSED_KEY) === "1";
  el.demoBanner.classList.toggle("hidden", !isDemo || dismissed);
}

async function init() {
  await requestPersistentStorage();
  applyUrlConfigIfPresent();
  buildTierButtons();
  wireControls();
  onSyncStatus(updateSyncStatusUi);
  startAutoSync(() => state.sessionId);

  updateDemoBanner();
  el.demoDismissBtn.addEventListener("click", () => {
    localStorage.setItem(DEMO_DISMISSED_KEY, "1");
    updateDemoBanner();
  });

  const active = await LectureDb.getActiveSession();
  if (active) {
    const docNames = (active.docs || []).map((d) => d.name).join(", ") || "Untitled";
    el.resumeBanner.classList.remove("hidden");
    el.resumeInfo.textContent = `${docNames} — slide ${active.currentSlide}/${
      (active.docs || [])[active.currentDocIndex]?.pageCount ?? "?"
    }, started ${new Date(active.createdAt).toLocaleString()}`;
    el.resumeBtn.addEventListener("click", () => resumeSession(active));
    el.discardBtn.addEventListener("click", async () => {
      if (
        confirm(
          "Discard this unfinished session? This permanently deletes its recording, slide log and marks. This cannot be undone."
        )
      ) {
        await LectureDb.deleteSession(active.id);
        el.resumeBanner.classList.add("hidden");
      }
    });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init();
