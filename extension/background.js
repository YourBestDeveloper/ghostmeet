let sessionId = null;

function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio via tabCapture stream ID',
  });
}

async function startCapture() {
  if (sessionId) {
    return { ok: false, error: 'already capturing', sessionId };
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { ok: false, error: 'no active tab found' };

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    return { ok: false, error: `getMediaStreamId failed: ${e.message}` };
  }

  sessionId = newSessionId();
  chrome.storage.local.set({ activeSessionId: sessionId });

  await ensureOffscreenDocument();

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'start_capture',
    streamId,
    sessionId,
  });

  return { ok: true, sessionId, message: 'capture started' };
}

async function stopCapture() {
  if (!sessionId) {
    const { activeSessionId } = await chrome.storage.local.get('activeSessionId');
    if (!activeSessionId) return { ok: false, error: 'not capturing' };
    sessionId = activeSessionId;
  }

  const stoppedSession = sessionId;
  sessionId = null;
  chrome.storage.local.remove('activeSessionId');

  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop_capture' });
  }

  return { ok: true, sessionId: stoppedSession, message: 'capture stopped' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === 'offscreen') return false;

  (async () => {
    if (message.action === 'start_capture') {
      sendResponse(await startCapture());
      return;
    }

    if (message.action === 'stop_capture') {
      sendResponse(await stopCapture());
      return;
    }

    sendResponse({ ok: false, error: 'unknown action' });
  })();

  return true;
});
