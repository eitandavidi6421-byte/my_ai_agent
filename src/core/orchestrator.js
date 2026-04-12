/**
 * @fileoverview Swarm Orchestrator — Core Engine
 * @description Class-based manager that coordinates parallel specialist agents,
 *   enforces watchdog timeouts, and integrates with the RoadmapManager for
 *   human-in-the-loop project execution.
 *
 * Architecture:
 *   SwarmOrchestrator
 *     ├── taskQueue[]           — FIFO queue of pending tasks
 *     ├── activeAgents Map      — agentId → { tabId, skill, task, watchdogTimer, ... }
 *     ├── RoadmapManager        — step-by-step project execution
 *     └── Event Broadcasting    — sends UI updates via chrome.runtime.sendMessage
 */

import { storageMutex, updateWorker as upd, updateWorkerDirect as updDirect } from './storage.js';
import { callGeminiAPI } from './api.js';
import { parseJSON, sanitizeHistory, isRefusal, getRefusalOverrideMessage } from '../utils/helpers.js';
import { getSkill, getSkillPrompt, isActionAllowed } from './skills.js';
import { RoadmapManager } from './roadmap.js';
import { executeAction } from './swarm.js';
import {
    broadcast, Events,
    emitAgentSpawned, emitAgentLog, emitAgentStatus,
    emitAgentDone, emitAgentError, emitAgentTimeout,
    emitRoadmapUpdate,
} from './events.js';
import { waitForTab, scriptReadPage } from '../dom/dom-engine.js';

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

/** Maximum agents running in parallel */
const MAX_CONCURRENT = 4;

/** Default watchdog timeout (ms) — overridden by skill.timeoutMs */
const DEFAULT_WATCHDOG_MS = 45_000;

/** Maximum retries per task before marking as failed */
const MAX_RETRIES = 3;

/** Maximum worker loop iterations per agent */
const MAX_WORKER_STEPS = 35;

/** Rate-limit delay between agent spawns (ms) */
const SPAWN_DELAY_MS = 2000;

// ═══════════════════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════════════════

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function heartbeat() {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* noop */ }
}

// ═══════════════════════════════════════════════════════════
// SWARM ORCHESTRATOR CLASS
// ═══════════════════════════════════════════════════════════

export class SwarmOrchestrator {
    constructor() {
        /**
         * FIFO task queue.
         * @type {Array<TaskDefinition>}
         *
         * @typedef {Object} TaskDefinition
         * @property {string} id              - Unique task ID
         * @property {string} skill           - 'researcher' | 'action_writer' | 'google_manager'
         * @property {string} url             - Target URL
         * @property {string} task            - Detailed task description
         * @property {string} conversationId  - Owning conversation
         * @property {number} retryCount      - Current retry count
         * @property {number} maxRetries      - Max retries before failure
         * @property {number} [roadmapStepIndex] - If from a roadmap, which step index
         */
        this.taskQueue = [];

        /**
         * Active agents registry (in-memory).
         * @type {Map<string, AgentState>}
         *
         * @typedef {Object} AgentState
         * @property {string} id              - Agent ID
         * @property {number} tabId           - Chrome tab ID
         * @property {string} skill           - Skill name
         * @property {string} task            - Task text
         * @property {string} conversationId  - Owning conversation
         * @property {number} spawnedAt       - Timestamp
         * @property {number|null} watchdogTimer - setTimeout ID for the watchdog
         * @property {number} [roadmapStepIndex] - Roadmap step index (if applicable)
         */
        this.activeAgents = new Map();

        /**
         * Roadmap manager for human-in-the-loop projects.
         */
        this.roadmap = new RoadmapManager();

        /**
         * Processing state to prevent concurrent processQueue calls.
         */
        this._processing = false;

        console.log('[Orchestrator] Initialized');
    }

    // ═══════════════════════════════════════════════════════
    // TASK QUEUE
    // ═══════════════════════════════════════════════════════

