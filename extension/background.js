let sessionId = null;
let startPending = false;
let permissionReqSeq = 0;
const pendingMicPermission = new Map();
let micCaptureTabId = null;
let micCaptureSessionId = null;
const tabStreamIdCache = new Map();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function isCapturableUrl(url) {
  if (!url) return false;
  return /^(https?:\/\/|file:\/\/)/i.test(url);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isCapturableUrl(tab.url)) return;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    tabStreamIdCache.set(tab.id, streamId);
  } catch (_) {
    // Ignore; this is a best-effort cache warm-up.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreamIdCache.delete(tabId);
});

function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function clearCaptureState() {
  sessionId = null;
  startPending = false;
  await chrome.storage.local.remove('activeSessionId');
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab and microphone audio for transcription',
  });
}

function closeMicPermissionRequest(requestId, result) {
  const req = pendingMicPermission.get(requestId);
  if (!req) return;
  clearTimeout(req.timeoutId);
  pendingMicPermission.delete(requestId);
  const tabId = req.tabId || null;
  if (tabId && !result?.keepOpen) chrome.tabs.remove(tabId).catch(() => {});
  req.resolve({ ...result, tabId });
}

async function requestMicPermissionInTab(requesterWindowId) {
  const requestId = `${Date.now()}-${++permissionReqSeq}`;
  chrome.runtime.sendMessage({ action: 'mic_permission_required' }).catch(() => {});

  const promise = new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingMicPermission.delete(requestId);
      resolve({ ok: false, error: 'microphone permission request timed out' });
    }, 120000);
    pendingMicPermission.set(requestId, { resolve, timeoutId, tabId: null });
  });

  const createOptions = {
    url: chrome.runtime.getURL(`mic-permission.html?requestId=${encodeURIComponent(requestId)}`),
    active: true,
  };
  if (requesterWindowId) createOptions.windowId = requesterWindowId;

  const tab = await chrome.tabs.create(createOptions).catch(() =>
    chrome.tabs.create({
      url: chrome.runtime.getURL(`mic-permission.html?requestId=${encodeURIComponent(requestId)}`),
      active: true,
    })
  );
  if (tab?.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (tab.id) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    }
  }
  const req = pendingMicPermission.get(requestId);
  if (req) req.tabId = tab.id;
  return promise;
}

async function startMicCaptureFallbackInTab({ permissionRequestId, permissionTabId, captureSessionId, streamId, captureTab }) {
  chrome.runtime.sendMessage({
    action: 'capture_info',
    message: 'offscreen mic blocked. switching to mic capture tab...',
  }).catch(() => {});

  if (!permissionTabId || !permissionRequestId) {
    return { ok: false, error: 'permission tab unavailable for fallback capture' };
  }

  const response = await chrome.runtime.sendMessage({
    action: 'start_capture_in_tab',
    requestId: permissionRequestId,
    sessionId: captureSessionId,
    streamId,
    captureTab,
  }).catch((e) => ({ ok: false, error: e?.message || 'failed to message permission tab' }));

  if (response?.ok) {
    micCaptureTabId = permissionTabId;
    micCaptureSessionId = captureSessionId;
  }
  return response;
}

