import { I18N } from './i18n.js';
import { state, t, formatMs } from './state.js';
import {
  video, canvas, ctx,
  initCamera, setCameraTorch, flashStartTorchPulse,
  isSkinOrCapPixel, captureFrameToRingBuffer, appendPostTriggerFrames
} from './vision.js';
import {
  registerSyncCallbacks, publishSyncEvent, connectToSyncRoom, renderMultiSwimmersBoard
} from './sync.js';

// Remove injected Netlify badges if any
const removeNetlifyInjectedBadge = () => {
  document.querySelectorAll('a[href*="netlify.com"], iframe[src*="netlify"], div').forEach(el => {
    if (el.id !== 'startOverlay' && el.id !== 'settingsModal' && el.id !== 'frameEditorModal' &&
        !el.closest('main') && !el.closest('header')) {
      if ((el.innerText && el.innerText.includes('Powered by Netlify')) ||
          (el.getAttribute('href') && el.getAttribute('href').includes('netlify.com'))) {
        el.remove();
      }
    }
  });
};
removeNetlifyInjectedBadge();
new MutationObserver(removeNetlifyInjectedBadge).observe(document.body, { childList: true, subtree: true });

// PWA Installation & Service Worker
let deferredInstallPrompt = null;
const installPwaBtn = document.getElementById('installPwaBtn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installPwaBtn.classList.remove('hidden');
});

installPwaBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installPwaBtn.classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(() => {});
  });
}

document.getElementById('hardReloadBtn').addEventListener('click', async () => {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  }
  window.location.reload(true);
});

// Wake Lock
let wakeLockSentinel = null;
async function requestWakeLock() {
  const badge = document.getElementById('wakeLockBadge');
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      badge.textContent = 'Screen Awake';
      badge.className = 'bg-emerald-950/90 backdrop-blur px-2.5 py-1 rounded-lg border border-emerald-600/40 text-[10px] font-bold text-emerald-300 uppercase';
    } catch (e) {}
  }
}
document.addEventListener('click', () => {
  if (!wakeLockSentinel) requestWakeLock();
}, { once: true });

// UI Status & Language
function updateSensorStatusUI(mode) {
  const dot = document.getElementById('sensorStateDot');
  const text = document.getElementById('sensorStateText');
  if (mode === 'armed') {
    dot.className = 'w-3 h-3 rounded-full bg-emerald-400 animate-ping';
    text.textContent = t('statusArmed');
    text.className = 'text-[11px] font-bold text-emerald-400 block mt-0.5';
  } else if (mode === 'dead') {
    dot.className = 'w-3 h-3 rounded-full bg-amber-400';
    text.textContent = t('statusDead');
    text.className = 'text-[11px] font-bold text-amber-400 block mt-0.5';
  } else if (mode === 'finished') {
    dot.className = 'w-3 h-3 rounded-full bg-sky-400';
    text.textContent = t('statusFinished');
    text.className = 'text-[11px] font-bold text-sky-400 block mt-0.5';
  } else {
    dot.className = 'w-3 h-3 rounded-full bg-slate-500';
    text.textContent = t('statusIdle');
    text.className = 'text-[11px] font-bold text-slate-400 block mt-0.5';
  }
}

function updatePrepAndDistanceLabels() {
  const contacts = state.targetDistance / 50;
  document.getElementById('raceProgressLabel').textContent =
    state.lang === 'pl'
      ? `DYSTANS ${state.targetDistance} M • PRZYGOTOWANIE: ${state.prepTimeSeconds} S`
      : `DISTANCE ${state.targetDistance} M • PREP: ${state.prepTimeSeconds} S`;
  document.getElementById('syncDistSummary').textContent =
    `${state.targetDistance} m (${contacts}x50m)`;
  document.getElementById('syncPrepBadge').textContent =
    `Prep: ${state.prepTimeSeconds} s`;
}

function applyTargetDistanceUI(dist, broadcast = false) {
  state.targetDistance = Number(dist);
  document.querySelectorAll('.dist-btn').forEach(b => {
    const bDist = Number(b.getAttribute('data-dist'));
    if (bDist === state.targetDistance) {
      b.className = 'dist-btn py-2.5 rounded-xl text-sm font-black bg-sky-500 text-slate-950';
    } else {
      b.className = 'dist-btn py-2.5 rounded-xl text-sm font-black text-slate-400 hover:text-white';
    }
  });
  updatePrepAndDistanceLabels();

  if (broadcast && state.mqttClient && state.mqttClient.connected) {
    publishSyncEvent({ type: 'SET_CONFIG', distance: state.targetDistance, prepTimeSeconds: state.prepTimeSeconds });
  }
}

