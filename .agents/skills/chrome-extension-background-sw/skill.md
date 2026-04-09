---
name: Chrome Extension Background Service Worker
description: >
  Load this skill when writing or debugging a Chrome Extension's background.js (Manifest V3
  service worker). Essential for tasks involving: chrome.runtime messaging, cross-script
  communication, persistent storage with chrome.storage.local/session, alarm scheduling,
  tab management, content-script injection, context menu creation, and handling service
  worker lifecycle (install/activate/fetch). Also load when the user reports that the
  background script stops running, loses state, or messages between popup/content-script
  and background are not received.
---

# Chrome Extension – Background Service Worker Skill

> **Manifest Version**: These patterns apply to **Manifest V3** (MV3).
> MV3 replaced persistent background pages with ephemeral *service workers*.
> The service worker can be terminated at any time — do NOT rely on in-memory global variables
> for long-lived state. Use `chrome.storage` instead.

---

## Critical Gotchas (MV3)

| Issue | Wrong | Correct |
|---|---|---|
| Persistent state | `let globalData = {}` | `chrome.storage.local.set({...})` |
| Awaiting after async gap | Unhandled promise in message listener | Always return `true` from `onMessage` for async replies |
| `fetch` in background | Works, but can fail if SW is terminated mid-flight | Use `keepalive: true` or alarms to re-trigger |
| DOM APIs | `document`, `window`, `localStorage` — **NOT available** | Use `chrome.storage`, `self`, `indexedDB` |
| `console.log` debugging | Logs appear in the *service worker* DevTools, not popup | Open `chrome://extensions` → "service worker" inspect link |

---

## manifest.json (MV3 Template)

```json
{
  "manifest_version": 3,
  "name": "My Extension",
  "version": "1.0.0",
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "permissions": [
    "storage",
    "tabs",
    "scripting",
    "alarms",
    "contextMenus",
    "activeTab"
  ],
  "host_permissions": ["<all_urls>"],
  "action": {
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content-agent.js"],
      "run_at": "document_idle"
    }
  ]
}
```

---

## Message Passing Patterns

### Popup → Background

```js
// popup.js
const response = await chrome.runtime.sendMessage({ action: 'doSomething', data: 'payload' });
console.log(response); // { success: true, result: ... }
```

```js
// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'doSomething') {
    // For async work, MUST return true to keep the channel open
    handleAsync(message.data).then(result => sendResponse({ success: true, result }));
    return true; // ← CRITICAL for async sendResponse
  }
});
```

### Background → Content Script (specific tab)

```js
// background.js
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const response = await chrome.tabs.sendMessage(tab.id, { action: 'doInPage', selector: '#btn' });
```

```js
// content-agent.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'doInPage') {
    const el = document.querySelector(message.selector);
    el?.click();
    sendResponse({ clicked: !!el });
  }
});
```

### Content Script → Background

```js
// content-agent.js
const result = await chrome.runtime.sendMessage({ action: 'fetchData', url: 'https://api.example.com' });
```

---

## Persistent Storage Patterns

```js
// Save (replaces only named keys, does not wipe others)
await chrome.storage.local.set({ conversationHistory: [...], agentState: 'idle' });

// Load
const { conversationHistory = [], agentState = 'idle' } = await chrome.storage.local.get([
  'conversationHistory',
  'agentState'
]);

// Update a single nested key safely (atomic pattern)
const { workers = {} } = await chrome.storage.local.get('workers');
workers[newId] = { status: 'running', startedAt: Date.now() };
await chrome.storage.local.set({ workers });

// Remove
await chrome.storage.local.remove(['tempKey']);

// Listen for storage changes (any script)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.agentState) {
    console.log('State changed to:', changes.agentState.newValue);
  }
});
```

> **`chrome.storage.session`** (Chrome 102+): Cleared when the browser closes.
> Use for sensitive or short-lived data like auth tokens.

---

## Tab Management

