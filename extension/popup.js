const statusEl = document.getElementById('status');

async function send(action) {
  const response = await chrome.runtime.sendMessage({ action });
  if (!response) {
    statusEl.textContent = 'no response from background';
    return;
  }
  statusEl.textContent = JSON.stringify(response, null, 2);
}

document.getElementById('startBtn').addEventListener('click', () => send('start_capture'));
document.getElementById('stopBtn').addEventListener('click', () => send('stop_capture'));
