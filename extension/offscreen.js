let mediaRecorder = null;
let tabStream = null;
let micStream = null;
let audioContext = null;
let socket = null;

async function startCapture(streamId, sessionId, sources) {
  if (mediaRecorder) return;

  const captureTab = sources?.tab !== false && streamId;
  const captureMic = sources?.mic === true;

  audioContext = new AudioContext();
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
      audioContext.createMediaStreamSource(tabStream).connect(destination);
    } catch (e) {
      // tab stream 실패 시 계속 진행
    }
  }

  if (captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioContext.createMediaStreamSource(micStream).connect(destination);
    } catch (e) {
      // 마이크 권한 거부 시 무시
    }
  }

  const mixedStream = destination.stream;

  socket = new WebSocket(`ws://127.0.0.1:8877/ws/audio?session=${sessionId}`);
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    try {
      mediaRecorder = new MediaRecorder(mixedStream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 128000,
      });
    } catch (e) {
      return;
    }

    mediaRecorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size === 0) return;
      if (socket && socket.readyState === WebSocket.OPEN) {
        const buf = await event.data.arrayBuffer();
        socket.send(buf);
      }
    };

    mediaRecorder.start(1000);
  };
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
    startCapture(message.streamId, message.sessionId, message.sources);
    sendResponse({ ok: true });
  } else if (message.action === 'stop_capture') {
    stopCapture();
    sendResponse({ ok: true });
  }

  return false;
});
