import { state } from './state.js';

export const video = document.getElementById('cameraVideo');
export const canvas = document.getElementById('overlayCanvas');
export const ctx = canvas.getContext('2d', { willReadFrequently: true });

const snapCanvas = document.createElement('canvas');
snapCanvas.width = 480;
snapCanvas.height = 320;
const snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });

export async function setCameraTorch(turnOn) {
  if (!state.torchEnabled) return false;
  try {
    if (!video.srcObject) return false;
    const track = video.srcObject.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function') return false;
    const caps = track.getCapabilities();
    if (!caps.torch) return false;
    await track.applyConstraints({ advanced: [{ torch: Boolean(turnOn) }] });
    return true;
  } catch (e) {
    return false;
  }
}

export async function flashStartTorchPulse() {
  if (!state.torchEnabled) return;
  const ok = await setCameraTorch(true);
  if (!ok) return;
  setTimeout(() => setCameraTorch(false), 180);
  setTimeout(() => setCameraTorch(true), 270);
  setTimeout(() => setCameraTorch(false), 450);
  setTimeout(() => setCameraTorch(true), 540);
  setTimeout(() => setCameraTorch(false), 780);
}

export async function initCamera() {
  try {
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(tr => tr.stop());
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: state.facingMode,
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });
    video.srcObject = stream;
    video.loop = false;
    await video.play();

    const track = stream.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === 'function') {
      const caps = track.getCapabilities();
      state.torchSupported = Boolean(caps && caps.torch);
      const torchBadge = document.getElementById('torchBadge');
      if (state.torchSupported) {
        torchBadge.textContent = state.torchEnabled ? 'LED: Ready' : 'LED: OFF';
        torchBadge.className = 'bg-emerald-950/90 backdrop-blur px-2.5 py-1 rounded-lg border border-emerald-600/40 text-[10px] font-bold text-emerald-300 uppercase';
      } else {
        torchBadge.textContent = 'LED: N/A';
      }
    }
  } catch (err) {
    document.getElementById('sensorStateText').textContent = 'No camera – upload test video in Settings';
  }
}

export function isSkinOrCapPixel(r, g, b) {
  if (b > r + 15 && b > g) return false;
  if (r > 215 && g > 215 && b > 215) return false;
  const isWarmSkin = (r > 95 && g > 40 && b > 20 && r > g && r > b && (r - Math.min(g, b)) > 22);
  const isPinkOrRedCap = (r > 150 && r > g + 35 && b > 80);
  return isWarmSkin || isPinkOrRedCap;
}

export function captureFrameToRingBuffer(nowPerf, skinPercentage, roiYRatio, roiHRatio) {
  if (nowPerf - state.lastBufferedAtMs < state.bufferIntervalMs) return;
  if (video.readyState < 2) return;

  state.lastBufferedAtMs = nowPerf;
  snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
  const roiY = Math.floor(snapCanvas.height * roiYRatio);
  const roiH = Math.floor(snapCanvas.height * roiHRatio);

  snapCtx.strokeStyle = '#38bdf8';
  snapCtx.lineWidth = 3;
  snapCtx.strokeRect(1, roiY, snapCanvas.width - 2, roiH);

  let raceElapsedMs = 0;
  if (state.raceStatus === 'running_dead' || state.raceStatus === 'running_armed') {
    raceElapsedMs = nowPerf - state.startTimeMs;
  } else if (state.lapActive) {
    raceElapsedMs = nowPerf - state.lapStartMs;
  }

  state.ringBuffer.push({
    dataUrl: snapCanvas.toDataURL('image/jpeg', 0.65),
    perfMs: nowPerf,
    elapsedMs: raceElapsedMs,
    skinScore: Number(skinPercentage.toFixed(1))
  });

  if (state.ringBuffer.length > state.maxRingFrames) {
    state.ringBuffer.shift();
  }

  document.getElementById('bufferStatusBadge').textContent = `Buffer: ${state.ringBuffer.length} fr.`;
}

export function appendPostTriggerFrames(eventObject, framesToCollect = 10) {
  let collected = 0;
  const interval = setInterval(() => {
    if (video.readyState >= 2 && collected < framesToCollect) {
      const nowPerf = performance.now();
      const roiYRatio = state.roiYPercent / 100;
      const roiHRatio = state.roiHPercent / 100;
      snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
      const roiY = Math.floor(snapCanvas.height * roiYRatio);
      const roiH = Math.floor(snapCanvas.height * roiHRatio);
      snapCtx.strokeStyle = '#38bdf8';
      snapCtx.lineWidth = 3;
      snapCtx.strokeRect(1, roiY, snapCanvas.width - 2, roiH);

      const baseStart = state.activeTab === 'lap' ? state.lapStartMs : state.startTimeMs;
      eventObject.frames.push({
        dataUrl: snapCanvas.toDataURL('image/jpeg', 0.65),
        perfMs: nowPerf,
        elapsedMs: Math.max(0, nowPerf - baseStart),
        skinScore: 0
      });
      collected++;
    } else {
      clearInterval(interval);
    }
  }, 55);
}
