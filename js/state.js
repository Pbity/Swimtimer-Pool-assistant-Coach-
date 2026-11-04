import { I18N } from './i18n.js';

const savedPrepSec = Number(localStorage.getItem('swimtimer_prep_sec')) || 5;
const savedLang = localStorage.getItem('swimtimer_lang') || 'en';

export const state = {
  lang: savedLang,
  activeTab: 'timer',
  role: 'swimmer',
  targetDistance: 50,
  prepTimeSeconds: savedPrepSec,
  roiYPercent: 50,
  roiHPercent: 38,
  skinThreshold: 3.0,
  deadTimeSeconds: 18,
  torchEnabled: true,
  torchSupported: false,

  raceStatus: 'idle',
  startTimeMs: 0,
  armAtTimeMs: 0,
  splits: [],

  sequenceActive: false,
  seqMarksAtLocalMs: 0,
  seqGoAtLocalMs: 0,
  seqStage: 'none',

  lapActive: false,
  lapStartMs: 0,
  lapArmAtMs: 0,
  lapMeters: 0,
  lapEvents: [],

  ringBuffer: [],
  maxRingFrames: 45,
  lastBufferedAtMs: 0,
  bufferIntervalMs: 55,

  facingMode: 'environment',
  editingEventRef: null,

  mqttClient: null,
  roomCode: '',
  deviceName: 'Lane 1',
  deviceId: 'dev_' + Math.random().toString(36).substring(2, 8),
  peerOffsets: {},
  remoteSwimmers: {}
};

export function t(key) {
  return (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key;
}

export function formatMs(ms) {
  const clamped = Math.max(0, ms);
  const totalSec = clamped / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  const hundredths = Math.floor((clamped % 1000) / 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}