function applyLanguageUI() {
  document.documentElement.lang = state.lang;
  document.getElementById('langToggleBtn').textContent = state.lang === 'en' ? 'EN | PL' : 'PL | EN';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (I18N[state.lang][key]) {
      el.textContent = I18N[state.lang][key];
    }
  });
  document.getElementById('roleDescriptionText').textContent =
    state.role === 'coach' ? t('coachDesc') : t('swimmerDesc');
  updatePrepAndDistanceLabels();
  const mode = state.raceStatus === 'running_armed'
    ? 'armed'
    : (state.raceStatus === 'running_dead' ? 'dead' : (state.raceStatus === 'finished' ? 'finished' : 'idle'));
  updateSensorStatusUI(mode);
  renderSplitsTable();
  renderLapHistory();
}

document.getElementById('langToggleBtn').addEventListener('click', () => {
  state.lang = state.lang === 'en' ? 'pl' : 'en';
  localStorage.setItem('swimtimer_lang', state.lang);
  applyLanguageUI();
});

// Splits & Photo-Finish Modal
const modal = document.getElementById('frameEditorModal');
const modalSlider = document.getElementById('modalFrameSlider');

function openFrameEditorModal(eventObj, mode) {
  if (!eventObj || !eventObj.frames || eventObj.frames.length === 0) return;
  state.editingEventRef = { eventObj, mode };

  document.getElementById('modalTitle').textContent = `Photo-Finish (${eventObj.distance} m)`;
  modalSlider.min = 0;
  modalSlider.max = eventObj.frames.length - 1;
  modalSlider.value = eventObj.selectedFrameIdx;

  updateModalFramePreview(eventObj.selectedFrameIdx);
  modal.classList.remove('hidden');
}

function updateModalFramePreview(frameIdx) {
  const ref = state.editingEventRef;
  if (!ref) return;
  const { eventObj } = ref;
  const clampedIdx = Math.max(0, Math.min(eventObj.frames.length - 1, Number(frameIdx)));
  modalSlider.value = clampedIdx;

  const frame = eventObj.frames[clampedIdx];
  const aiFrame = eventObj.frames[eventObj.aiFrameIdx] || frame;

  document.getElementById('modalFrameImg').src = frame.dataUrl;
  document.getElementById('modalFrameTime').textContent = formatMs(frame.elapsedMs);
  document.getElementById('modalFrameScore').textContent = `${frame.skinScore || 0}%`;
  document.getElementById('modalFrameIndexLabel').textContent = `Frame: ${clampedIdx + 1} / ${eventObj.frames.length}`;

  const deltaSec = (frame.elapsedMs - aiFrame.elapsedMs) / 1000;
  const sign = deltaSec > 0 ? '+' : '';
  document.getElementById('modalTimeDeltaLabel').textContent = `Delta: ${sign}${deltaSec.toFixed(2)} s`;

  const badge = document.getElementById('modalTriggerBadge');
  if (clampedIdx === eventObj.aiFrameIdx) {
    badge.textContent = 'AI TRIGGER';
    badge.className = 'absolute top-3 right-3 bg-amber-400 text-slate-950 text-xs font-black px-2.5 py-1 rounded-lg';
  } else {
    badge.textContent = `ADJUSTED (${sign}${deltaSec.toFixed(2)}s)`;
    badge.className = 'absolute top-3 right-3 bg-sky-400 text-slate-950 text-xs font-black px-2.5 py-1 rounded-lg';
  }
}

modalSlider.addEventListener('input', (e) => updateModalFramePreview(Number(e.target.value)));
document.getElementById('stepBack1Btn').addEventListener('click', () => updateModalFramePreview(Number(modalSlider.value) - 1));
document.getElementById('stepFwd1Btn').addEventListener('click', () => updateModalFramePreview(Number(modalSlider.value) + 1));
document.getElementById('stepBack5Btn').addEventListener('click', () => updateModalFramePreview(Number(modalSlider.value) - 5));
document.getElementById('stepFwd5Btn').addEventListener('click', () => updateModalFramePreview(Number(modalSlider.value) + 5));

document.getElementById('resetTriggerFrameBtn').addEventListener('click', () => {
  if (state.editingEventRef) updateModalFramePreview(state.editingEventRef.eventObj.aiFrameIdx);
});

