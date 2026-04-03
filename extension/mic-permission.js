const params = new URLSearchParams(location.search);
const requestId = params.get('requestId');
const mode = params.get('mode') || 'permission';
// sessionId/streamId/captureTab may be absent from the URL (permission-only flow).
// startCapture() accepts explicit overrides from the start_capture_in_tab message.
const sessionId = params.get('sessionId');
const streamId = params.get('streamId') || '';
const captureTab = params.get('captureTab') === '1';
const statusEl = document.getElementById('status');

let mediaRecorder = null;
let tabStream = null;
let micStream = null;
let audioContext = null;
let socket = null;

// Chunk queue — same reliable-delivery pattern as offscreen.js
let chunkQueue = [];
let _queuePromise = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isCapturing = false;
const MAX_QUEUE_CHUNKS = 60;

function normalizeError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') {
    return 'mic permission denied or blocked in browser settings';
  }
  if (e?.name === 'NotFoundError' || e?.name === 'DevicesNotFoundError') {
    return 'no microphone device found';
  }
  return e?.message || 'failed to request microphone permission';
}

async function sendResult(ok, error, keepOpen = false) {
  await chrome.runtime.sendMessage({
    action: 'mic_permission_result',
    requestId,
    ok,
    error,
    keepOpen,
  });
}

// ---------------------------------------------------------------------------
// WebSocket management
// ---------------------------------------------------------------------------

async function connectWebSocket(sid) {
  const ws = new WebSocket(`ws://127.0.0.1:8877/ws/audio?session=${sid}`);
  socket = ws;
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    const onOpen = () => { ws.removeEventListener('error', onError); resolve(); };
    const onError = () => { ws.removeEventListener('open', onOpen); reject(new Error('websocket connection failed')); };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });

  // If stopCapture() ran while we were connecting, close this stale socket
  if (!isCapturing) {
    ws.close();
    if (socket === ws) socket = null;
    return;
  }

  reconnectAttempts = 0;
  processQueue();
  ws.addEventListener('close', () => {
    if (isCapturing) scheduleReconnect(sid);
  }, { once: true });
}

function scheduleReconnect(sid) {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(async () => {
    if (!isCapturing) return;
    try { await connectWebSocket(sid); }
    catch (_) { if (isCapturing) scheduleReconnect(sid); }
  }, delay);
}

// ---------------------------------------------------------------------------
// Chunk queue — promise-based so stopCapture() can properly await the drain
// ---------------------------------------------------------------------------

function processQueue() {
  if (_queuePromise) return _queuePromise;
  _queuePromise = _drainQueue().finally(() => { _queuePromise = null; });
  return _queuePromise;
}

async function _drainQueue() {
  while (chunkQueue.length > 0) {
    if (!socket || socket.readyState !== WebSocket.OPEN) break;
    const blob = chunkQueue[0];
    let buf;
    try { buf = await blob.arrayBuffer(); }
    catch (e) { chunkQueue.shift(); continue; }
    if (socket && socket.readyState === WebSocket.OPEN) {
      chunkQueue.shift();
      try {
        socket.send(buf);
      } catch (e) {
        console.warn('[mic-permission] socket.send() failed:', e);
      }
    } else {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function stopCapture() {
  isCapturing = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve;
      mediaRecorder.stop();
    });
  }
  mediaRecorder = null;

  if (tabStream) { tabStream.getTracks().forEach((t) => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }

  if (socket && socket.readyState === WebSocket.OPEN) {
    await processQueue(); // waits for any in-flight drain before closing
    socket.send('stop');
    socket.close();
  }
  socket = null;
  chunkQueue = [];
  _queuePromise = null;
  reconnectAttempts = 0;
}

// overrideSessionId/overrideStreamId/overrideCaptureTab are passed by the
// start_capture_in_tab message handler when URL params are absent.
async function startCapture(overrideSessionId, overrideStreamId, overrideCaptureTab) {
  const effectiveSessionId  = overrideSessionId  ?? sessionId;
  const effectiveStreamId   = overrideStreamId   ?? streamId;
  const effectiveCaptureTab = overrideCaptureTab ?? captureTab;

  if (!effectiveSessionId) throw new Error('missing session id');

  audioContext = new AudioContext();
  await audioContext.resume();

  // Resume if Chrome suspends the context
  audioContext.addEventListener('statechange', () => {
    if (audioContext?.state === 'suspended' && isCapturing) {
      audioContext.resume().catch(() => {});
    }
  });

  const destination = audioContext.createMediaStreamDestination();

  if (effectiveCaptureTab && effectiveStreamId) {
    try {
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: effectiveStreamId } },
        video: false,
      });
      audioContext.createMediaStreamSource(tabStream).connect(destination);
    } catch (_) {
      // Keep mic-only fallback alive even if tab audio capture fails.
    }
  }

  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
  audioContext.createMediaStreamSource(micStream).connect(destination);

  isCapturing = true;
  try {
    await connectWebSocket(effectiveSessionId);
  } catch (e) {
    isCapturing = false;
    await stopCapture();
    throw new Error(`websocket connection failed: ${e.message}`);
  }

  mediaRecorder = new MediaRecorder(destination.stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 128000,
  });
  mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    if (chunkQueue.length >= MAX_QUEUE_CHUNKS) {
      chunkQueue.shift();
    }
    chunkQueue.push(event.data);
    processQueue();
  };
  mediaRecorder.start(1000);
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'start_capture_in_tab') {
    if (message.requestId !== requestId) return false;
    (async () => {
      try {
        // Pass explicit values from the message — URL params may be absent in permission-only flow
        await startCapture(message.sessionId, message.streamId, message.captureTab);
        statusEl.textContent = 'Fallback capture is running in this tab.';
        try { sendResponse({ ok: true }); } catch (_) {}
      } catch (e) {
        const error = normalizeError(e);
        statusEl.textContent = error;
        await stopCapture();
        try { sendResponse({ ok: false, error }); } catch (_) {}
      }
    })();
    return true;
  }

  if (message.action === 'stop_mic_capture') {
    if (message.sessionId && sessionId && message.sessionId !== sessionId) return false;
    (async () => {
      await stopCapture();
      try { sendResponse({ ok: true }); } catch (_) {}
      window.close();
    })();
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Initial flow
// ---------------------------------------------------------------------------

(async () => {
  let error = '';
  if (mode === 'capture') {
    try {
      await startCapture();
      statusEl.textContent = 'Fallback capture is running in this tab.';
      await sendResult(true, '', true);
    } catch (e) {
      error = normalizeError(e);
      statusEl.textContent = error;
      await stopCapture();
      await sendResult(false, error, false);
      window.close();
    }
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    statusEl.textContent = 'Permission granted. Verifying offscreen capture...';
    await sendResult(true, '', true);
  } catch (e) {
    error = normalizeError(e);
    statusEl.textContent = error;
    await sendResult(false, error, false);
    window.close();
  }
})();
