let mediaRecorder = null;
let tabStream = null;
let micStream = null;
let audioContext = null;
let socket = null;

// Chunk queue — ensures ordered, reliable delivery even across reconnects
let chunkQueue = [];         // Blob entries waiting to be sent
let _queuePromise = null;    // tracks the in-flight _drainQueue() promise
let reconnectTimer = null;
let reconnectAttempts = 0;
let isCapturing = false;
const MAX_QUEUE_CHUNKS = 60; // ~60s buffer at 1s per chunk

function reportError(error) {
  console.error('[offscreen]', error);
  chrome.runtime.sendMessage({ action: 'capture_error', error }).catch(() => {});
}

function normalizeCaptureError(prefix, error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return `${prefix}: mic permission denied or blocked in browser settings`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return `${prefix}: no microphone device found`;
  }
  return `${prefix}: ${error?.message || 'unknown error'}`;
}

// ---------------------------------------------------------------------------
// WebSocket management
// ---------------------------------------------------------------------------

async function connectWebSocket(sessionId) {
  // Use a local ref so we can detect stale connects after stopCapture()
  const ws = new WebSocket(`ws://127.0.0.1:8877/ws/audio?session=${sessionId}`);
  socket = ws;
  ws.binaryType = 'arraybuffer';

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      ws.removeEventListener('open', onOpen);
      reject(new Error('websocket connection failed (is backend running on 127.0.0.1:8877?)'));
    };
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
  console.log('[offscreen] WebSocket open');

  // Flush any chunks that buffered during the (re)connect window
  processQueue();

  // Auto-reconnect on unexpected close
  ws.addEventListener('close', () => {
    if (isCapturing) scheduleReconnect(sessionId);
  }, { once: true });
}