document.getElementById('saveCorrectedFrameBtn').addEventListener('click', () => {
  if (!state.editingEventRef) return;
  const { eventObj, mode } = state.editingEventRef;
  const chosenIdx = Number(modalSlider.value);
  const chosenFrame = eventObj.frames[chosenIdx];

  eventObj.selectedFrameIdx = chosenIdx;
  eventObj.totalMs = chosenFrame.elapsedMs;
  eventObj.corrected = (chosenIdx !== eventObj.aiFrameIdx);

  if (mode === 'race') {
    recalculateSplitsCascade();
    renderSplitsTable();
  } else {
    renderLapHistory();
  }
  modal.classList.add('hidden');
});

document.getElementById('closeModalBtn').addEventListener('click', () => modal.classList.add('hidden'));

function recordRaceSplitOrFinish(triggerPerfMs) {
  const totalElapsedMs = triggerPerfMs - state.startTimeMs;
  const prevTotalMs = state.splits.length > 0 ? state.splits[state.splits.length - 1].totalMs : 0;
  const splitMs = totalElapsedMs - prevTotalMs;
  const currentDistance = (state.splits.length + 1) * 50;

  const capturedFrames = state.ringBuffer.map(f => ({ ...f }));
  const aiIdx = Math.max(0, capturedFrames.length - 1);

  const splitEntry = {
    id: Date.now() + Math.random(),
    index: state.splits.length + 1,
    distance: currentDistance,
    totalMs: totalElapsedMs,
    splitMs: splitMs,
    frames: capturedFrames,
    selectedFrameIdx: aiIdx,
    aiFrameIdx: aiIdx,
    corrected: false
  };

  state.splits.push(splitEntry);
  appendPostTriggerFrames(splitEntry, 12);

  const isFinished = currentDistance >= state.targetDistance;

  if (isFinished) {
    state.raceStatus = 'finished';
    const formatted = formatMs(totalElapsedMs);
    document.getElementById('mainTimerDisplay').textContent = formatted;
    document.getElementById('syncLocalTimerDisplay').textContent = formatted;
    document.getElementById('manualSplitBtn').disabled = true;
    updateSensorStatusUI('finished');
  } else {
    state.raceStatus = 'running_dead';
    state.armAtTimeMs = triggerPerfMs + state.deadTimeSeconds * 1000;
    updateSensorStatusUI('dead');
  }

  renderSplitsTable();

  publishSyncEvent({
    type: 'SPLIT_UPDATE',
    deviceId: state.deviceId,
    name: state.deviceName,
    distance: currentDistance,
    targetDistance: state.targetDistance,
    splitMs: splitMs,
    totalMs: totalElapsedMs,
    splitsHistory: state.splits.map(s => ({ d: s.distance, ms: s.splitMs, tot: s.totalMs })),
    finished: isFinished,
    corrected: false
  });
}

function recalculateSplitsCascade() {
  for (let i = 0; i < state.splits.length; i++) {
    const prevTotal = i === 0 ? 0 : state.splits[i - 1].totalMs;
    state.splits[i].splitMs = state.splits[i].totalMs - prevTotal;
  }
  if (state.splits.length > 0) {
    const last = state.splits[state.splits.length - 1];
    if (state.raceStatus === 'finished') {
      const formatted = formatMs(last.totalMs);
      document.getElementById('mainTimerDisplay').textContent = formatted;
      document.getElementById('syncLocalTimerDisplay').textContent = formatted;
    }
    publishSyncEvent({
      type: 'SPLIT_UPDATE',
      deviceId: state.deviceId,
      name: state.deviceName,
      distance: last.distance,
      targetDistance: state.targetDistance,
      splitMs: last.splitMs,
      totalMs: last.totalMs,
      splitsHistory: state.splits.map(s => ({ d: s.distance, ms: s.splitMs, tot: s.totalMs })),
      finished: state.raceStatus === 'finished',
      corrected: true
    });
  }
}

