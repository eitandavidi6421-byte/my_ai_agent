---
name: Swarm Orchestrator — Gemini Multi-Agent Background
description: >
  Load this skill when writing or modifying the background.js multi-agent orchestrator
  for a Chrome Extension. Essential for tasks involving: Gemini API integration with
  OAuth tokens, spawning parallel swarm workers across browser tabs, batched/atomic
  storage updates with AsyncMutex, MV3 service worker keepalive via chrome.alarms,
  conversation history isolation per session (convHistory), manager/worker split
  architecture, pause/resume agent flows, and executeScript-based DOM interaction
  from the background. Also load when debugging race conditions in activeWorkers,
  stale worker state after SW restart, or conversation history leaking between sessions.
---

# Swarm Orchestrator — Background Architecture Skill

## System Architecture

```
User (popup/dashboard)
        │ sendMessage
        ▼
chrome.runtime.onMessage  ← Message Hub (background.js)
        │
        ├─ manager_prompt ──▶ runManagerOrchestrator()
        │                           │ callGeminiAPI (manager role)
        │                           │ parses JSON action: spawn_worker
        │                           ▼
        │                    runSwarmWorkerLoop(wid, tabId, task)
        │                           │ loop: callGeminiAPI (worker role)
        │                           │ executeScript → DOM actions
        │                           │ upd() → activeWorkers in storage
        │                           ▼
        │                    worker done → finalReport → manager
        │
        └─ Storage layer: chrome.storage.local
              keys: conversations, convHistory, activeWorkers
```

---

## MV3 Keepalive (mandatory for long-running loops)

```js
// Prevents the service worker from being killed mid-loop (MV3 sleeps after ~30s idle)
chrome.alarms.create("swarm_keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "swarm_keepalive") heartbeat();
});

function heartbeat() {
  // Any chrome API call resets the 30s idle timer
  chrome.runtime.getPlatformInfo(() => {});
}
```

> **Rule**: Call `heartbeat()` or any chrome API at least once every 25 seconds inside any
> long-running worker loop. Without this, MV3 will silently kill the service worker
> mid-execution and the agent will freeze.

---

## AsyncMutex — Preventing Race Conditions in Storage

```js
class AsyncMutex {
  constructor() {
    this.queue = [];
    this.locked = false;
  }
  async lock() {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else this.queue.push(resolve);
    });
  }
  unlock() {
    if (this.queue.length > 0) this.queue.shift()();
    else this.locked = false;
  }
}
const storageMutex = new AsyncMutex();
```

**Always use the mutex for critical writes** (pause, done, error, delete):

```js
await storageMutex.lock();
try {
  const { activeWorkers = {} } = await chrome.storage.local.get([
    "activeWorkers",
  ]);
  // ... mutate ...
  await chrome.storage.local.set({ activeWorkers });
} finally {
  storageMutex.unlock(); // ALWAYS in finally block
}
```

---

## Batched Storage Updates (`upd` vs `updDirect`)

Two-tier write pattern prevents storage quota errors when many agents update frequently:

```js
const pendingWorkerUpdates = {};
let batchUpdateTimer = null;

// FAST PATH: merges patches in memory, flushes every 500ms
// Use for: log entries, url updates, step counts
function upd(workerId, patch) {
  if (!pendingWorkerUpdates[workerId]) pendingWorkerUpdates[workerId] = {};
  Object.assign(pendingWorkerUpdates[workerId], patch);

  if (!batchUpdateTimer) {
    batchUpdateTimer = setTimeout(async () => {
      batchUpdateTimer = null;
      const updates = { ...pendingWorkerUpdates };
      for (let k in pendingWorkerUpdates) delete pendingWorkerUpdates[k];

      await storageMutex.lock();
      try {
        const { activeWorkers = {} } = await chrome.storage.local.get([
          "activeWorkers",
        ]);
        for (const wid in updates) {
          if (!activeWorkers[wid]) activeWorkers[wid] = {};
          Object.assign(activeWorkers[wid], updates[wid]);
        }
        await chrome.storage.local.set({ activeWorkers });
      } finally {
        storageMutex.unlock();
      }
    }, 500);
  }
}

// CRITICAL PATH: immediate write with mutex
// Use for: status = 'done' | 'error' | 'paused' | 'cancelled'
async function updDirect(workerId, patch) {
  await storageMutex.lock();
  try {
    const { activeWorkers = {} } = await chrome.storage.local.get([
      "activeWorkers",
    ]);
    if (!activeWorkers[workerId]) return;
    Object.assign(activeWorkers[workerId], patch);
    await chrome.storage.local.set({ activeWorkers });
  } finally {
    storageMutex.unlock();
  }
}
```

