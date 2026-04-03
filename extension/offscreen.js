let mediaRecorder = null;
let tabStream = null;
let micStream = null;
let audioContext = null;
let socket = null;

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

async function startCapture(streamId, sessionId, sources) {
  if (mediaRecorder) throw new Error('already capturing');

  const captureTab = sources?.tab !== false && streamId;
  const captureMic = sources?.mic === true;

  console.log('[offscreen] startCapture', { captureTab: !!captureTab, captureMic, streamId: !!streamId });

  audioContext = new AudioContext();
  await audioContext.resume();
  console.log('[offscreen] AudioContext state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);

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

  const mixedStream = destination.stream;

  socket = new WebSocket(`ws://127.0.0.1:8877/ws/audio?session=${sessionId}`);
  socket.binaryType = 'arraybuffer';

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      socket.removeEventListener('open', onOpen);
      reject(new Error('websocket connection failed (is backend running on 127.0.0.1:8877?)'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });

  console.log('[offscreen] WebSocket open');
  try {
    mediaRecorder = new MediaRecorder(mixedStream, {
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
  mediaRecorder.ondataavailable = async (event) => {
    chunkCount++;
    console.log(`[offscreen] chunk #${chunkCount} size:`, event.data?.size);
    if (!event.data || event.data.size === 0) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      const buf = await event.data.arrayBuffer();
      socket.send(buf);
    }
  };

  mediaRecorder.start(1000);
  console.log('[offscreen] MediaRecorder started, state:', mediaRecorder.state);
}

async function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

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

  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send('stop');
      socket.close();
    }
    socket = null;
  }
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