function renderSplitsTable() {
  const empty = document.getElementById('splitsEmptyState');
  const container = document.getElementById('splitsListContainer');

  if (state.splits.length === 0) {
    empty.classList.remove('hidden');
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  empty.classList.add('hidden');
  container.classList.remove('hidden');
  container.innerHTML = '';

  state.splits.forEach((sp, idx) => {
    const frameObj = sp.frames[sp.selectedFrameIdx] || null;
    const thumbUrl = frameObj ? frameObj.dataUrl : '';
    const isFinish = sp.distance === state.targetDistance;

    const row = document.createElement('div');
    row.className = 'bg-slate-950 border border-slate-800 rounded-2xl p-3 flex items-center justify-between gap-3';
    row.innerHTML = `
      <div class="flex items-center gap-3">
        ${thumbUrl ? `<img src="${thumbUrl}" class="w-16 h-12 object-cover rounded-xl border border-slate-700" alt="Frame" />` : ''}
        <div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-black px-2 py-0.5 rounded-md uppercase ${isFinish ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300'}">
              ${isFinish ? t('finishBadge') : t('turnBadge')} ${sp.distance}m
            </span>
            ${sp.corrected ? `<span class="text-[10px] font-bold text-amber-400 uppercase">${t('correctedBadge')}</span>` : ''}
          </div>
          <div class="text-xl font-black text-white tabular-nums mt-0.5">
            ${formatMs(sp.totalMs)}
            <span class="text-xs font-semibold text-slate-400 ml-1.5">(50m: ${formatMs(sp.splitMs)})</span>
          </div>
        </div>
      </div>

      <button data-split-idx="${idx}" class="open-editor-btn px-3 py-2.5 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 text-xs font-extrabold uppercase">
        ${t('frameBtn')}
      </button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.open-editor-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-split-idx'));
      openFrameEditorModal(state.splits[idx], 'race');
    });
  });
}

// Start Sequence Logic
let startTimers = [];
function clearStartTimers() {
  state.sequenceActive = false;
  state.seqStage = 'none';
  startTimers.forEach(timerId => {
    clearTimeout(timerId);
    clearInterval(timerId);
  });
  startTimers = [];
}

function showMarksScreenManual() {
  clearStartTimers();
  const overlay = document.getElementById('startOverlay');
  const statusEl = document.getElementById('overlayStatus');
  const countEl = document.getElementById('overlayCountdown');
  const hintEl = document.getElementById('overlayHint');
  document.getElementById('coachWhistleBarWrap').classList.add('hidden');

  overlay.className = 'fixed inset-0 z-50 flex flex-col items-center justify-center p-6 text-center bg-amber-400 text-slate-950';
  statusEl.textContent = t('takeYourMarks');
  countEl.textContent = '---';
  hintEl.textContent = t('swimmerWaitHint');
}

function triggerGreenStartNow() {
  clearStartTimers();
  const overlay = document.getElementById('startOverlay');
  const statusEl = document.getElementById('overlayStatus');
  const countEl = document.getElementById('overlayCountdown');
  const hintEl = document.getElementById('overlayHint');
  document.getElementById('coachWhistleBarWrap').classList.add('hidden');

  overlay.className = 'fixed inset-0 z-50 flex flex-col items-center justify-center p-6 text-center bg-emerald-500 text-slate-950';
  statusEl.textContent = 'START!';
  countEl.textContent = 'GO!';
  hintEl.textContent = '00:00.00';

  flashStartTorchPulse();

  const now = performance.now();
  state.startTimeMs = now;
  state.armAtTimeMs = now + state.deadTimeSeconds * 1000;
  state.raceStatus = 'running_dead';
  state.splits = [];
  state.ringBuffer = [];
  renderSplitsTable();

  document.getElementById('manualSplitBtn').disabled = false;
  updateSensorStatusUI('dead');

  startTimers.push(setTimeout(() => {
    overlay.classList.add('hidden');
  }, 850));
}

function updateScheduledStartSequence() {
  if (!state.sequenceActive) return;

  const localNow = Date.now();
  const overlay = document.getElementById('startOverlay');
  const roleBadge = document.getElementById('overlayRoleBadge');
  const statusEl = document.getElementById('overlayStatus');
  const countEl = document.getElementById('overlayCountdown');
  const hintEl = document.getElementById('overlayHint');
  const whistleBarWrap = document.getElementById('coachWhistleBarWrap');
  const whistleBar = document.getElementById('coachWhistleBar');

  const isCoach = (state.role === 'coach');
  roleBadge.textContent = isCoach ? t('coachViewBadge') : t('swimmerViewBadge');

  if (localNow < state.seqMarksAtLocalMs) {
    if (state.seqStage !== 'prep') {
      state.seqStage = 'prep';
      overlay.className = 'fixed inset-0 z-50 flex flex-col items-center justify-center p-6 text-center bg-slate-950 text-white';
      statusEl.textContent = t('getPosition');
      whistleBarWrap.classList.add('hidden');
    }
    const leftToMarksSec = Math.max(0, (state.seqMarksAtLocalMs - localNow) / 1000);
    if (isCoach) {
      const leftToWhistleSec = Math.max(0, (state.seqGoAtLocalMs - localNow) / 1000);
      countEl.textContent = leftToMarksSec.toFixed(1) + 's';
      hintEl.textContent = `Marks in ${leftToMarksSec.toFixed(1)} s • Whistle (GO) in ${leftToWhistleSec.toFixed(1)} s`;
    } else {
      countEl.textContent = Math.ceil(leftToMarksSec);
      hintEl.textContent = t('swimmerWaitHint');
    }
    return;
  }

  if (localNow >= state.seqMarksAtLocalMs && localNow < state.seqGoAtLocalMs) {
    if (state.seqStage !== 'marks') {
      state.seqStage = 'marks';
      overlay.className = 'fixed inset-0 z-50 flex flex-col items-center justify-center p-6 text-center bg-amber-400 text-slate-950';
      statusEl.textContent = t('takeYourMarks');
    }
    const leftToGoMs = Math.max(0, state.seqGoAtLocalMs - localNow);
    const totalHoldMs = Math.max(100, state.seqGoAtLocalMs - state.seqMarksAtLocalMs);

    if (isCoach) {
      whistleBarWrap.classList.remove('hidden');
      whistleBar.style.width = `${(leftToGoMs / totalHoldMs) * 100}%`;
      countEl.textContent = (leftToGoMs / 1000).toFixed(2) + ' s';
      hintEl.textContent = t('coachWhistleHint');
    } else {
      whistleBarWrap.classList.add('hidden');
      countEl.textContent = '---';
      hintEl.textContent = t('swimmerWaitHint');
    }
    return;
  }

  if (localNow >= state.seqGoAtLocalMs && state.seqStage !== 'go') {
    state.seqStage = 'go';
    state.sequenceActive = false;
    whistleBarWrap.classList.add('hidden');
    triggerGreenStartNow();
  }
}

function scheduleLocalExactSequence(marksAtLocalMs, goAtLocalMs) {
  clearStartTimers();
  state.splits = [];
  renderSplitsTable();
  state.seqMarksAtLocalMs = marksAtLocalMs;
  state.seqGoAtLocalMs = goAtLocalMs;
  state.seqStage = 'none';
  state.sequenceActive = true;
  updateScheduledStartSequence();
}

function startLocalOrSoloSequence() {
  const nowLocal = Date.now();
  const prepMs = state.prepTimeSeconds * 1000;
  const holdMs = 1500 + Math.floor(Math.random() * 650);
  scheduleLocalExactSequence(nowLocal + prepMs, nowLocal + prepMs + holdMs);
}

// Register callbacks for sync module
registerSyncCallbacks({
  applyTargetDistanceUI,
  updatePrepAndDistanceLabels,
  clearStartTimers,
  setCameraTorch,
  showMarksScreenManual,
  scheduleLocalExactSequence
});

// Lap Counter
function recordLapTurn(nowPerf) {
  const stepMeters = Number(document.getElementById('lapStepSelect').value);
  state.lapMeters += stepMeters;
  state.lapArmAtMs = nowPerf + state.deadTimeSeconds * 1000;

  const capturedFrames = state.ringBuffer.map(f => ({ ...f }));
  const aiIdx = Math.max(0, capturedFrames.length - 1);

  const lapEvent = {
    distance: state.lapMeters,
    totalMs: nowPerf - state.lapStartMs,
    frames: capturedFrames,
    selectedFrameIdx: aiIdx,
    aiFrameIdx: aiIdx,
    corrected: false
  };
  state.lapEvents.unshift(lapEvent);
  appendPostTriggerFrames(lapEvent, 10);

  document.getElementById('lapMetersDisplay').textContent = state.lapMeters;
  document.getElementById('lapCountDisplay').textContent = state.lapMeters / 25;
  renderLapHistory();
}

function renderLapHistory() {
  const list = document.getElementById('lapHistoryList');
  list.innerHTML = '';
  state.lapEvents.forEach((ev, idx) => {
    const row = document.createElement('div');
    row.className = 'bg-slate-950 border border-slate-800 rounded-2xl px-3.5 py-2.5 flex items-center justify-between text-xs';
    row.innerHTML = `
      <div>
        <strong class="text-emerald-400 text-sm font-black">${ev.distance} m</strong>
        <span class="text-slate-400 ml-2">${t('timeLabel')} <strong class="text-white tabular-nums">${formatMs(ev.totalMs)}</strong></span>
        ${ev.corrected ? `<span class="text-amber-400 ml-2 font-bold uppercase">${t('correctedBadge')}</span>` : ''}
      </div>
      <button data-lap-idx="${idx}" class="lap-edit-btn px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sky-300 font-bold uppercase">
        ${t('frameBtn')}
      </button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.lap-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-lap-idx'));
      openFrameEditorModal(state.lapEvents[i], 'lap');
    });
  });
}