> **Rule**: Use `upd()` for frequent non-critical updates (logs), `updDirect()` for terminal
> state transitions. Never call `upd()` for `status: 'done'` — stale batch may overwrite it.

---

## Conversation Isolation Pattern

Each conversation has its own isolated history stored under `convHistory[id]`:

```js
// Storage schema
{
  conversations: [{ id, title, createdAt }],   // sidebar list
  convHistory:   { [convId]: [...messages] },   // per-conversation Gemini history
  activeWorkers: { [workerId]: { ...state } }    // running/done agents
}

// Create new isolated conversation
async function createConversation(title = 'שיחה חדשה') {
  const id = crypto.randomUUID();
  const { conversations = [], convHistory = {} } = await chrome.storage.local.get(['conversations', 'convHistory']);
  conversations.unshift({ id, title, createdAt: Date.now() });
  convHistory[id] = [];   // isolated empty history
  await chrome.storage.local.set({ conversations, convHistory });
  return id;
}

// Load history for a specific conversation only
async function loadHistory(convId) {
  const { convHistory = {} } = await chrome.storage.local.get(['convHistory']);
  return convHistory[convId] || [];
}

// Append to isolated history (with mutex)
async function appendHistory(convId, role, text) {
  await storageMutex.lock();
  try {
    const { convHistory = {} } = await chrome.storage.local.get(['convHistory']);
    if (!convHistory[convId]) convHistory[convId] = [];
    convHistory[convId].push({ role, parts: [{ text }] });
    await chrome.storage.local.set({ convHistory });
  } finally { storageMutex.unlock(); }
}
```

---

## Worker Registration & Lifecycle

```js
// Spawn a worker — always use UUID, never reuse IDs
const wid = "agent_" + crypto.randomUUID();

const { activeWorkers = {} } = await chrome.storage.local.get([
  "activeWorkers",
]);
activeWorkers[wid] = {
  id: wid,
  url: targetUrl,
  task: taskDescription,
  status: "running", // 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  logs: [],
  finalReport: null,
  spawnedAt: Date.now(),
  conversationId: convId, // ← CRITICAL: prevents cross-conversation leakage
};
await chrome.storage.local.set({ activeWorkers });

// Open tab and start loop
chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
  runSwarmWorkerLoop(wid, tab.id, taskDescription, convId);
});
```

---

## Gemini API Call Pattern

```js
async function callGeminiAPI(
  systemPrompt,
  messages,
  retries = 3,
  delay = 2000,
) {
  const token = await getValidToken();
  if (!token) throw new Error("Missing OAuth token");

  const { aiModel = "gemini-2.0-flash" } = await chrome.storage.local.get([
    "aiModel",
  ]);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${aiModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages,
        generationConfig: {
          responseMimeType: "application/json", // force JSON output
          temperature: 0.7,
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_NONE",
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_NONE",
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    if ([429, 500, 503].includes(response.status) && retries > 0) {
      await new Promise((r) => setTimeout(r, delay));
      return callGeminiAPI(systemPrompt, messages, retries - 1, delay * 2);
    }
    throw new Error(`Gemini ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty Gemini response");
  return text;
}
```

### Gemini Message Format

```js
// messages array passed to Gemini:
const messages = [
  { role: "user", parts: [{ text: "User turn text" }] },
  { role: "model", parts: [{ text: '{"action":"..."}' }] },
  { role: "user", parts: [{ text: "Tool result feedback" }] },
  // ...append and repeat
];
```

---

## JSON Response Parser (robust)

````js
function parseJSON(raw) {
  try {
    return JSON.parse(
      raw
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim(),
    );
  } catch {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {}
    return null;
  }
}
````

---

## executeScript DOM Actions (from background)

```js
// Read page content + assign data-ai-id to elements
async function scriptReadPage(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      /* READ_PAGE_FUNC inline */
    },
  });
  return res?.result || "(empty)";
}

// Interact with an element by its data-ai-id
async function scriptInteract(tabId, id, typeText = null, pressEnter = false) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (elId, txt, doEnter) => {
      const el = document.querySelector(`[data-ai-id="${elId}"]`);
      if (!el) return { ok: false, msg: `ID ${elId} not found` };
      // ... interact logic
    },
    args: [String(id), typeText, pressEnter],
  });
  return res?.result || { ok: false };
}

