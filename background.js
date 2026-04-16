// background.js v5 — Swarm Orchestrator Architecture
// ═══════════════════════════════════════════════════════════
// Supports: Task Queue, Parallel Agents, Specialist Skills,
//           Watchdog Timeouts, Human-in-the-Loop Roadmaps
// ═══════════════════════════════════════════════════════════

import { storageMutex } from "./src/core/storage.js";
import { generateUUID } from "./src/utils/helpers.js";
import { handleLogin } from "./src/core/auth.js";
import {
  runSingleAgent,
  runManagerOrchestrator,
  runSwarmWorkerLoop,
  resumeSwarmWorker,
  runAgentlessResearch,
} from "./src/core/swarm.js";
import { SwarmOrchestrator } from "./src/core/orchestrator.js";
import { FeedbackLoopManager } from "./src/core/feedback-loop.js";

// ═══════════════════════════════════════════════════════════
// ORCHESTRATOR INSTANCE (singleton)
// ═══════════════════════════════════════════════════════════
const orchestrator = new SwarmOrchestrator();

// ═══════════════════════════════════════════════════════════
// FEEDBACK LOOP MANAGER (singleton)
// ═══════════════════════════════════════════════════════════
const feedbackLoop = new FeedbackLoopManager();

// ─── KEEPALIVE: Prevents MV3 service worker from dying mid-loop ───
chrome.alarms.create("swarm_keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "swarm_keepalive") {
    heartbeat();
  }
});