// Main 60FPS Loop
function mainLoop() {
  const now = performance.now();

  if (state.sequenceActive) {
    updateScheduledStartSequence();
  }

  if (state.raceStatus === 'running_dead' || state.raceStatus === 'running_armed') {
    const elapsed = now - state.startTimeMs;
    const formatted = formatMs(elapsed);
    document.getElementById('mainTimerDisplay').textContent = formatted;
    document.getElementById('syncLocalTimerDisplay').textContent = formatted;

    if (state.raceStatus === 'running_dead') {
      const leftSec = (state.armAtTimeMs - now) / 1000;
      if (leftSec <= 0) {
        state.raceStatus = 'running_armed';
        document.getElementById('deadZoneCountdownBar').classList.add('hidden');
        updateSensorStatusUI('armed');
      } else {
        document.getElementById('deadZoneCountdownBar').classList.remove('hidden');
        document.getElementById('deadZoneSecLeft').textContent = leftSec.toFixed(1);
      }
    }
  }

  if (state.lapActive) {
    const lapElapsed = now - state.lapStartMs;
    document.getElementById('lapTotalTimeDisplay').textContent = formatMs(lapElapsed);
  }

  if (state.role !== 'coach' && video.readyState >= 2 && video.videoWidth > 0) {
    if (canvas.width !== 320) {
      canvas.width = 320;
      canvas.height = 180;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const roiYRatio = state.roiYPercent / 100;
    const roiHRatio = state.roiHPercent / 100;
    const roiX = 0;
    const roiY = Math.floor(canvas.height * roiYRatio);
    const roiW = canvas.width;
    const roiH = Math.min(canvas.height - roiY, Math.floor(canvas.height * roiHRatio));

    const imgData = ctx.getImageData(roiX, roiY, roiW, roiH);
    const data = imgData.data;
    let matchingPixels = 0;
    const totalSampled = data.length / 16;

    for (let i = 0; i < data.length; i += 16) {
      if (isSkinOrCapPixel(data[i], data[i + 1], data[i + 2])) {
        matchingPixels++;
      }
    }

    const skinPercent = (matchingPixels / totalSampled) * 100;
    document.getElementById('skinPercentLabel').textContent = `${skinPercent.toFixed(1)}%`;
    document.getElementById('skinProgressBar').style.width = `${Math.min(100, (skinPercent / state.skinThreshold) * 100)}%`;

    const isArmed =
      ((state.activeTab === 'timer' || state.activeTab === 'sync') && state.raceStatus === 'running_armed') ||
      (state.activeTab === 'lap' && state.lapActive && now >= state.lapArmAtMs);

    ctx.strokeStyle = isArmed
      ? (skinPercent >= state.skinThreshold ? '#10b981' : '#facc15')
      : '#38bdf8';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, roiY, roiW - 4, roiH);

    captureFrameToRingBuffer(now, skinPercent, roiYRatio, roiHRatio);

    if (skinPercent >= state.skinThreshold) {
      if ((state.activeTab === 'timer' || state.activeTab === 'sync') && state.raceStatus === 'running_armed') {
        recordRaceSplitOrFinish(now);
      } else if (state.activeTab === 'lap' && state.lapActive && now >= state.lapArmAtMs) {
        recordLapTurn(now);
      }
    }
  }

  requestAnimationFrame(mainLoop);
}

