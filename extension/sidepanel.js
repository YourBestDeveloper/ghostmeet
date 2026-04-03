const BACKEND_URL = '127.0.0.1:8877';

let ws = null;
let segmentCount = 0;
let startTime = null;
let durationTimer = null;

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const emptyStateEl = document.getElementById('empty-state');
const segmentCountEl = document.getElementById('segment-count');
const durationEl = document.getElementById('duration');
const btnClear = document.getElementById('btn-clear');
const btnCopy = document.getElementById('btn-copy');

// --- capture controls ---

const srcTabEl = document.getElementById('srcTab');
const srcMicEl = document.getElementById('srcMic');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
let localTabStream = null;
let localDisplayStream = null;
let localTabAudioCtx = null;
let localSocket = null;
let localRecorder = null;
let localSessionId = null;
let localPendingChunks = [];
let localDrainInFlight = null;
let localReconnectTimer = null;
let localReconnectAttempts = 0;
let localIsCapturing = false;
const LOCAL_MAX_QUEUE_CHUNKS = 60;

function triggerLocalDrain() {
  if (localDrainInFlight) return localDrainInFlight;
  localDrainInFlight = drainLocalQueue().finally(() => {
    localDrainInFlight = null;
  });
  return localDrainInFlight;
}

async function drainLocalQueue() {
  while (localPendingChunks.length > 0) {
    if (!localSocket || localSocket.readyState !== WebSocket.OPEN) break;
    const blob = localPendingChunks[0];
    let buf;
    try {
      buf = await blob.arrayBuffer();
    } catch (_) {
      localPendingChunks.shift();
      continue;
    }
    if (localSocket && localSocket.readyState === WebSocket.OPEN) {
      localPendingChunks.shift();
      try {
        localSocket.send(buf);
      } catch (_) {
        break;
      }
    } else {
      break;
    }
  }
}

function waitForSocketOpen(sock, timeoutMs = 2000) {
  if (!sock) return Promise.resolve(false);
  if (sock.readyState === WebSocket.OPEN) return Promise.resolve(true);
  if (sock.readyState !== WebSocket.CONNECTING) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sock.removeEventListener('open', onOpen);
      sock.removeEventListener('error', onDone);
      sock.removeEventListener('close', onDone);
      resolve(false);
    }, timeoutMs);
    const onOpen = () => {
      clearTimeout(timer);
      sock.removeEventListener('error', onDone);
      sock.removeEventListener('close', onDone);
      resolve(true);
    };
    const onDone = () => {
      clearTimeout(timer);
      sock.removeEventListener('open', onOpen);
      resolve(false);
    };
    sock.addEventListener('open', onOpen, { once: true });
    sock.addEventListener('error', onDone, { once: true });
    sock.addEventListener('close', onDone, { once: true });
  });
}

async function connectLocalSocket(sessionId) {
  const wsConn = new WebSocket(`ws://${BACKEND_URL}/ws/audio?session=${sessionId}`);
  localSocket = wsConn;
  wsConn.binaryType = 'arraybuffer';
  const opened = await waitForSocketOpen(wsConn, 3000);
  if (!opened) throw new Error('websocket connection failed');

  if (!localIsCapturing) {
    wsConn.close();
    if (localSocket === wsConn) localSocket = null;
    return;
  }

  localReconnectAttempts = 0;
  triggerLocalDrain();
  wsConn.addEventListener('close', () => {
    if (!localIsCapturing) return;
    scheduleLocalReconnect(sessionId);
  }, { once: true });
}

function scheduleLocalReconnect(sessionId) {
  const delay = Math.min(1000 * (2 ** localReconnectAttempts), 30000);
  localReconnectAttempts++;
  localReconnectTimer = setTimeout(async () => {
    if (!localIsCapturing) return;
    try {
      await connectLocalSocket(sessionId);
    } catch (_) {
      if (localIsCapturing) scheduleLocalReconnect(sessionId);
    }
  }, delay);
}

async function ensureLocalSocketForStop(sessionId) {
  if (localSocket?.readyState === WebSocket.OPEN) return true;
  if (localSocket?.readyState === WebSocket.CONNECTING) {
    const opened = await waitForSocketOpen(localSocket, 1500);
    if (opened) return true;
  }
  if (!sessionId) return false;
  try {
    const wsConn = new WebSocket(`ws://${BACKEND_URL}/ws/audio?session=${sessionId}`);
    localSocket = wsConn;
    wsConn.binaryType = 'arraybuffer';
    return await waitForSocketOpen(wsConn, 1500);
  } catch (_) {
    return false;
  }
}

