const statusEl = document.getElementById('status');

async function send(action) {
  if (action === 'start_capture') {
    if (!chrome.sidePanel) {
      statusEl.textContent = 'side panel API is unavailable';
      return;
    }
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: currentWindow.id });
    statusEl.textContent = 'Use Start in side panel to begin capture.';
    return;
  }

  if (action === 'stop_capture') {
    const response = await chrome.runtime.sendMessage({ action });
    if (!response) { statusEl.textContent = 'no response from background'; return; }
    statusEl.textContent = JSON.stringify(response, null, 2);
    if (response.ok) {
      chrome.storage.local.remove('activeSessionId');
      chrome.runtime.sendMessage({ action: 'transcript_stop' }).catch(() => {});
    }
  }
}

document.getElementById('startBtn').addEventListener('click', () => send('start_capture'));
document.getElementById('stopBtn').addEventListener('click', () => send('stop_capture'));