// Event Listeners
document.getElementById('prepTimeSlider').value = state.prepTimeSeconds;
document.getElementById('prepTimeVal').textContent = `${state.prepTimeSeconds} s`;

document.getElementById('enableTorchCheckbox').addEventListener('change', (e) => {
  state.torchEnabled = e.target.checked;
  document.getElementById('torchBadge').textContent = state.torchEnabled ? 'LED: ON' : 'LED: OFF';
});

document.getElementById('testTorchBtn').addEventListener('click', () => {
  flashStartTorchPulse();
});

document.getElementById('switchCameraBtn').addEventListener('click', () => {
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  initCamera();
});

document.getElementById('videoUploadInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(tr => tr.stop());
    video.srcObject = null;
  }
  video.src = URL.createObjectURL(file);
  video.loop = true;
  video.muted = true;
  video.play();
  document.getElementById('settingsModal').classList.add('hidden');
});

document.getElementById('startProcedureBtn').addEventListener('click', () => {
  startLocalOrSoloSequence();
});

document.getElementById('cancelStartBtn').addEventListener('click', () => {
  clearStartTimers();
  setCameraTorch(false);
  document.getElementById('startOverlay').classList.add('hidden');
  state.raceStatus = 'idle';
  if (state.mqttClient && state.mqttClient.connected) {
    publishSyncEvent({ type: 'CANCEL_START' });
  }
});