function setCaptureState(state) {
  const sourceLocked = state === true || state === 'starting';
  srcTabEl.disabled = sourceLocked;
  srcMicEl.disabled = sourceLocked;
  btnStart.disabled = state === true || state === 'starting';
  btnStop.disabled = state !== true;
  if (state === 'starting') setStatus('connecting', 'starting...');
}

function newLocalSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function getCurrentCapturableTab() {
  const isCapturableUrl = (url) => {
    if (!url) return false;
    return /^(https?:\/\/|file:\/\/)/i.test(url);
  };

  const lastFocused = await chrome.windows.getLastFocused().catch(() => null);
  const focusedTabs = lastFocused?.id
    ? await chrome.tabs.query({ windowId: lastFocused.id })
    : [];
  const activeInFocused = focusedTabs.find((t) => t.active);

  // Prefer currently active capturable tab in focused window.
  let tab = activeInFocused && isCapturableUrl(activeInFocused.url) ? activeInFocused : null;

  // Fallback: most recently accessed capturable tab in focused window.
  if (!tab) {
    const candidates = focusedTabs
      .filter((t) => isCapturableUrl(t.url))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (candidates.length) tab = candidates[0];
  }

  // Last resort: any active capturable tab from other windows.
  if (!tab) {
    const activeTabs = await chrome.tabs.query({ active: true });
    tab = activeTabs.find((t) => isCapturableUrl(t.url)) || null;
  }

  // Diagnostic fallback for clearer user message.
  if (!tab) {
    tab = activeInFocused || focusedTabs[0] || null;
  }

  if (!tab?.id) throw new Error('no active tab found');
  if (!isCapturableUrl(tab.url)) {
    throw new Error(`cannot capture this tab (${tab.url || 'unknown url'}). switch to an http(s) tab`);
  }
  return tab;
}

async function startLocalTabOnlyCapture(sessionId) {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks.length) {
    displayStream.getTracks().forEach((t) => t.stop());
    throw new Error('selected tab has no audio. choose a tab and enable share audio');
  }
  localDisplayStream = displayStream;
  localTabAudioCtx = new AudioContext();
  await localTabAudioCtx.resume();
  const destination = localTabAudioCtx.createMediaStreamDestination();
  localTabAudioCtx.createMediaStreamSource(localDisplayStream).connect(destination);

  localTabStream = destination.stream;
  localIsCapturing = true;
  await connectLocalSocket(sessionId);

  localRecorder = new MediaRecorder(localTabStream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 128000,
  });
  localRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    if (localPendingChunks.length >= LOCAL_MAX_QUEUE_CHUNKS) {
      localPendingChunks.shift();
    }
    localPendingChunks.push(event.data);
    triggerLocalDrain();
  };
  localRecorder.start(1000);
}

async function stopLocalTabOnlyCapture() {
  localIsCapturing = false;
  if (localReconnectTimer) {
    clearTimeout(localReconnectTimer);
    localReconnectTimer = null;
  }

  if (localRecorder && localRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      localRecorder.onstop = resolve;
      localRecorder.stop();
    });
  }
  localRecorder = null;

  if (localTabStream) {
    localTabStream.getTracks().forEach((t) => t.stop());
    localTabStream = null;
  }
  if (localDisplayStream) {
    localDisplayStream.getTracks().forEach((t) => t.stop());
    localDisplayStream = null;
  }
  if (localTabAudioCtx) {
    localTabAudioCtx.close().catch(() => {});
    localTabAudioCtx = null;
  }

  const canFlush = await ensureLocalSocketForStop(localSessionId);
  if (canFlush && localSocket?.readyState === WebSocket.OPEN) {
    await triggerLocalDrain();
    try {
      localSocket.send('stop');
    } catch (_) {}
    try {
      localSocket.close();
    } catch (_) {}
  } else if (localSocket) {
    try {
      localSocket.close();
    } catch (_) {}
  }
  localSocket = null;
  localPendingChunks = [];
  localDrainInFlight = null;
  localReconnectAttempts = 0;
}