// Wait for tab navigation to complete
async function waitForTab(tabId, timeout = 12000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const poll = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return resolve(false);
        if (tab.status === "complete") return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 300);
      });
    };
    poll();
  });
}
```

---

## Worker Loop Skeleton

```js
async function runSwarmWorkerLoop(workerId, tabId, task, convId) {
  const history = [];
  const MAX_STEPS = 20;

  for (let step = 0; step < MAX_STEPS; step++) {
    heartbeat(); // ← reset MV3 idle timer every iteration

    // Check cancellation
    const { activeWorkers = {} } = await chrome.storage.local.get([
      "activeWorkers",
    ]);
    const w = activeWorkers[workerId];
    if (!w || ["cancelled", "error"].includes(w.status)) break;

    // Call Gemini
    let raw;
    try {
      raw = await callGeminiAPI(WORKER_SYSTEM_PROMPT, history);
    } catch (e) {
      await updDirect(workerId, { status: "error", errorMsg: e.message });
      break;
    }

    // Parse action
    const parsed = parseJSON(raw);
    history.push({ role: "model", parts: [{ text: raw }] });

    if (!parsed) {
      history.push({
        role: "user",
        parts: [{ text: "⚠️ Invalid JSON. Retry with valid JSON." }],
      });
      continue;
    }

    const { action, parameters, thought } = parsed;
    upd(workerId, { logs: [...(w.logs || []), { action, thought, step }] });

    if (action === "done") {
      await updDirect(workerId, {
        status: "done",
        finalReport: parameters?.text,
      });
      chrome.tabs.remove(tabId).catch(() => {});
      return parameters?.text;
    }

    if (action === "open_url") {
      await chrome.tabs.update(tabId, { url: parameters.url });
      await waitForTab(tabId);
      const pageContent = await scriptReadPage(tabId);
      history.push({
        role: "user",
        parts: [{ text: `✅ Opened: ${parameters.url}\n\n${pageContent}` }],
      });
      upd(workerId, { url: parameters.url });
      continue;
    }

    if (action === "click_element") {
      const result = await scriptInteract(tabId, parameters.id);
      await waitForTab(tabId);
      const pageContent = await scriptReadPage(tabId);
      history.push({
        role: "user",
        parts: [
          {
            text: `${result.ok ? "✅" : "❌"} ${result.msg}\n\n${pageContent}`,
          },
        ],
      });
      continue;
    }

    if (action === "read_page") {
      const pageContent = await scriptReadPage(tabId);
      history.push({ role: "user", parts: [{ text: pageContent }] });
      continue;
    }

    if (action === "pause") {
      await updDirect(workerId, {
        status: "paused",
        errorMsg: parameters?.message,
      });
      // Loop pauses here — resume_worker message will call resumeSwarmWorker()
      return;
    }
  }

  // Max steps exceeded
  await updDirect(workerId, {
    status: "error",
    errorMsg: "Max steps exceeded",
  });
}
```

---

## Pause / Resume Pattern

```js
// Store the resolve function so it can be called externally
const pausedWorkers = {}; // in-memory during SW lifetime

async function pauseWorker(workerId, message) {
  await updDirect(workerId, { status: "paused", errorMsg: message });
  return new Promise((resolve) => {
    pausedWorkers[workerId] = resolve;
  });
}

// Called from message hub on 'resume_worker'
function resumeSwarmWorker(workerId, humanMessage) {
  const resolve = pausedWorkers[workerId];
  if (resolve) {
    delete pausedWorkers[workerId];
    resolve(humanMessage);
  }
}
```

---

## Message Hub: Critical Actions

| Action                | Storage Access                        | sendResponse?   |
| --------------------- | ------------------------------------- | --------------- |
| `manager_prompt`      | convHistory read/write                | Yes (async)     |
| `new_conversation`    | conversations + convHistory           | Yes             |
| `delete_conversation` | all three keys + mutex                | Yes             |
| `stop_worker`         | activeWorkers + mutex                 | Yes             |
| `resume_worker`       | none (in-memory resolve)              | Yes (immediate) |
| `clear_workers`       | clears pendingUpdates + activeWorkers | Yes             |

---

## Common Bugs & Fixes

| Bug                                           | Root Cause                                           | Fix                                                                      |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Worker freezes mid-loop                       | MV3 SW killed by idle timeout                        | Add `heartbeat()` inside every loop iteration                            |
| Workers appear in wrong conversation          | Missing `conversationId` field                       | Always set `conversationId` on worker registration                       |
| Storage write race condition                  | Parallel `get` → mutate → `set`                      | Wrap with `storageMutex`                                                 |
| Stale `done` status replaced by batched write | `upd()` used for terminal states                     | Use `updDirect()` for `done/error/paused`                                |
| `clear_workers` doesn't remove all workers    | `pendingWorkerUpdates` still in memory               | Always clear `pendingWorkerUpdates` before `clear_workers` storage write |
| Gemini returns non-JSON text                  | Model occasionally ignores `responseMimeType`        | Use `parseJSON()` with regex fallback, never `JSON.parse()` raw          |
| Tab navigates before read completes           | `scriptReadPage` called before `status === complete` | Always `await waitForTab(tabId)` after navigation                        |