document.getElementById('connectSyncRoomBtn').addEventListener('click', connectToSyncRoom);

document.getElementById('coachMarksBtn').addEventListener('click', () => {
  if (state.mqttClient && state.mqttClient.connected) {
    publishSyncEvent({ type: 'COACH_MARKS', distance: state.targetDistance });
  } else {
    showMarksScreenManual();
  }
});

document.getElementById('coachGoBtn').addEventListener('click', () => {
  if (state.mqttClient && state.mqttClient.connected) {
    const nowSender = Date.now();
    publishSyncEvent({
      type: 'COACH_SCHEDULED_GO',
      senderId: state.deviceId,
      senderNowMs: nowSender,
      goAtSenderMs: nowSender + 280,
      distance: state.targetDistance
    });
  } else {
    triggerGreenStartNow();
  }
});

document.getElementById('coachAutoSequenceBtn').addEventListener('click', () => {
  const sharedHoldMs = 1550 + Math.floor(Math.random() * 650);
  if (state.mqttClient && state.mqttClient.connected) {
    const nowSender = Date.now();
    const prepMs = state.prepTimeSeconds * 1000;
    const marksAtSenderMs = nowSender + prepMs;
    const goAtSenderMs = marksAtSenderMs + sharedHoldMs;

    publishSyncEvent({
      type: 'COACH_AUTO_SEQ',
      senderId: state.deviceId,
      senderNowMs: nowSender,
      marksAtSenderMs: marksAtSenderMs,
      goAtSenderMs: goAtSenderMs,
      prepTimeSeconds: state.prepTimeSeconds,
      holdMs: sharedHoldMs,
      distance: state.targetDistance
    });
  } else {
    startLocalOrSoloSequence();
  }
});

document.getElementById('clearRoomBoardBtn').addEventListener('click', () => {
  state.remoteSwimmers = {};
  renderMultiSwimmersBoard();
});

function switchMainTab(tab) {
  state.activeTab = tab;
  document.getElementById('viewTimer').classList.toggle('hidden', tab !== 'timer');
  document.getElementById('viewLapCounter').classList.toggle('hidden', tab !== 'lap');
  document.getElementById('viewMultiSync').classList.toggle('hidden', tab !== 'sync');

  const activeCls = 'py-2.5 rounded-xl bg-sky-500 text-slate-950 font-black text-xs uppercase tracking-wider transition';
  const idleCls = 'py-2.5 rounded-xl text-slate-400 hover:text-white font-bold text-xs uppercase tracking-wider transition';

  document.getElementById('navTimerBtn').className = tab === 'timer' ? activeCls : idleCls;
  document.getElementById('navLapBtn').className = tab === 'lap' ? activeCls : idleCls;
  document.getElementById('navSyncBtn').className = tab === 'sync' ? activeCls : idleCls;
}

document.getElementById('navTimerBtn').addEventListener('click', () => switchMainTab('timer'));
document.getElementById('navLapBtn').addEventListener('click', () => switchMainTab('lap'));
document.getElementById('navSyncBtn').addEventListener('click', () => switchMainTab('sync'));
document.getElementById('goToOwnSplitsBtn').addEventListener('click', () => switchMainTab('timer'));

document.getElementById('roleSwimmerBtn').addEventListener('click', () => {
  state.role = 'swimmer';
  document.getElementById('cameraCard').classList.remove('hidden');
  document.getElementById('roleSwimmerBtn').className = 'py-3 rounded-xl text-xs font-black uppercase tracking-wider bg-sky-500 text-slate-950 transition';
  document.getElementById('roleCoachBtn').className = 'py-3 rounded-xl text-xs font-black uppercase tracking-wider text-slate-400 hover:text-white transition';
  document.getElementById('roleDescriptionText').textContent = t('swimmerDesc');
});

