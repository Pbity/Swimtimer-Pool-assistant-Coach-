import { state, t, formatMs } from './state.js';

let syncCallbacks = {
  applyTargetDistanceUI: () => {},
  updatePrepAndDistanceLabels: () => {},
  clearStartTimers: () => {},
  setCameraTorch: () => {},
  showMarksScreenManual: () => {},
  scheduleLocalExactSequence: () => {}
};

export function registerSyncCallbacks(cbs) {
  syncCallbacks = { ...syncCallbacks, ...cbs };
}

export function publishSyncEvent(payload) {
  if (!state.mqttClient || !state.mqttClient.connected || !state.roomCode) return;
  const topic = `swimtimer_poc_v10/room_${state.roomCode}`;
  state.mqttClient.publish(topic, JSON.stringify(payload));
}

export function sendClockPingBurst() {
  if (!state.mqttClient || !state.mqttClient.connected) return;
  for (let i = 0; i < 4; i++) {
    setTimeout(() => {
      publishSyncEvent({
        type: 'CLOCK_PING',
        senderId: state.deviceId,
        t0: Date.now()
      });
    }, i * 180);
  }
}

export function convertSenderTimeToLocalMs(senderId, targetSenderMs, senderCurrentMsFallback) {
  if (senderId === state.deviceId) {
    return targetSenderMs;
  }
  const peer = state.peerOffsets[senderId];
  if (peer && typeof peer.offsetMs === 'number') {
    return targetSenderMs - peer.offsetMs;
  }
  const deltaFromSenderNow = targetSenderMs - (senderCurrentMsFallback || targetSenderMs);
  return Date.now() + deltaFromSenderNow;
}

export function connectToSyncRoom() {
  const code = document.getElementById('syncRoomCodeInput').value.trim().toUpperCase();
  const name = document.getElementById('syncSwimmerNameInput').value.trim() || 'Lane 1';
  if (!code) return;

  state.roomCode = code;
  state.deviceName = name;
  state.peerOffsets = {};

  const statusLabel = document.getElementById('syncConnectionLabel');
  statusLabel.textContent = `Connecting to #${code}...`;
  statusLabel.className = 'text-amber-400 font-bold';

  if (state.mqttClient) {
    state.mqttClient.end(true);
  }

  const topic = `swimtimer_poc_v10/room_${code}`;
  const client = window.mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
    clientId: state.deviceId + '_' + Math.floor(Math.random() * 1000),
    clean: true,
    connectTimeout: 5000
  });

  state.mqttClient = client;

  client.on('connect', () => {
    client.subscribe(topic);
    statusLabel.textContent = `Connected: Room #${code} (${state.deviceName})`;
    statusLabel.className = 'text-emerald-400 font-bold';

    const badge = document.getElementById('syncHeaderBadge');
    badge.textContent = `Room: ${code}`;
    badge.classList.remove('hidden');

    publishSyncEvent({
      type: 'PRESENCE',
      deviceId: state.deviceId,
      name: state.deviceName,
      role: state.role,
      distance: state.targetDistance,
      prepTimeSeconds: state.prepTimeSeconds
    });

    sendClockPingBurst();
  });

  client.on('message', (topicName, payload) => {
    try {
      const msg = JSON.parse(payload.toString());
      handleIncomingSyncMessage(msg);
    } catch (e) {}
  });
}

