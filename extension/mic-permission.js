const params = new URLSearchParams(location.search);
const requestId = params.get('requestId');
const mode = params.get('mode') || 'permission';
const sessionId = params.get('sessionId');
const streamId = params.get('streamId') || '';
const captureTab = params.get('captureTab') === '1';
const statusEl = document.getElementById('status');

let mediaRecorder = null;
let tabStream = null;
let micStream = null;
let audioContext = null;
let socket = null;

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

async function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  mediaRecorder = null;
  if (tabStream) tabStream.getTracks().forEach((t) => t.stop());
  tabStream = null;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  if (audioContext) await audioContext.close().catch(() => {});
  audioContext = null;
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send('stop');
      socket.close();
    }
    socket = null;
  }
}

async function startCapture() {
  if (!sessionId) throw new Error('missing session id');

  audioContext = new AudioContext();
  await audioContext.resume();
  const destination = audioContext.createMediaStreamDestination();

  if (captureTab && streamId) {
    try {
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
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

  socket = new WebSocket(`ws://127.0.0.1:8877/ws/audio?session=${sessionId}`);
  socket.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      socket.removeEventListener('open', onOpen);
      reject(new Error('websocket connection failed'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });

  mediaRecorder = new MediaRecorder(destination.stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 128000,
  });
  mediaRecorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(await event.data.arrayBuffer());
    }
  };
  mediaRecorder.start(1000);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'start_capture_in_tab') {
    if (message.requestId !== requestId) return false;
    (async () => {
      try {
        await startCapture();
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