// Resets the 30-second MV3 idle timer
function heartbeat() {
  try {
    chrome.runtime.getPlatformInfo(() => {});
  } catch (e) {
    /* noop */
  }
}

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ═══════════════════════════════════════════════════════════
// MESSAGE HUB
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ─────────────────────────────────────────────────────
  // SECTION 1: AUTH
  // ─────────────────────────────────────────────────────

  if (request.action === "login") {
    handleLogin(request.interactive, sendResponse, request.expectedEmail);
    return true;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 2: LEGACY AGENTS (backward compatible)
  // ─────────────────────────────────────────────────────

  if (request.action === "prompt") {
    runSingleAgent(request.text, sendResponse);
    return true;
  }

  if (request.action === "manager_prompt") {
    const mode = request.researchMode || "none";
    if (mode !== "none") {
      runAgentlessResearch(
        request.text,
        request.conversationId || "default",
        mode,
        sendResponse,
      );
    } else {
      runManagerOrchestrator(
        request.text,
        request.conversationId || "default",
        sendResponse,
      );
    }
    return true;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 3: NEW ORCHESTRATOR — Task Queue & Parallel Agents
  // ─────────────────────────────────────────────────────

  /**
   * Start a complex project — generates a roadmap and waits for user approval.
   * Dashboard sends: { action: 'orchestrator_start', text: '...', conversationId: '...' }
   */
  if (request.action === "orchestrator_start") {
    (async () => {
      try {
        const roadmap = await orchestrator.startProject(
          request.text,
          request.conversationId,
        );
        sendResponse({ success: true, roadmap });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  /**
   * Enqueue a single task with a specific skill.
   * Dashboard sends: { action: 'orchestrator_enqueue', taskDef: { skill, url, task, conversationId } }
   */
  if (request.action === "orchestrator_enqueue") {
    const taskId = orchestrator.enqueueTask(request.taskDef);
    sendResponse({ success: true, taskId });
    return true;
  }

  /**
   * Get orchestrator queue and agent status.
   * Dashboard sends: { action: 'orchestrator_status' }
   */
  if (request.action === "orchestrator_status") {
    sendResponse({
      queue: orchestrator.getQueueStatus(),
      agents: orchestrator.getActiveAgentsSummary(),
    });
    return true;
  }

  /**
   * Force-kill a specific agent.
   * Dashboard sends: { action: 'orchestrator_kill_agent', agentId: '...' }
   */
  if (request.action === "orchestrator_kill_agent") {
    (async () => {
      await orchestrator.killAgent(request.agentId);
      sendResponse({ success: true });
    })();
    return true;
  }

  /**
   * Kill all agents and clear the queue.
   * Dashboard sends: { action: 'orchestrator_kill_all' }
   */
  if (request.action === "orchestrator_kill_all") {
    (async () => {
      await orchestrator.killAll();
      sendResponse({ success: true });
    })();
    return true;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 4: HUMAN-IN-THE-LOOP — Roadmap Commands
  // ─────────────────────────────────────────────────────

  /**
   * CONTINUE: Approve the checkpoint and proceed to the next roadmap step.
   * Dashboard sends: { action: 'roadmap_continue', conversationId: '...' }
   */
  if (request.action === "roadmap_continue") {
    (async () => {
      try {
        const next = await orchestrator.continueProject(request.conversationId);
        sendResponse({ success: true, next });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  /**
   * RETRY: Discard last result and re-run the current step.
   * Dashboard sends: { action: 'roadmap_retry', conversationId: '...', instructions: '...' }
   */
  if (request.action === "roadmap_retry") {
    (async () => {
      try {
        const retry = await orchestrator.retryProjectStep(
          request.conversationId,
          request.instructions || null,
        );
        sendResponse({ success: true, retry });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  /**
   * EDIT_ROADMAP: Replace remaining steps with a new array.
   * Dashboard sends: { action: 'roadmap_edit', conversationId: '...', newSteps: [...] }
   */
  if (request.action === "roadmap_edit") {
    (async () => {
      try {
        const updated = await orchestrator.editProjectRoadmap(
          request.conversationId,
          request.newSteps,
        );
        sendResponse({ success: true, roadmap: updated });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  /**
   * GET_ROADMAP: Fetch the current roadmap state for a conversation.
   * Dashboard sends: { action: 'get_roadmap', conversationId: '...' }
   */
  if (request.action === "get_roadmap") {
    (async () => {
      const roadmap = await orchestrator.roadmap.getRoadmap(
        request.conversationId,
      );
      sendResponse({ roadmap });
    })();
    return true;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 5: MANAGER AGENT (CEO) — Hierarchical Orchestration
  // ─────────────────────────────────────────────────────

  /**
   * Start a hierarchical goal — CEO decomposes and delegates.
   */
  if (request.action === "manager_start_goal") {
    (async () => {
      try {
        const result = await orchestrator.manager.startGoal(
          request.text,
          request.conversationId
        );
        sendResponse({ success: true, ...result });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  /**
   * Delegate a specific sub-task to an agent.
   */
  if (request.action === "manager_delegate_task") {
    (async () => {
      try {
        const taskId = await orchestrator.manager.delegateTask(
          request.goalId,
          request.taskDef,
          orchestrator
        );
        sendResponse({ success: true, taskId });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  /**
   * Get the status of a hierarchical goal.
   */
  if (request.action === "manager_goal_status") {
    const status = orchestrator.manager.getGoalStatus(request.goalId);
    sendResponse({ success: true, status });
    return true;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 6: FEEDBACK LOOP & PERFORMANCE
  // ─────────────────────────────────────────────────────

  /**
   * Record a user rating for an agent.
   */
  if (request.action === "feedback_rate_agent") {
    (async () => {
      try {
        await feedbackLoop.recordUserRating(
          request.agentType,
          request.taskId,
          request.rating,
          request.feedback
        );
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  /**
   * Get performance report for the dashboard.
   */
  if (request.action === "feedback_get_report") {
    (async () => {
      const report = await feedbackLoop.generatePerformanceReport();
      sendResponse({ success: true, report });
    })();
    return true;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 7: AGENT HEARTBEAT & STATUS (from content-agent.js)
  // ─────────────────────────────────────────────────────

  /**
   * Heartbeat from a content agent — resets the watchdog timer.
   * Content-agent sends: { action: 'agent_heartbeat', agentId: '...' }
   */
  if (request.action === "agent_heartbeat") {
    orchestrator.handleAgentHeartbeat(request.agentId);
    // No sendResponse needed — fire-and-forget
    return false;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 8: CONVERSATIONS (unchanged from v4)
  // ─────────────────────────────────────────────────────

  if (request.action === "list_conversations") {
    (async () => {
      const data = await chrome.storage.local.get(["conversations"]);
      sendResponse({ conversations: data.conversations || [] });
    })();
    return true;
  }

  // --- יצירת שיחה חדשה והכנת מחסן זיכרון מבודד ---
  if (request.action === "new_conversation") {
    (async () => {
      const data = await chrome.storage.local.get([
        "conversations",
        "convHistory",
      ]);
      const convs = data.conversations || [];
      const hist = data.convHistory || {};

      const id = generateUUID();
      convs.unshift({
        id,
        title: request.title || "שיחה חדשה",
        createdAt: Date.now(),
      });
      hist[id] = [];

      await chrome.storage.local.set({
        conversations: convs,
        convHistory: hist,
      });
      sendResponse({ id });
    })();
    return true;
  }

  // --- שיגור סוכן חדש עם שיוך מוחלט לשיחה ---
  if (request.action === "spawn_worker") {
    const { url: wurl, task: wtask, conversationId } = request.parameters;
    const wid = "agent_" + generateUUID();

    (async () => {
      await storageMutex.lock();
      try {
        const { activeWorkers = {} } = await chrome.storage.local.get([
          "activeWorkers",
        ]);

        activeWorkers[wid] = {
          id: wid,
          url: wurl,
          task: wtask,
          status: "running",
          logs: [],
          finalReport: null,
          spawnedAt: Date.now(),
          conversationId: conversationId,
        };

        await chrome.storage.local.set({ activeWorkers });
      } finally {
        storageMutex.unlock();
      }
      chrome.tabs.create({ url: wurl, active: false }, (tab) =>
        runSwarmWorkerLoop(wid, tab.id, wtask),
      );
    })();
  }

  if (request.action === "rename_conversation") {
    (async () => {
      const data = await chrome.storage.local.get(["conversations"]);
      const convs = data.conversations || [];
      const c = convs.find((x) => x.id === request.id);
      if (c) c.title = request.title;
      await chrome.storage.local.set({ conversations: convs });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === "delete_conversation") {
    (async () => {
      await storageMutex.lock();
      try {
        const data = await chrome.storage.local.get([
          "conversations",
          "convHistory",
          "activeWorkers",
        ]);
        const convs = (data.conversations || []).filter(
          (x) => x.id !== request.id,
        );
        const hist = data.convHistory || {};
        delete hist[request.id];

        await chrome.storage.local.set({
          conversations: convs,
          convHistory: hist,
          activeWorkers: data.activeWorkers || {},
        });
      } finally {
        storageMutex.unlock();
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === "load_conversation_history") {
    (async () => {
      const data = await chrome.storage.local.get(["convHistory"]);
      const hist = data.convHistory || {};
      sendResponse({ messages: hist[request.id] || [] });
    })();
    return true;
  }

  // ─────────────────────────────────────────────────────
  // SECTION 9: WORKER MANAGEMENT (unchanged from v4)
  // ─────────────────────────────────────────────────────

  if (request.action === "stop_worker") {
    (async () => {
      await storageMutex.lock();
      try {
        const data = await chrome.storage.local.get(["activeWorkers"]);
        const aw = data.activeWorkers || {};
        if (aw[request.workerId]) {
          aw[request.workerId].status = "cancelled";
          aw[request.workerId].errorMsg = 'בוטל ע"י המשתמש';
          await chrome.storage.local.set({ activeWorkers: aw });
        }
      } finally {
        storageMutex.unlock();
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === "clear_workers") {
    import("./src/core/storage.js").then(({ clearPendingUpdates }) =>
      clearPendingUpdates(),
    );

    (async () => {
      await storageMutex.lock();
      try {
        await chrome.storage.local.set({ activeWorkers: {} });
      } finally {
        storageMutex.unlock();
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === "resume_worker") {
    resumeSwarmWorker(
      request.workerId,
      request.humanMessage || "המשתמש טיפל בבעיה. המשך מהנקודה שעצרת.",
    );
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "clear_history") {
    (async () => {
      await storageMutex.lock();
      try {
        const data = await chrome.storage.local.get(["activeWorkers"]);
        await chrome.storage.local.set({
          chatHistory: [],
          activeWorkers: {},
          managerHistory: [],
          conversations: [],
          convHistory: {},
        });
      } finally {
        storageMutex.unlock();
      }
      sendResponse({ success: true });
    })();
    return true;
  }
});