btnStart.addEventListener('click', async () => {
  if (btnStart.disabled) return;

  const source = srcTabEl.checked ? 'tab' : 'mic';
  const sources = { tab: source === 'tab', mic: source === 'mic' };
  if (!sources.tab && !sources.mic) {
    setStatus('disconnected', 'select at least one source');
    return;
  }

  // Always start from a clean state before requesting new capture.
  disconnect();
  setCaptureState('starting');
  setStatus('connecting', sources.mic ? 'opening mic permission flow...' : 'starting...');

  // Fast path: tab-only capture without getMediaStreamId/offscreen invocation.
  if (sources.tab && !sources.mic) {
    try {
      localSessionId = newLocalSessionId();
      setStatus('connecting', 'choose a tab in browser picker...');
      await startLocalTabOnlyCapture(localSessionId);
      await chrome.storage.local.set({ activeSessionId: localSessionId });
      setCaptureState(true);
      connectTranscript(localSessionId);
      return;
    } catch (e) {
      await stopLocalTabOnlyCapture();
      localSessionId = null;
      setCaptureState(false);
      setStatus('disconnected', e?.message || 'tab-only capture failed');
      await chrome.storage.local.remove('activeSessionId');
      return;
    }
  }

  let streamId;
  let targetTabId;
  if (sources.tab) {
    try {
      const targetTab = await getCurrentCapturableTab();
      targetTabId = targetTab.id;
    } catch (e) {
      setCaptureState(false);
      setStatus('disconnected', e?.message || 'failed to get tab stream id');
      return;
    }
  }

  const currentWindow = await chrome.windows.getCurrent().catch(() => null);
  const response = await chrome.runtime.sendMessage({
    action: 'start_capture',
    sources,
    streamId,
    targetTabId,
    requesterWindowId: currentWindow?.id,
  }).catch(() => null);
  if (!response || response.ok === false) {
    setCaptureState(false);
    setStatus('disconnected', response?.error || 'failed to start capture');
    chrome.storage.local.remove('activeSessionId');
  } else if (response.pending) {
    setStatus('connecting', 'waiting for microphone permission tab...');
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  if (localSessionId) {
    await stopLocalTabOnlyCapture();
    localSessionId = null;
    await chrome.storage.local.remove('activeSessionId');
    disconnect();
    setCaptureState(false);
    return;
  }
  await chrome.runtime.sendMessage({ action: 'stop_capture' });
  disconnect();
  setCaptureState(false);
});

// --- helpers ---

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatTimestamp(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function setStatus(state, label) {
  statusEl.textContent = label || state;
  statusEl.className = `status ${state}`;
}

function addSegment(seg) {
  emptyStateEl.classList.add('hidden');

  const div = document.createElement('div');
  div.className = 'segment new';

  const timeSpan = document.createElement('div');
  timeSpan.className = 'time';
  timeSpan.textContent = `${formatTimestamp(seg.start)} → ${formatTimestamp(seg.end)}`;

  const textSpan = document.createElement('div');
  textSpan.className = 'text';
  textSpan.textContent = seg.text;

  div.appendChild(timeSpan);
  div.appendChild(textSpan);
  transcriptEl.appendChild(div);

  // remove "new" highlight after a moment
  setTimeout(() => div.classList.remove('new'), 2000);

  // auto-scroll
  const container = document.getElementById('transcript-container');
  container.scrollTop = container.scrollHeight;

  segmentCount++;
  segmentCountEl.textContent = `${segmentCount} segment${segmentCount !== 1 ? 's' : ''}`;
}

function clearTranscript() {
  transcriptEl.innerHTML = '';
  segmentCount = 0;
  segmentCountEl.textContent = '0 segments';
  emptyStateEl.classList.remove('hidden');
}

// --- duration timer ---

function startDurationTimer() {
  stopDurationTimer();
  startTime = Date.now();
  durationTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    durationEl.textContent = formatTime(elapsed);
  }, 1000);
}

function stopDurationTimer() {
  if (durationTimer) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
}

// --- WebSocket connection ---