    /**
     * Add a task to the queue and trigger processing.
     *
     * @param {Object} taskDef - Task definition
     * @param {string} taskDef.skill - 'researcher' | 'action_writer' | 'google_manager'
     * @param {string} taskDef.url - Target URL
     * @param {string} taskDef.task - Detailed instructions
     * @param {string} taskDef.conversationId - Conversation ID
     * @param {number} [taskDef.roadmapStepIndex] - Roadmap step index
     * @returns {string} Generated task ID
     */
    enqueueTask(taskDef) {
        const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const fullTask = {
            id: taskId,
            skill: taskDef.skill || 'researcher',
            url: taskDef.url || 'about:blank',
            task: taskDef.task,
            conversationId: taskDef.conversationId,
            retryCount: taskDef.retryCount || 0,
            maxRetries: taskDef.maxRetries || MAX_RETRIES,
            roadmapStepIndex: taskDef.roadmapStepIndex,
        };

        this.taskQueue.push(fullTask);
        console.log(`[Orchestrator] Enqueued task ${taskId} (skill: ${fullTask.skill}, queue: ${this.taskQueue.length})`);

        // Trigger queue processing (non-blocking)
        this.processQueue();

        return taskId;
    }

    /**
     * Process the task queue — spawn agents up to MAX_CONCURRENT.
     * This is called whenever a task is enqueued or an agent completes.
     */
    async processQueue() {
        if (this._processing) return;
        this._processing = true;

        try {
            while (this.taskQueue.length > 0 && this.activeAgents.size < MAX_CONCURRENT) {
                const taskDef = this.taskQueue.shift();
                await this.spawnAgent(taskDef);
                await sleep(SPAWN_DELAY_MS); // Rate-limit between spawns
            }

            // Broadcast queue state
            if (this.taskQueue.length === 0 && this.activeAgents.size === 0) {
                broadcast(Events.ORCHESTRATOR_IDLE);
            } else {
                broadcast(Events.ORCHESTRATOR_BUSY, {
                    queueLength: this.taskQueue.length,
                    activeCount: this.activeAgents.size,
                });
            }
        } finally {
            this._processing = false;
        }
    }

    // ═══════════════════════════════════════════════════════
    // AGENT SPAWNING
    // ═══════════════════════════════════════════════════════

