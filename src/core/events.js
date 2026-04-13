/**
 * @fileoverview Event Broadcasting System for Swarm Orchestrator
 * @description Emits lifecycle events to the Dashboard UI via chrome.runtime.sendMessage.
 *   The dashboard listens for these events to render agent cards, live logs, and roadmap state.
 *
 * Usage from orchestrator:
 *   import { broadcast, Events } from './events.js';
 *   broadcast(Events.AGENT_SPAWNED, { agentId, skill, task, url });
 */

// ═══════════════════════════════════════════════════════════
// EVENT CONSTANTS
// ═══════════════════════════════════════════════════════════

/**
 * All event names emitted by the orchestrator.
 * The dashboard can `chrome.runtime.onMessage.addListener` and switch on `action`.
 */
export const Events = Object.freeze({
  // ── Agent Lifecycle ──
  AGENT_SPAWNED: "agent_spawned", // A new agent tab was opened
  AGENT_HEARTBEAT: "agent_heartbeat_ack", // Heartbeat acknowledged (watchdog reset)
  AGENT_LOG: "agent_log", // Single log entry from an agent
  AGENT_STATUS_UPDATE: "agent_status_update", // Summary status change (running/paused/done/error)
  AGENT_DONE: "agent_done_report", // Agent completed — includes final report
  AGENT_ERROR: "agent_error_report", // Agent errored out
  AGENT_TIMEOUT: "agent_timeout", // Watchdog fired — agent was killed

  // ── Roadmap / Project ──
  ROADMAP_CREATED: "roadmap_created", // A new roadmap was generated
  ROADMAP_UPDATE: "roadmap_update", // Any change to roadmap state
  ROADMAP_CHECKPOINT: "roadmap_checkpoint", // A step completed, waiting for user approval
  ROADMAP_COMPLETED: "roadmap_completed", // All steps finished

  // ── Orchestrator-level ──
  ORCHESTRATOR_BUSY: "orchestrator_busy", // Queue is being processed
  ORCHESTRATOR_IDLE: "orchestrator_idle", // Queue empty, all agents done
});

// ═══════════════════════════════════════════════════════════
// BROADCAST FUNCTION
// ═══════════════════════════════════════════════════════════

/**
 * Broadcast an event to all extension pages (popup, dashboard, side panel).
 * Uses chrome.runtime.sendMessage which delivers to every script
 * that has a chrome.runtime.onMessage listener in the extension context.
 *
 * @param {string} eventName - One of the Events.* constants
 * @param {Object} data - Event payload (merged into the message)
 */
export function broadcast(eventName, data = {}) {
  const message = {
    action: eventName,
    timestamp: Date.now(),
    ...data,
  };

  // Fire-and-forget: dashboard may or may not be open
  chrome.runtime.sendMessage(message).catch(() => {
    // Silently ignore — no listeners means dashboard is closed
  });
}

// ═══════════════════════════════════════════════════════════
// CONVENIENCE EMITTERS
// ═══════════════════════════════════════════════════════════

/**
 * Emit when a new agent is spawned.
 * UI should render a "quiet" summary card for this agent.
 *
 * @param {string} agentId - Unique agent identifier
 * @param {string} skill - 'researcher' | 'action_writer' | 'google_manager'
 * @param {string} task - Human-readable task description
 * @param {string} url - Target URL the agent was opened on
 */
export function emitAgentSpawned(agentId, skill, task, url) {
  broadcast(Events.AGENT_SPAWNED, { agentId, skill, task, url });
}

/**
 * Emit a single log entry for live-log display.
 * Only sent when the user has expanded the agent's log panel.
 *
 * @param {string} agentId - Agent identifier
 * @param {Object} entry - { thought, action, message, step }
 */
export function emitAgentLog(agentId, entry) {
  broadcast(Events.AGENT_LOG, { agentId, entry });
}

/**
 * Emit a status change for an agent summary card.
 *
 * @param {string} agentId - Agent identifier
 * @param {string} status - 'running' | 'paused' | 'done' | 'error' | 'timeout'
 * @param {string} [summary] - Short summary text for the card
 */
export function emitAgentStatus(agentId, status, summary = "") {
  broadcast(Events.AGENT_STATUS_UPDATE, { agentId, status, summary });
}

/**
 * Emit agent completion with full report.
 *
 * @param {string} agentId - Agent identifier
 * @param {string} report - Final report text
 */
export function emitAgentDone(agentId, report) {
  broadcast(Events.AGENT_DONE, { agentId, report });
}

/**
 * Emit agent error.
 *
 * @param {string} agentId - Agent identifier
 * @param {string} error - Error description
 */
export function emitAgentError(agentId, error) {
  broadcast(Events.AGENT_ERROR, { agentId, error });
}

/**
 * Emit watchdog timeout.
 *
 * @param {string} agentId - Agent identifier
 * @param {number} retryCount - How many times this task has been retried
 * @param {number} maxRetries - Maximum retries allowed
 */
export function emitAgentTimeout(agentId, retryCount, maxRetries) {
  broadcast(Events.AGENT_TIMEOUT, { agentId, retryCount, maxRetries });
}

/**
 * Emit full roadmap state to the UI.
 *
 * @param {Object} roadmap - The full roadmap object from storage
 */
export function emitRoadmapUpdate(roadmap) {
  broadcast(Events.ROADMAP_UPDATE, { roadmap });
}

/**
 * Emit a roadmap checkpoint — a step completed, awaiting user decision.
 *
 * @param {number} stepIndex - Index of the completed step
 * @param {Object} step - The completed step object (includes result)
 */
export function emitRoadmapCheckpoint(stepIndex, step) {
  broadcast(Events.ROADMAP_CHECKPOINT, { stepIndex, step });
}