async function startCapture(sources, preferredStreamId, preferredTabId, requesterWindowId) {
  if (sessionId) return { ok: false, error: 'already capturing', sessionId };
  if (startPending) return { ok: false, error: 'capture is already starting' };

  const captureTab = sources?.tab !== false;
  const captureMic = sources?.mic === true;

  if (!captureTab && !captureMic) return { ok: false, error: 'at least one source must be selected' };

  startPending = true;
  try {
    let streamId = preferredStreamId || null;
    let targetTabId = preferredTabId || null;
    if (captureTab && !streamId) {
      let tab = null;
      if (targetTabId) {
        tab = await chrome.tabs.get(targetTabId).catch(() => null);
      }
      if (!tab) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tab = activeTab;
      }
      if (!tab) return { ok: false, error: 'no active tab found' };
      targetTabId = tab.id;

      // Prefer stream ID captured from extension action click.
      if (targetTabId && tabStreamIdCache.has(targetTabId)) {
        streamId = tabStreamIdCache.get(targetTabId);
      }

      if (!streamId && !isCapturableUrl(tab.url)) {
        return { ok: false, error: `cannot capture this tab (${tab.url || 'unknown url'}). switch to an http(s) tab` };
      }

      try {
        if (!streamId) {
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        }
      } catch (e) {
        const msg = e?.message || String(e);
        if (/Extension has not been invoked/i.test(msg)) {
          return {
            ok: false,
            error: 'tab capture needs extension invocation for this page. click extension icon on target tab once, then press Start again',
          };
        }
        if (/Chrome pages cannot be captured/i.test(msg)) {
          return { ok: false, error: 'cannot capture chrome:// pages (open a normal web page tab)' };
        }
        return { ok: false, error: `getMediaStreamId failed: ${msg}` };
      }
    }

    sessionId = newSessionId();
    await chrome.storage.local.set({ activeSessionId: sessionId });
    let permissionTabId = null;
    let permissionRequestId = null;
    if (captureMic) {
      const micResult = await requestMicPermissionInTab(requesterWindowId);
      if (!micResult?.ok) {
        await clearCaptureState();
        return { ok: false, error: micResult?.error || 'mic permission denied' };
      }
      permissionTabId = micResult.tabId;
      permissionRequestId = micResult.requestId;
    }

    await ensureOffscreenDocument();
    const offscreenResp = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_capture',
      streamId,
      sessionId,
      sources: { tab: captureTab, mic: captureMic },
    }).catch((e) => ({ ok: false, error: e?.message || 'offscreen message failed' }));
    if (!offscreenResp?.ok) {
      const offscreenError = offscreenResp?.error || 'offscreen start failed';
      const isMicDenied = captureMic && /mic capture failed: mic permission denied/i.test(offscreenError);
      if (isMicDenied) {
        const fallback = await startMicCaptureFallbackInTab({
          permissionRequestId,
          permissionTabId,
          captureSessionId: sessionId,
          streamId,
          captureTab,
        });
        if (!fallback?.ok) {
          if (permissionTabId) chrome.tabs.remove(permissionTabId).catch(() => {});
          await clearCaptureState();
          return { ok: false, error: fallback?.error || offscreenError };
        }
      } else {
        if (permissionTabId) chrome.tabs.remove(permissionTabId).catch(() => {});
        await clearCaptureState();
        return { ok: false, error: offscreenError };
      }
    } else if (permissionTabId) {
      // Offscreen capture succeeded, so permission tab can close.
      chrome.tabs.remove(permissionTabId).catch(() => {});
    }

    chrome.runtime.sendMessage({ action: 'transcript_start', sessionId }).catch(() => {});
    return { ok: true, sessionId, message: 'capture started' };
  } catch (e) {
    await clearCaptureState();
    return { ok: false, error: e?.message || 'failed to start capture' };
  } finally {
    startPending = false;
  }
}

async function stopCapture() {
  if (!sessionId) {
    const { activeSessionId } = await chrome.storage.local.get('activeSessionId');
    if (!activeSessionId) return { ok: false, error: 'not capturing' };
    sessionId = activeSessionId;
  }

  const stoppedSession = sessionId;
  const stoppedMicSessionId = micCaptureSessionId;
  const stoppedMicTabId = micCaptureTabId;
  await clearCaptureState();
  micCaptureSessionId = null;
  micCaptureTabId = null;

  if (stoppedMicSessionId) {
    await chrome.runtime.sendMessage({ action: 'stop_mic_capture', sessionId: stoppedMicSessionId }).catch(() => {});
  }
  if (stoppedMicTabId) {
    await chrome.tabs.remove(stoppedMicTabId).catch(() => {});
  }

  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop_capture' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  chrome.runtime.sendMessage({ action: 'transcript_stop' }).catch(() => {});
  return { ok: true, sessionId: stoppedSession, message: 'capture stopped' };
}

async function getCaptureState() {
  // Treat capture as active only when runtime state has a live session and
  // an active capture context exists (offscreen or mic-permission fallback tab).
  const active = sessionId || null;
  if (!active) return { ok: true, capturing: false, sessionId: null };

  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  const hasOffscreen = Array.isArray(contexts) && contexts.length > 0;
  const hasMicFallback = !!micCaptureSessionId;
  const capturing = hasOffscreen || hasMicFallback;

  return {
    ok: true,
    capturing,
    sessionId: capturing ? active : null,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'start_capture') {
    sendResponse({ ok: true, pending: true });
    (async () => {
      const result = await startCapture(
        message.sources,
        message.streamId,
        message.targetTabId,
        message.requesterWindowId
      );
      if (!result?.ok) {
        chrome.runtime.sendMessage({ action: 'capture_error', error: result.error }).catch(() => {});
      }
    })();
    return false;
  }

  if (message.action === 'capture_error') {
    (async () => {
      await clearCaptureState();
      chrome.runtime.sendMessage({ action: 'transcript_stop' }).catch(() => {});
    })();
    try { sendResponse({ ok: true }); } catch (_) {}
    return false;
  }

  if (message.action === 'mic_permission_result' && message.requestId) {
    closeMicPermissionRequest(message.requestId, {
      ok: !!message.ok,
      requestId: message.requestId,
      error: message.error,
      keepOpen: !!message.keepOpen,
    });
    try { sendResponse({ ok: true }); } catch (_) {}
    return false;
  }

  if (message.action === 'stop_capture') {
    (async () => {
      const result = await stopCapture();
      try { sendResponse(result); } catch (_) {}
    })();
    return true;
  }

  if (message.action === 'get_capture_state') {
    (async () => {
      const result = await getCaptureState();
      try { sendResponse(result); } catch (_) {}
    })();
    return true;
  }

  try { sendResponse({ ok: false, error: 'unknown action' }); } catch (_) {}
  return false;
});