    /**
     * Spawn a new agent in a background tab with a specific skill.
     *
     * @param {TaskDefinition} taskDef
     * @returns {Promise<string>} The agent ID
     */
    async spawnAgent(taskDef) {
        const agentId = `agent_${taskDef.skill}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const skill = getSkill(taskDef.skill);

        if (!skill) {
            console.error(`[Orchestrator] Unknown skill: ${taskDef.skill}`);
            return null;
        }

        console.log(`[Orchestrator] Spawning ${agentId} (${skill.name}) → ${taskDef.url}`);

        // Register in storage FIRST (so dashboard sees it immediately)
        await storageMutex.lock();
        try {
            const { activeWorkers = {} } = await chrome.storage.local.get(['activeWorkers']);
            activeWorkers[agentId] = {
                id: agentId,
                url: taskDef.url,
                task: taskDef.task,
                skill: taskDef.skill,
                status: 'running',
                logs: [],
                finalReport: null,
                spawnedAt: Date.now(),
                conversationId: taskDef.conversationId,
                roadmapStepIndex: taskDef.roadmapStepIndex,
            };
            await chrome.storage.local.set({ activeWorkers });
        } finally {
            storageMutex.unlock();
        }

        // Open background tab
        const tab = await new Promise(resolve => {
            chrome.tabs.create({ url: taskDef.url, active: false }, resolve);
        });

        // Register agent in memory
        const agentState = {
            id: agentId,
            tabId: tab.id,
            skill: taskDef.skill,
            task: taskDef.task,
            conversationId: taskDef.conversationId,
            spawnedAt: Date.now(),
            watchdogTimer: null,
            roadmapStepIndex: taskDef.roadmapStepIndex,
            retryCount: taskDef.retryCount,
            maxRetries: taskDef.maxRetries,
        };
        this.activeAgents.set(agentId, agentState);

        // Start the watchdog timer
        this.startWatchdog(agentId);

        // Emit event for UI
        emitAgentSpawned(agentId, taskDef.skill, taskDef.task, taskDef.url);

        // Send skill initialization to content script
        // (wait for tab to be ready first, then inject and init)
        this._runAgentLoop(agentId, tab.id, taskDef);

        return agentId;
    }

    // ═══════════════════════════════════════════════════════
    // WATCHDOG / TIMEOUT
    // ═══════════════════════════════════════════════════════

    /**
     * Start the watchdog timer for an agent.
     * If no heartbeat or completion within the timeout, the agent is killed.
     *
     * @param {string} agentId
     */
    startWatchdog(agentId) {
        const agent = this.activeAgents.get(agentId);
        if (!agent) return;

        const skill = getSkill(agent.skill);
        const timeoutMs = skill?.timeoutMs || DEFAULT_WATCHDOG_MS;

        // Clear existing timer if any
        if (agent.watchdogTimer) {
            clearTimeout(agent.watchdogTimer);
        }

        agent.watchdogTimer = setTimeout(() => {
            this.onWatchdogTimeout(agentId);
        }, timeoutMs);
    }

    /**
     * Reset the watchdog timer (called on heartbeat or agent activity).
     *
     * @param {string} agentId
     */
    resetWatchdog(agentId) {
        const agent = this.activeAgents.get(agentId);
        if (!agent) return;

        // Clear and restart
        if (agent.watchdogTimer) {
            clearTimeout(agent.watchdogTimer);
        }
        this.startWatchdog(agentId);
    }

    /**
     * Watchdog timeout handler.
     * Kills the agent tab, returns the task to the queue (if retries remain),
     * and spawns a replacement.
     *
     * @param {string} agentId
     */
    async onWatchdogTimeout(agentId) {
        const agent = this.activeAgents.get(agentId);
        if (!agent) return;

        console.warn(`[Orchestrator] ⏰ Watchdog timeout for ${agentId} (${agent.skill})`);

        // 1. Kill the tab
        try {
            await chrome.tabs.remove(agent.tabId);
        } catch (e) { /* Tab may already be closed */ }

        // 2. Emit timeout event
        emitAgentTimeout(agentId, agent.retryCount + 1, agent.maxRetries);

        // 3. Update storage
        await updDirect(agentId, {
            status: 'error',
            errorMsg: `⏰ Watchdog timeout (${(getSkill(agent.skill)?.timeoutMs || DEFAULT_WATCHDOG_MS) / 1000}s)`,
        });

        // 4. Clean up in-memory state
        this.activeAgents.delete(agentId);

        // 5. Re-queue if retries remain
        const newRetryCount = (agent.retryCount || 0) + 1;
        if (newRetryCount < (agent.maxRetries || MAX_RETRIES)) {
            console.log(`[Orchestrator] Re-queueing task (retry ${newRetryCount}/${agent.maxRetries || MAX_RETRIES})`);
            this.enqueueTask({
                skill: agent.skill,
                url: agent.task, // Re-infer URL from task
                task: agent.task,
                conversationId: agent.conversationId,
                retryCount: newRetryCount,
                maxRetries: agent.maxRetries || MAX_RETRIES,
                roadmapStepIndex: agent.roadmapStepIndex,
            });
        } else {
            console.error(`[Orchestrator] Max retries exceeded for ${agentId}. Task failed.`);
            emitAgentError(agentId, `Max retries (${agent.maxRetries || MAX_RETRIES}) exceeded`);

            // If this was a roadmap step, mark it as error
            if (agent.roadmapStepIndex !== undefined) {
                await this.roadmap.markStepError(
                    agent.conversationId,
                    agent.roadmapStepIndex,
                    'Max retries exceeded — agent timed out repeatedly'
                );
            }
        }

        // 6. Process queue (try to spawn next task)
        this.processQueue();
    }

    // ═══════════════════════════════════════════════════════
    // AGENT EVENT HANDLERS (from message hub)
    // ═══════════════════════════════════════════════════════

    /**
     * Handle heartbeat from a content agent.
     * Resets the watchdog timer to prevent timeout.
     *
     * @param {string} agentId
     */
    handleAgentHeartbeat(agentId) {
        if (this.activeAgents.has(agentId)) {
            this.resetWatchdog(agentId);
        }
    }

    /**
     * Handle agent completion.
     * Cleans up the agent, processes the report, and advances the roadmap if applicable.
     *
     * @param {string} agentId
     * @param {string} report - The agent's final report
     */
    async handleAgentDone(agentId, report) {
        const agent = this.activeAgents.get(agentId);
        if (!agent) return;

        console.log(`[Orchestrator] ✅ Agent ${agentId} completed`);

        // 1. Clear watchdog
        if (agent.watchdogTimer) {
            clearTimeout(agent.watchdogTimer);
        }

        // 2. Update storage
        await updDirect(agentId, {
            status: 'done',
            finalReport: report,
        });

        // 3. Emit events
        emitAgentDone(agentId, report);
        emitAgentStatus(agentId, 'done', report.substring(0, 100));

        // 4. If this was a roadmap step, mark it done → triggers checkpoint
        if (agent.roadmapStepIndex !== undefined) {
            await this.roadmap.markStepDone(
                agent.conversationId,
                agent.roadmapStepIndex,
                report
            );
        }

        // 5. Clean up
        this.activeAgents.delete(agentId);

        // 6. Process next in queue
        this.processQueue();
    }

    /**
     * Handle agent error.
     *
     * @param {string} agentId
     * @param {string} error - Error message
     */
    async handleAgentError(agentId, error) {
        const agent = this.activeAgents.get(agentId);
        if (!agent) return;

        console.error(`[Orchestrator] ❌ Agent ${agentId} error:`, error);

        // Clear watchdog
        if (agent.watchdogTimer) {
            clearTimeout(agent.watchdogTimer);
        }

        // Update storage
        await updDirect(agentId, {
            status: 'error',
            errorMsg: error,
        });

        // Emit error
        emitAgentError(agentId, error);

        // If roadmap step, mark error
        if (agent.roadmapStepIndex !== undefined) {
            await this.roadmap.markStepError(
                agent.conversationId,
                agent.roadmapStepIndex,
                error
            );
        }

        // Clean up
        this.activeAgents.delete(agentId);
        this.processQueue();
    }

    // ═══════════════════════════════════════════════════════
    // PROJECT / ROADMAP FLOW
    // ═══════════════════════════════════════════════════════

    /**
     * Start a new project: generate a roadmap from the user's request.
     * The roadmap will be in 'pending_approval' state — user must CONTINUE
     * to begin execution.
     *
     * @param {string} userRequest - The complex user request
     * @param {string} conversationId - Conversation ID
     * @returns {Promise<Object>} The generated roadmap
     */
    async startProject(userRequest, conversationId) {
        console.log(`[Orchestrator] Starting project for conversation ${conversationId}`);
        const roadmap = await this.roadmap.generateRoadmap(userRequest, conversationId);
        return roadmap;
    }

    /**
     * Continue the roadmap: execute the next pending step.
     * Called when the dashboard sends CONTINUE after a checkpoint.
     *
     * @param {string} conversationId
     * @returns {Promise<Object|null>} The step being executed, or null if done
     */
    async continueProject(conversationId) {
        const next = await this.roadmap.continueRoadmap(conversationId);
        if (!next) {
            console.log('[Orchestrator] Roadmap completed or no next step');
            return null;
        }

        const { step, index } = next;

        // Collect context from previous steps
        const previousResults = await this.roadmap.collectPreviousResults(conversationId);
        const enrichedTask = previousResults
            ? `${step.description}\n\n--- Context from previous steps ---\n${previousResults}`
            : step.description;

        // Mark step as running
        await this.roadmap.markStepRunning(conversationId, index);

        // Enqueue the task
        this.enqueueTask({
            skill: step.skill,
            url: step.url || 'about:blank',
            task: enrichedTask,
            conversationId,
            roadmapStepIndex: index,
        });

        return { step, index };
    }

    /**
     * Retry the current roadmap step.
     *
     * @param {string} conversationId
     * @param {string} [instructions] - Optional updated instructions
     * @returns {Promise<Object|null>}
     */
    async retryProjectStep(conversationId, instructions = null) {
        const retry = await this.roadmap.retryStep(conversationId, instructions);
        if (!retry) return null;

        const { step, index } = retry;
        const previousResults = await this.roadmap.collectPreviousResults(conversationId);
        const enrichedTask = previousResults
            ? `${step.description}\n\n--- Context from previous steps ---\n${previousResults}`
            : step.description;

        await this.roadmap.markStepRunning(conversationId, index);

        this.enqueueTask({
            skill: step.skill,
            url: step.url || 'about:blank',
            task: enrichedTask,
            conversationId,
            roadmapStepIndex: index,
        });

        return { step, index };
    }

    /**
     * Edit the roadmap: replace remaining steps.
     *
     * @param {string} conversationId
     * @param {Array} newSteps - New step definitions
     * @returns {Promise<Object>}
     */
    async editProjectRoadmap(conversationId, newSteps) {
        return this.roadmap.editRoadmap(conversationId, newSteps);
    }

    // ═══════════════════════════════════════════════════════
    // WORKER LOOP (runs per agent — the actual execution engine)
    // ═══════════════════════════════════════════════════════

    /**
     * Run the specialist worker loop for a spawned agent.
     * This method drives the agent through its task by repeatedly calling Gemini
     * and executing actions in the tab.
     *
     * @private
     * @param {string} agentId
     * @param {number} tabId
     * @param {TaskDefinition} taskDef
     */
    async _runAgentLoop(agentId, tabId, taskDef) {
        const skill = getSkill(taskDef.skill);
        const systemPrompt = skill ? skill.systemPrompt : '';
        const agent = this.activeAgents.get(agentId);

        let messages = [{
            role: 'user',
            parts: [{ text: `Your skill: ${taskDef.skill}\nYour task: ${taskDef.task}\n\nStart with open_url to the target site.` }]
        }];

        let done = false, loops = 0, fails = 0;
        let actionHistory = [];
        let currentLogs = [];

        // Check if agent is still alive
        const alive = async () => {
            try {
                const { activeWorkers = {} } = await chrome.storage.local.get(['activeWorkers']);
                return !!(activeWorkers[agentId]) && activeWorkers[agentId].status !== 'cancelled';
            } catch { return true; }
        };

        const closeTab = () => {
            try { chrome.tabs.remove(tabId).catch(() => null); } catch {}
        };

        try {
            // Wait for tab to load
            await waitForTab(tabId, 15000);

            while (!done && loops < MAX_WORKER_STEPS) {
                heartbeat();
                this.resetWatchdog(agentId); // Reset watchdog on every loop iteration
                loops++;

                if (!(await alive())) { closeTab(); return; }

                // ── Call Gemini with skill-specific prompt ──
                let obj;
                try {
                    const raw = await callGeminiAPI(systemPrompt, messages);
                    obj = parseJSON(raw);
                    if (!obj || !obj.action) throw new Error('Invalid JSON or missing action');
                    messages.push({ role: 'model', parts: [{ text: JSON.stringify(obj) }] });
                } catch (e) {
                    messages.push({ role: 'user', parts: [{ text: `Error: ${e.message}. Return valid JSON with action.` }] });
                    continue;
                }

                // ── Skill Action Filtering ──
                if (skill && !isActionAllowed(taskDef.skill, obj.action) && obj.action !== 'done') {
                    messages.push({
                        role: 'user',
                        parts: [{ text: `⚠️ Action "${obj.action}" is NOT allowed for your skill (${taskDef.skill}). Allowed actions: ${skill.allowedActions.join(', ')}. Use an allowed action.` }]
                    });
                    continue;
                }

                // ── Circuit Breaker — detect stuck loops ──
                const actionSignature = JSON.stringify({ a: obj.action, p: obj.parameters });
                actionHistory.push(actionSignature);
                const timesRepeated = actionHistory.filter(sig => sig === actionSignature).length;

                if (timesRepeated === 3) {
                    messages.push({ role: 'user', parts: [{ text: '🚨 You repeated the same action 3 times. Call done with whatever data you have — even partial.' }] });
                } else if (timesRepeated >= 5) {
                    const partialInfo = currentLogs.slice(-5).map(l => `${l.action}: ${l.message}`).join('\n');
                    await this.handleAgentError(agentId, `Infinite loop detected. Last actions:\n${partialInfo}`);
                    closeTab();
                    return;
                }

                // ── Log the action ──
                const logObj = {
                    thought: (obj.thought || '').substring(0, 100),
                    action: obj.action,
                    message: String(obj.parameters?.url || obj.parameters?.text || obj.parameters?.id || '').substring(0, 80),
                    step: loops,
                };
                currentLogs.push(logObj);
                if (currentLogs.length > 50) currentLogs.shift();

                upd(agentId, { logs: currentLogs, lastAction: obj.action });
                emitAgentLog(agentId, logObj);

                // ── Handle DONE ──
                if (obj.action === 'done') {
                    let finalText = obj.parameters?.text || '(empty)';
                    if (typeof finalText === 'object') finalText = JSON.stringify(finalText, null, 2);

                    // Check for AI refusal
                    if (isRefusal(finalText)) {
                        messages.push({ role: 'user', parts: [{ text: getRefusalOverrideMessage() }] });
                        continue;
                    }

                    // Close tab (unless keep_tab is requested)
                    closeTab();

                    // Notify orchestrator of completion
                    await this.handleAgentDone(agentId, finalText);
                    done = true;
                    break;
                }

                // ── Handle PAUSE_FOR_HUMAN ──
                if (obj.action === 'pause_for_human') {
                    await updDirect(agentId, {
                        status: 'paused',
                        errorMsg: obj.parameters?.message || 'Human assistance needed',
                        tabId: tabId,
                        savedMessages: messages,
                    });
                    emitAgentStatus(agentId, 'paused', obj.parameters?.message);

                    // Clear watchdog while paused
                    if (agent?.watchdogTimer) {
                        clearTimeout(agent.watchdogTimer);
                    }
                    return; // Loop exits — resume via resume_worker
                }

                // ── Execute the action ──
                const feedback = await executeAction(obj, tabId);

                // Track URL changes
                chrome.tabs.get(tabId).then(t => {
                    if (t?.url) upd(agentId, { url: t.url });
                }).catch(() => null);

                // Track consecutive failures
                if (feedback.includes('❌')) fails++; else fails = 0;
                if (fails >= 4) {
                    await this.handleAgentError(agentId, 'Failed 4 times consecutively');
                    closeTab();
                    break;
                }

                messages.push({ role: 'user', parts: [{ text: `📡 Result:\n${feedback}\n\nContinue.` }] });
                messages = sanitizeHistory(messages);
            }

            // ── Max steps exceeded ──
            if (!done) {
                const isRunning = await alive();
                if (isRunning) {
                    const partialReport = currentLogs.length > 0
                        ? `⏰ Max steps (${loops}) exceeded. Partial data:\n` +
                          currentLogs.filter(l => l.message?.length > 20)
                              .map(l => `- ${l.action}: ${l.message}`).join('\n')
                        : null;

                    await this.handleAgentError(agentId, `Max steps exceeded (${loops}). ${partialReport || ''}`);
                }
                closeTab();
            }

        } catch (e) {
            console.error(`[Orchestrator] Agent ${agentId} crashed:`, e);
            await this.handleAgentError(agentId, `Crash: ${e.message}`);
            closeTab();
        }
    }

    // ═══════════════════════════════════════════════════════
    // STATUS QUERIES
    // ═══════════════════════════════════════════════════════

    /**
     * Get a summary of all active agents for the UI.
     * @returns {Array<Object>}
     */
    getActiveAgentsSummary() {
        return Array.from(this.activeAgents.values()).map(agent => ({
            id: agent.id,
            skill: agent.skill,
            task: agent.task.substring(0, 100),
            conversationId: agent.conversationId,
            spawnedAt: agent.spawnedAt,
            hasWatchdog: !!agent.watchdogTimer,
        }));
    }

    /**
     * Get queue status.
     * @returns {Object}
     */
    getQueueStatus() {
        return {
            queueLength: this.taskQueue.length,
            activeCount: this.activeAgents.size,
            maxConcurrent: MAX_CONCURRENT,
        };
    }

    /**
     * Force-kill an agent by ID.
     * @param {string} agentId
     */
    async killAgent(agentId) {
        const agent = this.activeAgents.get(agentId);
        if (!agent) return;

        if (agent.watchdogTimer) clearTimeout(agent.watchdogTimer);
        try { await chrome.tabs.remove(agent.tabId); } catch {}

        await updDirect(agentId, { status: 'cancelled', errorMsg: 'Killed by orchestrator' });
        this.activeAgents.delete(agentId);
        emitAgentStatus(agentId, 'cancelled', 'Killed by user');
    }

    /**
     * Kill all active agents and clear the queue.
     */
    async killAll() {
        // Clear queue
        this.taskQueue = [];

        // Kill all active agents
        for (const [agentId, agent] of this.activeAgents) {
            if (agent.watchdogTimer) clearTimeout(agent.watchdogTimer);
            try { await chrome.tabs.remove(agent.tabId); } catch {}
            await updDirect(agentId, { status: 'cancelled', errorMsg: 'All agents killed' });
        }
        this.activeAgents.clear();

        broadcast(Events.ORCHESTRATOR_IDLE);
        console.log('[Orchestrator] All agents killed, queue cleared');
    }
}
