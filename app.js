// app.js
// Lecture viewer + marker + recorder. Everything persists to IndexedDB as it
// happens, so closing the tab (accidentally or not) and reopening resumes
// the same session with no data lost and no re-upload of the PDF.

import { LectureDb, requestPersistentStorage } from "./db.js";
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
  resumeBanner: document.getElementById("resume-banner"),
  resumeInfo: document.getElementById("resume-info"),
  resumeBtn: document.getElementById("resume-btn"),
  discardBtn: document.getElementById("discard-btn"),

  viewer: document.getElementById("viewer-screen"),
  canvas: document.getElementById("pdf-canvas"),
  slideLabel: document.getElementById("slide-label"),
  prevBtn: document.getElementById("prev-btn"),
  nextBtn: document.getElementById("next-btn"),
  tierRow: document.getElementById("tier-row"),
  recBtn: document.getElementById("rec-btn"),
  recDot: document.getElementById("rec-dot"),
  endBtn: document.getElementById("end-btn"),
  statusLine: document.getElementById("status-line"),
};

let state = {
  sessionId: null,
  pdfDoc: null,
  pageCount: 0,
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

async function renderPage(num) {
  const page = await state.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: 1 });
  // Fit to the canvas's CSS width, capped for memory.
  const targetWidth = Math.min(el.canvas.clientWidth || 1024, 1600) * (window.devicePixelRatio || 1);
  const scale = targetWidth / viewport.width;
  const scaledViewport = page.getViewport({ scale });
  el.canvas.width = scaledViewport.width;
  el.canvas.height = scaledViewport.height;
  const ctx = el.canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
  el.slideLabel.textContent = `Slide ${num} / ${state.pageCount}`;
}

async function goToSlide(num, { log = true } = {}) {
  if (num < 1 || num > state.pageCount) return;
  state.currentSlide = num;
  await renderPage(num);
  await LectureDb.putSession(await currentSessionRecord());
  if (log) {
    await LectureDb.addEvent({
      sessionId: state.sessionId,
      type: "slide",
      slide: num,
      t: nowIso(),
    });
  }
}

async function currentSessionRecord() {
  const existing = await LectureDb.getSession(state.sessionId);
  return {
    ...existing,
    id: state.sessionId,
    currentSlide: state.currentSlide,
  };
}

async function mark(tier) {
  await LectureDb.addEvent({
    sessionId: state.sessionId,
    type: "mark",
    slide: state.currentSlide,
    tier,
    t: nowIso(),
  });
  flashStatus(`Marked slide ${state.currentSlide}: ${TIERS[tier - 1].label}`);
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
    }
  };
  state.mediaRecorder.start(CHUNK_MS);
  state.recording = true;
  await acquireWakeLock();
  const rec = await currentSessionRecord();
  rec.recordingActive = true;
  await LectureDb.putSession(rec);
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
  await exportMarksFile(rec);
  flashStatus("Lecture ended. Marks file saved.");
}

// Builds the v2 marks file (backward-compatible superset of v1) and triggers
// a download via the Share sheet / Files save.
async function exportMarksFile(sessionRecord) {
  const events = await LectureDb.getEvents(state.sessionId);
  const views = events.filter((e) => e.type === "slide").map((e) => ({ slide: e.slide, t: e.t }));
  const marksOnly = events.filter((e) => e.type === "mark").map((e) => ({ slide: e.slide, tier: e.tier, t: e.t }));

  const payload = {
    version: 2,
    lecture_start: sessionRecord.createdAt ? new Date(sessionRecord.createdAt).toISOString() : nowIso(),
    lecture_end: sessionRecord.endedAt || nowIso(),
    pdf_name: sessionRecord.pdfName || null,
    page_count: sessionRecord.pdfPageCount || state.pageCount,
    views, // v2 addition: full slide-change log, for content-independent sync
    marks: marksOnly, // v1-compatible: worst tier per slide is derived by the script
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

async function loadPdfFile(file) {
  const buf = await file.arrayBuffer();
  const sessionId = newSessionId();
  const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;

  const sessionRecord = {
    id: sessionId,
    courseName: null,
    createdAt: Date.now(),
    pdfName: file.name,
    pdfPageCount: doc.numPages,
    currentSlide: 1,
    status: "active",
    recordingActive: false,
  };
  await LectureDb.putSession(sessionRecord);
  await LectureDb.putPdf(sessionId, file, file.name, doc.numPages);
  await LectureDb.addEvent({ sessionId, type: "slide", slide: 1, t: nowIso() });

  state.sessionId = sessionId;
  state.pdfDoc = doc;
  state.pageCount = doc.numPages;
  state.currentSlide = 1;

  showViewer();
  await renderPage(1);
}

async function resumeSession(sessionRecord) {
  const pdfRow = await LectureDb.getPdf(sessionRecord.id);
  if (!pdfRow) {
    flashStatus("Could not find the stored PDF for this session.");
    return;
  }
  const buf = await pdfRow.blob.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;

  state.sessionId = sessionRecord.id;
  state.pdfDoc = doc;
  state.pageCount = doc.numPages;
  state.currentSlide = sessionRecord.currentSlide || 1;

  // Continue the audio sequence numbering rather than restarting at 0.
  state.audioSeq = await LectureDb.countAudioChunks(sessionRecord.id);

  showViewer();
  await renderPage(state.currentSlide);
  flashStatus("Resumed previous session. Recording is paused; press Start to continue.");
}

function showViewer() {
  el.picker.classList.add("hidden");
  el.viewer.classList.remove("hidden");
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
    if (file) loadPdfFile(file);
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

  el.recBtn.addEventListener("click", () => {
    if (state.recording) stopRecording();
    else startRecording();
  });

  el.endBtn.addEventListener("click", () => {
    if (confirm("End the lecture? This stops recording and saves the marks file.")) {
      endLecture();
    }
  });
}

async function init() {
  await requestPersistentStorage();
  buildTierButtons();
  wireControls();

  const active = await LectureDb.getActiveSession();
  if (active) {
    el.resumeBanner.classList.remove("hidden");
    el.resumeInfo.textContent = `${active.pdfName || "Untitled"} — slide ${active.currentSlide}/${active.pdfPageCount}, started ${new Date(
      active.createdAt
    ).toLocaleString()}`;
    el.resumeBtn.addEventListener("click", () => resumeSession(active));
    el.discardBtn.addEventListener("click", async () => {
      if (confirm("Discard this unfinished session? This cannot be undone.")) {
        active.status = "ended";
        active.endedAt = nowIso();
        await LectureDb.putSession(active);
        el.resumeBanner.classList.add("hidden");
      }
    });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init();