function connectTranscript(sessionId) {
  if (ws) {
    ws.close();
  }

  setStatus('connecting', 'connecting...');

  ws = new WebSocket(`ws://${BACKEND_URL}/ws/transcript/${sessionId}`);

  ws.onopen = () => {
    setStatus('connected', `live — ${sessionId}`);
    startDurationTimer();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'transcript' && data.segments) {
        for (const seg of data.segments) {
          addSegment(seg);
        }
      }
    } catch (e) {
      console.error('Failed to parse transcript message:', e);
    }
  };

  ws.onclose = () => {
    setStatus('disconnected', 'disconnected');
    stopDurationTimer();
  };

  ws.onerror = () => {
    setStatus('disconnected', 'connection error');
    stopDurationTimer();
  };
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  stopDurationTimer();
}

// --- listen for messages from background/popup ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'capture_error') {
    setCaptureState(false);
    setStatus('disconnected', message.error || 'capture failed');
    chrome.storage.local.remove('activeSessionId');
    disconnect();
    sendResponse({ ok: true });
  } else if (message.action === 'mic_permission_required') {
    setStatus('connecting', 'allow microphone in opened permission tab');
    sendResponse({ ok: true });
  } else if (message.action === 'capture_info') {
    setStatus('connecting', message.message || 'processing capture flow...');
    sendResponse({ ok: true });
  } else if (message.action === 'transcript_start' && message.sessionId) {
    setCaptureState(true);
    connectTranscript(message.sessionId);
    sendResponse({ ok: true });
  } else if (message.action === 'transcript_stop') {
    (async () => {
      disconnect();
      await stopLocalTabOnlyCapture();
      localSessionId = null;
      setCaptureState(false);
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

// --- on load: reconnect only when capture is actually active ---
async function restoreActiveCapture() {
  const state = await chrome.runtime.sendMessage({ action: 'get_capture_state' }).catch(() => null);
  if (state?.ok && state.capturing && state.sessionId) {
    setCaptureState(true);
    connectTranscript(state.sessionId);
    return;
  }

  setCaptureState(false);
  await chrome.storage.local.remove('activeSessionId');
}

restoreActiveCapture();

// --- summarize button ---

const btnSummarize = document.getElementById('btn-summarize');

btnSummarize.addEventListener('click', async () => {
  const sessionId = await getActiveSessionId();
  if (!sessionId) {
    return;
  }

  btnSummarize.disabled = true;
  btnSummarize.textContent = '⏳ Generating...';

  // show loading in transcript area
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'summary-loading';
  loadingDiv.textContent = '🤖 Generating summary with Claude...';
  transcriptEl.appendChild(loadingDiv);
  const container = document.getElementById('transcript-container');
  container.scrollTop = container.scrollHeight;

  try {
    const resp = await fetch(`http://${BACKEND_URL}/api/sessions/${sessionId}/summarize`, {
      method: 'POST',
    });
    const data = await resp.json();

    loadingDiv.remove();

    if (data.status === 'done' && data.content) {
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'summary-block';
      summaryDiv.innerHTML = markdownToHtml(data.content);
      transcriptEl.appendChild(summaryDiv);
      container.scrollTop = container.scrollHeight;
    } else {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'summary-loading';
      errorDiv.textContent = `❌ ${data.error || 'Summary generation failed'}`;
      transcriptEl.appendChild(errorDiv);
    }
  } catch (e) {
    loadingDiv.remove();
    const errorDiv = document.createElement('div');
    errorDiv.className = 'summary-loading';
    errorDiv.textContent = `❌ Failed to connect: ${e.message}`;
    transcriptEl.appendChild(errorDiv);
  } finally {
    btnSummarize.disabled = false;
    btnSummarize.textContent = '📋 Summarize';
  }
});

function getActiveSessionId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['activeSessionId'], (result) => {
      resolve(result.activeSessionId || null);
    });
  });
}

function markdownToHtml(md) {
  // minimal markdown → html for summary display
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^- (.+)$/gm, '• $1<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

// --- clear / copy buttons ---

btnClear.addEventListener('click', clearTranscript);

btnCopy.addEventListener('click', async () => {
  const texts = [...transcriptEl.querySelectorAll('.segment .text')].map((el) => el.textContent).join('\n');
  if (!texts) return;
  await navigator.clipboard.writeText(texts);
  const prev = btnCopy.textContent;
  btnCopy.textContent = '✅';
  setTimeout(() => { btnCopy.textContent = prev; }, 1200);
});