```js
// Get active tab
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Open a new tab
const newTab = await chrome.tabs.create({ url: 'https://example.com', active: false });

// Inject a content script programmatically (requires "scripting" permission)
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  files: ['content-agent.js']
});

// Inject inline code
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: (selector) => document.querySelector(selector)?.click(),
  args: ['#submit-btn']
});

// Wait for a tab to finish loading
chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
  if (tabId === newTab.id && info.status === 'complete') {
    chrome.tabs.onUpdated.removeListener(listener);
    // proceed
  }
});
```

---

## Alarm Scheduling (replaces setInterval in MV3)

```js
// background.js – create an alarm
chrome.alarms.create('poll-api', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll-api') {
    pollRemoteApi();
  }
});

// Clear an alarm
chrome.alarms.clear('poll-api');
```

> **`setInterval` and `setTimeout`** still work but will be cancelled when the service worker
> sleeps. Use `chrome.alarms` for tasks that must survive SW termination.

---

## Service Worker Lifecycle

```js
// background.js

// Runs once when the extension is installed or updated
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // First-time setup: write defaults to storage
    chrome.storage.local.set({ agentState: 'idle', workers: {} });
  }
  if (reason === 'update') {
    // Migration logic if needed
  }
});

// Fires when the extension starts (e.g., browser launch or after SW killed/restarted)
chrome.runtime.onStartup.addListener(() => {
  console.log('Extension started');
});
```

---

## Context Menus

```js
// background.js – create menus on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'run-agent',
    title: 'Run Agent on This Page',
    contexts: ['page', 'selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'run-agent') {
    chrome.tabs.sendMessage(tab.id, { action: 'startAgent', selectedText: info.selectionText });
  }
});
```

---

## Multi-Agent State Management Pattern

For a swarm/orchestrator pattern (e.g., multiple workers running in parallel):

```js
// Unique worker ID generator
function generateWorkerId() {
  return `worker_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Register a new worker atomically
async function registerWorker(workerId, task) {
  const { workers = {} } = await chrome.storage.local.get('workers');
  workers[workerId] = { task, status: 'pending', createdAt: Date.now() };
  await chrome.storage.local.set({ workers });
}

// Update worker status atomically (prevents race conditions)
async function updateWorkerStatus(workerId, status, result = null) {
  const { workers = {} } = await chrome.storage.local.get('workers');
  if (workers[workerId]) {
    workers[workerId] = { ...workers[workerId], status, result, updatedAt: Date.now() };
    await chrome.storage.local.set({ workers });
  }
}

// Clean up finished workers older than 1 hour
async function pruneWorkers() {
  const { workers = {} } = await chrome.storage.local.get('workers');
  const cutoff = Date.now() - 3600_000;
  for (const [id, w] of Object.entries(workers)) {
    if (['done', 'error'].includes(w.status) && w.updatedAt < cutoff) {
      delete workers[id];
    }
  }
  await chrome.storage.local.set({ workers });
}
```

---

## Debugging Tips

1. **Inspect the service worker**: `chrome://extensions` → find your extension → click "service worker" link.
2. **Force re-activate** a sleeping SW: any `chrome.runtime.sendMessage` call will wake it.
3. **Check extension errors**: `chrome://extensions` → "Errors" button appears if the SW throws.
4. **Reload without reopening Chrome**: Click the reload (↺) button on `chrome://extensions`.
5. **Storage viewer**: In the SW DevTools → Application tab → Storage → Extension Storage.

---

## Best Practices

- **Never store sensitive data** (API keys, tokens) in `chrome.storage.local` — it is unencrypted. Use `chrome.storage.session` or an external auth flow.
- **Debounce** rapid `chrome.storage.local.set` calls (e.g., from `onMessage` bursts) to avoid quota errors.
- **Always validate `sender.id`** in `onMessage` listeners to prevent spoofing from other extensions:
  ```js
  if (sender.id !== chrome.runtime.id) return;
  ```
- **Use `async/await`** everywhere; avoid mixing callbacks and promises.
- **Log with structure** so SW DevTools output is easy to parse: `console.log('[BG]', { action, data })`.