function handleIncomingSyncMessage(msg) {
  if (msg.type === 'CLOCK_PING' && msg.senderId !== state.deviceId) {
    publishSyncEvent({
      type: 'CLOCK_PONG',
      targetId: msg.senderId,
      responderId: state.deviceId,
      t0: msg.t0,
      t1: Date.now()
    });
    return;
  }

  if (msg.type === 'CLOCK_PONG' && msg.targetId === state.deviceId && msg.responderId) {
    const t2 = Date.now();
    const rtt = t2 - msg.t0;
    const peerId = msg.responderId;
    const existing = state.peerOffsets[peerId];

    if (rtt >= 0 && (!existing || rtt < existing.bestRtt)) {
      const estimatedResponderNow = msg.t1 + rtt / 2;
      const offsetToResponder = estimatedResponderNow - t2;
      state.peerOffsets[peerId] = {
        offsetMs: offsetToResponder,
        bestRtt: rtt
      };
      const syncedCount = Object.keys(state.peerOffsets).length;
      document.getElementById('syncLatencyLabel').textContent =
        `Synced: ${syncedCount} dev (${Math.round(rtt)}ms)`;
    }
    return;
  }

  if (msg.type === 'PRESENCE') {
    const isNew = !state.remoteSwimmers[msg.deviceId];
    state.remoteSwimmers[msg.deviceId] = {
      name: msg.name,
      role: msg.role,
      status: 'Ready',
      distance: 0,
      targetDistance: msg.distance || state.targetDistance,
      splitMs: 0,
      totalMs: 0,
      splitsHistory: [],
      finished: false
    };
    renderMultiSwimmersBoard();

    if (msg.deviceId !== state.deviceId && isNew) {
      publishSyncEvent({
        type: 'PRESENCE',
        deviceId: state.deviceId,
        name: state.deviceName,
        role: state.role,
        distance: state.targetDistance,
        prepTimeSeconds: state.prepTimeSeconds
      });
      sendClockPingBurst();
    }
  } else if (msg.type === 'SET_CONFIG') {
    if (msg.distance) syncCallbacks.applyTargetDistanceUI(msg.distance, false);
    if (msg.prepTimeSeconds) {
      state.prepTimeSeconds = Number(msg.prepTimeSeconds);
      document.getElementById('prepTimeSlider').value = state.prepTimeSeconds;
      document.getElementById('prepTimeVal').textContent = `${state.prepTimeSeconds} s`;
      syncCallbacks.updatePrepAndDistanceLabels();
    }
  } else if (msg.type === 'CANCEL_START') {
    syncCallbacks.clearStartTimers();
    syncCallbacks.setCameraTorch(false);
    document.getElementById('startOverlay').classList.add('hidden');
    state.raceStatus = 'idle';
  } else if (msg.type === 'COACH_MARKS') {
    if (msg.distance) syncCallbacks.applyTargetDistanceUI(msg.distance, false);
    syncCallbacks.showMarksScreenManual();
    Object.keys(state.remoteSwimmers).forEach(id => {
      state.remoteSwimmers[id].status = 'On marks...';
      state.remoteSwimmers[id].totalMs = 0;
      state.remoteSwimmers[id].distance = 0;
      state.remoteSwimmers[id].splitsHistory = [];
    });
    renderMultiSwimmersBoard();
  } else if (msg.type === 'COACH_SCHEDULED_GO') {
    if (msg.distance) syncCallbacks.applyTargetDistanceUI(msg.distance, false);
    const localGoMs = convertSenderTimeToLocalMs(msg.senderId, msg.goAtSenderMs, msg.senderNowMs);
    syncCallbacks.scheduleLocalExactSequence(Date.now() - 100, localGoMs);

    Object.keys(state.remoteSwimmers).forEach(id => {
      state.remoteSwimmers[id].status = `Swimming (${state.targetDistance}m)...`;
      state.remoteSwimmers[id].finished = false;
    });
    renderMultiSwimmersBoard();
  } else if (msg.type === 'COACH_AUTO_SEQ') {
    if (msg.distance) syncCallbacks.applyTargetDistanceUI(msg.distance, false);
    if (msg.prepTimeSeconds) {
      state.prepTimeSeconds = Number(msg.prepTimeSeconds);
      document.getElementById('prepTimeSlider').value = state.prepTimeSeconds;
      document.getElementById('prepTimeVal').textContent = `${state.prepTimeSeconds} s`;
      syncCallbacks.updatePrepAndDistanceLabels();
    }

    const localMarksMs = convertSenderTimeToLocalMs(msg.senderId, msg.marksAtSenderMs, msg.senderNowMs);
    const localGoMs = convertSenderTimeToLocalMs(msg.senderId, msg.goAtSenderMs, msg.senderNowMs);

    syncCallbacks.scheduleLocalExactSequence(localMarksMs, localGoMs);

    Object.keys(state.remoteSwimmers).forEach(id => {
      state.remoteSwimmers[id].status = `Countdown (${state.targetDistance}m)...`;
      state.remoteSwimmers[id].finished = false;
      state.remoteSwimmers[id].splitsHistory = [];
    });
    renderMultiSwimmersBoard();
  } else if (msg.type === 'SPLIT_UPDATE') {
    state.remoteSwimmers[msg.deviceId] = {
      name: msg.name,
      status: msg.finished ? `FINISHED (${msg.distance}m)` : `Turn ${msg.distance}/${msg.targetDistance || state.targetDistance}m`,
      distance: msg.distance,
      targetDistance: msg.targetDistance || state.targetDistance,
      splitMs: msg.splitMs,
      totalMs: msg.totalMs,
      splitsHistory: msg.splitsHistory || [],
      finished: msg.finished,
      corrected: msg.corrected
    };
    renderMultiSwimmersBoard();
  }
}

export function renderMultiSwimmersBoard() {
  const board = document.getElementById('multiSwimmersBoard');
  const entries = Object.values(state.remoteSwimmers);
  if (entries.length === 0) {
    board.innerHTML = `
      <div class="text-center py-4 text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
        ${t('boardEmpty')}
      </div>
    `;
    return;
  }

  entries.sort((a, b) => {
    if (a.finished && b.finished) return a.totalMs - b.totalMs;
    return b.distance - a.distance;
  });

  board.innerHTML = '';
  entries.forEach((sw) => {
    const splitsBadges = (sw.splitsHistory || []).map(s =>
      `<span class="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] text-slate-300 tabular-nums">${s.d}m: ${formatMs(s.ms)}</span>`
    ).join(' ');

    const item = document.createElement('div');
    item.className = 'bg-slate-950 border border-slate-800 rounded-2xl p-3 flex flex-col gap-1.5';
    item.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <div class="flex items-center gap-2">
            <strong class="text-sm font-black text-white uppercase">${sw.name}</strong>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase ${sw.finished ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-sky-300'}">
              ${sw.status}
            </span>
            ${sw.corrected ? `<span class="text-[10px] text-amber-400 font-bold uppercase">${t('correctedBadge')}</span>` : ''}
          </div>
        </div>
        <div class="text-xl font-black tabular-nums ${sw.finished ? 'text-emerald-400' : 'text-white'}">
          ${sw.totalMs > 0 ? formatMs(sw.totalMs) : '--:--.--'}
        </div>
      </div>
      ${splitsBadges ? `<div class="flex flex-wrap gap-1 pt-1 border-t border-slate-900">${splitsBadges}</div>` : ''}
    `;
    board.appendChild(item);
  });
}
