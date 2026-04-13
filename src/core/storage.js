/**
 * @fileoverview Storage management with mutex for race condition prevention
 * @description Handles all Chrome storage operations with proper locking mechanism
 */

/**
 * Async Mutex class for preventing race conditions in storage operations
 */
class AsyncMutex {
  constructor() {
    this.queue = [];
    this.locked = false;
  }

  /**
   * Acquire lock - waits if already locked
   * @returns {Promise<void>}
   */
  async lock() {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  /**
   * Release lock and process next in queue
   */
  unlock() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.locked = false;
    }
  }
}

// Global storage mutex instance
export const storageMutex = new AsyncMutex();

// Batched storage updater for performance optimization
const pendingWorkerUpdates = {};
let batchUpdateTimer = null;

/**
 * Batched storage write - merges patches in memory and flushes once per 500ms
 * NOTE: Do NOT pass large objects like `savedMessages` through here.
 * Use updDirect() for immediate critical writes (pause/resume/done).
 *
 * @param {string} workerId - Worker ID to update
 * @param {Object} patch - Partial update object
 */
export function updateWorker(workerId, patch) {
  if (!pendingWorkerUpdates[workerId]) {
    pendingWorkerUpdates[workerId] = {};
  }
  Object.assign(pendingWorkerUpdates[workerId], patch);

  if (!batchUpdateTimer) {
    batchUpdateTimer = setTimeout(async () => {
      batchUpdateTimer = null;
      const updates = { ...pendingWorkerUpdates };

      // Clear pending updates
      for (let k in pendingWorkerUpdates) {
        delete pendingWorkerUpdates[k];
      }

      await storageMutex.lock();
      try {
        const { activeWorkers = {} } = await chrome.storage.local.get([
          "activeWorkers",
        ]);
        for (const wid in updates) {
          if (!activeWorkers[wid]) {
            activeWorkers[wid] = {};
          }
          Object.assign(activeWorkers[wid], updates[wid]);
        }
        await chrome.storage.local.set({ activeWorkers });
      } finally {
        storageMutex.unlock();
      }
    }, 500);
  }
}

/**
 * Direct (immediate) storage write for critical state transitions
 * Use for: pause, done, error, resume - states that must persist immediately
 *
 * @param {string} workerId - Worker ID to update
 * @param {Object} patch - Partial update object
 */
export async function updateWorkerDirect(workerId, patch) {
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

/**
 * Clear all pending worker updates (used when clearing all workers)
 */
export function clearPendingUpdates() {
  for (const k in pendingWorkerUpdates) {
    delete pendingWorkerUpdates[k];
  }
  if (batchUpdateTimer) {
    clearTimeout(batchUpdateTimer);
    batchUpdateTimer = null;
  }
}

/**
 * Get conversation history by ID
 * @param {string} conversationId - Conversation ID
 * @returns {Promise<Array>} Message history
 */
export async function getConversationHistory(conversationId) {
  const data = await chrome.storage.local.get(["convHistory"]);
  const hist = data.convHistory || {};
  return hist[conversationId] || [];
}

/**
 * Save conversation history
 * @param {string} conversationId - Conversation ID
 * @param {Array} messages - Message array
 */
export async function saveConversationHistory(conversationId, messages) {
  await storageMutex.lock();
  try {
    const data = await chrome.storage.local.get(["convHistory"]);
    const hist = data.convHistory || {};
    hist[conversationId] = messages;
    await chrome.storage.local.set({ convHistory: hist });
  } finally {
    storageMutex.unlock();
  }
}

/**
 * Get all conversations
 * @returns {Promise<Array>} Conversations list
 */
export async function getAllConversations() {
  const data = await chrome.storage.local.get(["conversations"]);
  return data.conversations || [];
}

/**
 * Get active workers
 * @returns {Promise<Object>} Active workers object
 */
export async function getActiveWorkers() {
  const data = await chrome.storage.local.get(["activeWorkers"]);
  return data.activeWorkers || {};
}

/**
 * Get logged in email
 * @returns {Promise<string|null>} Email or null
 */
export async function getLoggedInEmail() {
  const data = await chrome.storage.local.get(["loggedInEmail"]);
  return data.loggedInEmail || null;
}

/**
 * Set logged in email
 * @param {string} email - User email
 */
export async function setLoggedInEmail(email) {
  await chrome.storage.local.set({ loggedInEmail: email });
}