function scheduleReconnect(sessionId) {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  console.log(`[offscreen] WebSocket closed — reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(async () => {
    if (!isCapturing) return;
    try {
      await connectWebSocket(sessionId);
    } catch (_) {
      if (isCapturing) scheduleReconnect(sessionId);
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Chunk queue — single-consumer, promise-based so stopCapture() can await drain
// ---------------------------------------------------------------------------

// Returns the in-flight promise if already running, otherwise starts a new run.
// Callers that need to wait until the queue is truly empty should await this.
function processQueue() {
  if (_queuePromise) return _queuePromise;
  _queuePromise = _drainQueue().finally(() => { _queuePromise = null; });
  return _queuePromise;
}

async function _drainQueue() {
  while (chunkQueue.length > 0) {
    if (!socket || socket.readyState !== WebSocket.OPEN) break;
    const blob = chunkQueue[0]; // peek — only shift after successful send
    let buf;
    try {
      buf = await blob.arrayBuffer();
    } catch (e) {
      chunkQueue.shift(); // bad blob, discard
      console.warn('[offscreen] arrayBuffer() failed, chunk discarded:', e);
      continue;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      chunkQueue.shift(); // commit
      try {
        socket.send(buf);
      } catch (e) {
        // send() threw (e.g. InvalidStateError) — socket will close and trigger reconnect
        console.warn('[offscreen] socket.send() failed:', e);
      }
    } else {
      break; // socket closed between await — leave blob in queue for reconnect
    }
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function startCapture(streamId, sessionId, sources) {
  if (mediaRecorder) throw new Error('already capturing');

  const captureTab = sources?.tab !== false && streamId;
  const captureMic = sources?.mic === true;

  console.log('[offscreen] startCapture', { captureTab: !!captureTab, captureMic, streamId: !!streamId });

  audioContext = new AudioContext();
  await audioContext.resume();
  console.log('[offscreen] AudioContext state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);

  // Resume if Chrome suspends the context (e.g. tab backgrounded, power saving)
  audioContext.addEventListener('statechange', () => {
    if (audioContext?.state === 'suspended' && isCapturing) {
      console.warn('[offscreen] AudioContext suspended — resuming');
      audioContext.resume().catch(() => {});
    }
  });

  const destination = audioContext.createMediaStreamDestination();

  if (captureTab) {
    try {
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });
      const tabTrack = tabStream.getAudioTracks()[0];
      console.log('[offscreen] tabStream ok, track:', tabTrack?.label, 'enabled:', tabTrack?.enabled, 'readyState:', tabTrack?.readyState);
      audioContext.createMediaStreamSource(tabStream).connect(destination);
    } catch (e) {
      const error = normalizeCaptureError('tab capture failed', e);
      await stopCapture();
      reportError(error);
      throw new Error(error);
    }
  }

  if (captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const micTrack = micStream.getAudioTracks()[0];
      console.log('[offscreen] micStream ok, track:', micTrack?.label, 'enabled:', micTrack?.enabled, 'readyState:', micTrack?.readyState);
      audioContext.createMediaStreamSource(micStream).connect(destination);
    } catch (e) {
      const error = normalizeCaptureError('mic capture failed', e);
      await stopCapture();
      reportError(error);
      throw new Error(error);
    }
  }

  const destTracks = destination.stream.getAudioTracks();
  console.log('[offscreen] destination tracks:', destTracks.length, 'enabled:', destTracks[0]?.enabled);

  // Set isCapturing BEFORE connectWebSocket so that the socket's close event
  // handler (registered inside connectWebSocket) can trigger reconnect even if
  // the socket drops in the brief window between connect and MediaRecorder start.
  isCapturing = true;
  try {
    await connectWebSocket(sessionId);
  } catch (e) {
    isCapturing = false;
    await stopCapture(); // cleans up streams and AudioContext
    const errMsg = normalizeCaptureError('websocket connection failed', e);
    reportError(errMsg);
    throw new Error(errMsg);
  }

  try {
    mediaRecorder = new MediaRecorder(destination.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000,
    });
  } catch (e) {
    const error = `MediaRecorder init failed: ${e.message}`;
    await stopCapture();
    reportError(error);
    throw new Error(error);
  }

  let chunkCount = 0;
  mediaRecorder.ondataavailable = (event) => {
    chunkCount++;
    console.log(`[offscreen] chunk #${chunkCount} size:`, event.data?.size);
    if (!event.data || event.data.size === 0) return;
    // Drop oldest chunk if buffer is full (prevents unbounded memory growth)
    if (chunkQueue.length >= MAX_QUEUE_CHUNKS) {
      chunkQueue.shift();
      console.warn('[offscreen] queue overflow, oldest chunk dropped');
    }
    chunkQueue.push(event.data);
    processQueue(); // no-op if already draining; new item picked up by running loop
  };

  mediaRecorder.start(1000);
  console.log('[offscreen] MediaRecorder started, state:', mediaRecorder.state);
}

async function stopCapture() {
  isCapturing = false;

  // Cancel any pending reconnect
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Stop MediaRecorder and wait for the final ondataavailable to fire
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve;
      mediaRecorder.stop();
    });
  }
  mediaRecorder = null;

  // Stop all tracks
  if (tabStream) {
    tabStream.getTracks().forEach((t) => t.stop());
    tabStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  // Flush remaining queued chunks then close socket.
  // await processQueue() correctly waits for any in-flight drain to complete
  // before we send 'stop' and close — guaranteeing the last chunk is delivered.
  if (socket && socket.readyState === WebSocket.OPEN) {
    await processQueue();
    socket.send('stop');
    socket.close();
  }
  socket = null;

  // Reset queue state
  chunkQueue = [];
  _queuePromise = null;
  reconnectAttempts = 0;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.action === 'start_capture') {
    (async () => {
      try {
        await startCapture(message.streamId, message.sessionId, message.sources);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'offscreen start failed' });
      }
    })();
    return true;
  }

  if (message.action === 'stop_capture') {
    (async () => {
      try {
        await stopCapture();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'offscreen stop failed' });
      }
    })();
    return true;
  }

  return false;
});