document.getElementById('roleCoachBtn').addEventListener('click', () => {
  state.role = 'coach';
  document.getElementById('cameraCard').classList.add('hidden');
  document.getElementById('roleCoachBtn').className = 'py-3 rounded-xl text-xs font-black uppercase tracking-wider bg-indigo-500 text-white transition';
  document.getElementById('roleSwimmerBtn').className = 'py-3 rounded-xl text-xs font-black uppercase tracking-wider text-slate-400 hover:text-white transition';
  document.getElementById('roleDescriptionText').textContent = t('coachDesc');
});

document.getElementById('forceArmBtn').addEventListener('click', () => {
  const now = performance.now();
  document.getElementById('settingsModal').classList.add('hidden');
  if (state.activeTab === 'lap') {
    if (!state.lapActive) {
      state.lapActive = true;
      state.lapStartMs = now - 25000;
    }
    state.lapArmAtMs = now;
  } else {
    if (state.raceStatus === 'idle' || state.raceStatus === 'finished') {
      state.startTimeMs = now - 26400;
      state.splits = [];
      renderSplitsTable();
    }
    state.raceStatus = 'running_armed';
    document.getElementById('deadZoneCountdownBar').classList.add('hidden');
    document.getElementById('manualSplitBtn').disabled = false;
  }
  updateSensorStatusUI('armed');
});

document.getElementById('manualSplitBtn').addEventListener('click', () => {
  if (state.raceStatus === 'running_dead' || state.raceStatus === 'running_armed') {
    recordRaceSplitOrFinish(performance.now());
  }
});

document.getElementById('resetRaceBtn').addEventListener('click', () => {
  state.raceStatus = 'idle';
  state.splits = [];
  document.getElementById('mainTimerDisplay').textContent = '00:00.00';
  document.getElementById('syncLocalTimerDisplay').textContent = '00:00.00';
  document.getElementById('deadZoneCountdownBar').classList.add('hidden');
  document.getElementById('manualSplitBtn').disabled = true;
  updateSensorStatusUI('idle');
  renderSplitsTable();
});

document.getElementById('startLapSessionBtn').addEventListener('click', () => {
  const now = performance.now();
  state.lapActive = true;
  state.lapStartMs = now;
  state.lapArmAtMs = now + state.deadTimeSeconds * 1000;
  updateSensorStatusUI('dead');
});

document.getElementById('resetLapSessionBtn').addEventListener('click', () => {
  state.lapActive = false;
  state.lapMeters = 0;
  state.lapEvents = [];
  document.getElementById('lapMetersDisplay').textContent = '0';
  document.getElementById('lapCountDisplay').textContent = '0';
  document.getElementById('lapTotalTimeDisplay').textContent = '00:00.00';
  renderLapHistory();
  updateSensorStatusUI('idle');
});

document.getElementById('openSettingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.remove('hidden');
});
document.getElementById('closeSettingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.add('hidden');
});
document.getElementById('doneSettingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.add('hidden');
});

document.querySelectorAll('.dist-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const chosen = Number(btn.getAttribute('data-dist'));
    applyTargetDistanceUI(chosen, true);
  });
});

document.getElementById('prepTimeSlider').addEventListener('input', (e) => {
  state.prepTimeSeconds = Number(e.target.value);
  localStorage.setItem('swimtimer_prep_sec', String(state.prepTimeSeconds));
  document.getElementById('prepTimeVal').textContent = `${state.prepTimeSeconds} s`;
  updatePrepAndDistanceLabels();
  if (state.mqttClient && state.mqttClient.connected) {
    publishSyncEvent({ type: 'SET_CONFIG', distance: state.targetDistance, prepTimeSeconds: state.prepTimeSeconds });
  }
});

document.getElementById('roiYSlider').addEventListener('input', (e) => {
  state.roiYPercent = Number(e.target.value);
  document.getElementById('roiYVal').textContent = `${state.roiYPercent}%`;
});

document.getElementById('roiHSlider').addEventListener('input', (e) => {
  state.roiHPercent = Number(e.target.value);
  document.getElementById('roiHVal').textContent = `${state.roiHPercent}%`;
});

document.getElementById('threshSlider').addEventListener('input', (e) => {
  state.skinThreshold = Number(e.target.value);
  document.getElementById('threshVal').textContent = `${state.skinThreshold.toFixed(1)}%`;
  document.getElementById('thresholdValueLabel').textContent = `${state.skinThreshold.toFixed(1)}%`;
});

document.getElementById('deadTimeSlider').addEventListener('input', (e) => {
  state.deadTimeSeconds = Number(e.target.value);
  document.getElementById('deadTimeVal').textContent = `${state.deadTimeSeconds} s`;
});

// Initialize app
applyLanguageUI();
initCamera();
requestAnimationFrame(mainLoop);
