// Scaffold panel: shows the handoff state for each image click. The full
// state machine, provider calls, and components arrive in a later step.
export {};
const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');

document.title = chrome.i18n.getMessage('appName');
if (titleEl) {
  titleEl.textContent = chrome.i18n.getMessage('appName');
}

interface TripRequest {
  requestId: string;
  status: string;
}

let highestRequestId = '';

function render(request: TripRequest | undefined): void {
  if (!statusEl) {
    return;
  }
  if (!request) {
    statusEl.textContent = chrome.i18n.getMessage('panelIdle');
    return;
  }
  if (request.requestId < highestRequestId) {
    return;
  }
  highestRequestId = request.requestId;
  statusEl.textContent =
    request.status === 'ready'
      ? chrome.i18n.getMessage('panelReady')
      : chrome.i18n.getMessage('panelCollecting');
}

void chrome.storage.session.get('tripRequest').then((stored) => {
  render((stored as { tripRequest?: TripRequest }).tripRequest);
});

chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes['tripRequest'];
  if (change) {
    render(change.newValue as TripRequest | undefined);
  }
});
