/**
 * @fileoverview Human-in-the-Loop Roadmap Manager
 * @description Manages step-by-step project execution with persistent state,
 *   checkpoints, and user approval gates. Survives popup/dashboard closure
 *   by persisting all state to chrome.storage.local.
 *
 * Storage key: `activeRoadmaps` — Object<conversationId, RoadmapState>
 */

import { storageMutex } from './storage.js';
import { callGeminiAPI } from './api.js';
import { parseJSON } from '../utils/helpers.js';
import { emitRoadmapUpdate, emitRoadmapCheckpoint, broadcast, Events } from './events.js';

// ═══════════════════════════════════════════════════════════
// ROADMAP PLANNER PROMPT
// ═══════════════════════════════════════════════════════════

const ROADMAP_PLANNER_PROMPT = `## PROJECT PLANNER — ROADMAP GENERATOR

You are a project planning AI. Given a complex user request, decompose it into a clear,
ordered list of executable steps (a "roadmap").

### Rules:
1. Each step must be a SINGLE, self-contained task that one agent can complete.
2. Assign a skill to each step: "researcher", "action_writer", or "google_manager".
3. Steps should be ordered logically — dependencies first.
4. Include a target URL when known.
5. Be specific — vague steps like "do research" are NOT acceptable.
6. Return ONLY a JSON array. No explanation.

### Skill Guide:
- **researcher**: Reading/extracting data from websites. Search Google, read articles, extract structured data.
- **action_writer**: Clicking, typing, filling forms, writing in Google Docs / rich text editors.
- **google_manager**: Google API calls — creating Drive files, Calendar events, sending Gmail.

### Output Format (JSON array):
[
  {
    "description": "Clear, actionable step description with all necessary details",
    "skill": "researcher",
    "url": "https://target-url.com or empty string if dynamic",
    "dependsOn": []
  },
  {
    "description": "Write the research findings into a Google Doc",
    "skill": "action_writer",
    "url": "https://docs.google.com/document/create",
    "dependsOn": [0]
  }
]

### Important:
- dependsOn is an array of step indices (0-based) that must complete before this step.
- If a step has no dependencies, use an empty array [].
- Maximum 10 steps per roadmap.`;

// ═══════════════════════════════════════════════════════════
// ROADMAP STATE SCHEMA
// ═══════════════════════════════════════════════════════════

/**
 * @typedef {Object} RoadmapStep
 * @property {string} id - Unique step ID (auto-generated)
 * @property {string} description - What this step does
 * @property {string} skill - 'researcher' | 'action_writer' | 'google_manager'
 * @property {string} url - Target URL (or empty)
 * @property {string} status - 'pending' | 'running' | 'done' | 'error' | 'skipped'
 * @property {string|null} result - Final report from the agent that executed this step
 * @property {number} retryCount - How many times this step has been retried
 * @property {number[]} dependsOn - Indices of steps that must complete first
 */

/**
 * @typedef {Object} RoadmapState
 * @property {string} conversationId - Owning conversation
 * @property {RoadmapStep[]} steps - Ordered list of steps
 * @property {number} currentIndex - Index of the next step to execute
 * @property {string} state - 'idle' | 'running' | 'pending_approval' | 'completed' | 'error'
 * @property {string} userRequest - Original user request text
 * @property {number} createdAt - Timestamp
 * @property {number} updatedAt - Timestamp
 */

// ═══════════════════════════════════════════════════════════
// ROADMAP MANAGER CLASS
// ═══════════════════════════════════════════════════════════

export class RoadmapManager {
    constructor() {
        // In-memory cache for fast access (mirrors storage)
        this._cache = new Map();
    }

    // ─── GENERATE ROADMAP ────────────────────────────────────

    /**
     * Generate a new roadmap from a complex user request using Gemini.
     * Persists the roadmap to chrome.storage.local.
     *
     * @param {string} userRequest - The user's complex request
     * @param {string} conversationId - Conversation to attach the roadmap to
     * @returns {Promise<RoadmapState>} The generated roadmap
     */
    async generateRoadmap(userRequest, conversationId) {
        console.log('[Roadmap] Generating roadmap for:', userRequest.substring(0, 80));

        // Call Gemini to decompose the request into steps
        const messages = [{
            role: 'user',
            parts: [{ text: `Decompose this request into a step-by-step roadmap:\n\n"${userRequest}"` }]
        }];

        const raw = await callGeminiAPI(ROADMAP_PLANNER_PROMPT, messages);
        const stepsArray = parseJSON(raw);

        if (!stepsArray || !Array.isArray(stepsArray)) {
            throw new Error('Failed to generate roadmap — Gemini returned invalid JSON');
        }

        // Build the roadmap state
        const roadmap = {
            conversationId,
            steps: stepsArray.map((step, index) => ({
                id: `step_${index}_${Date.now()}`,
                description: step.description || `Step ${index + 1}`,
                skill: step.skill || 'researcher',
                url: step.url || '',
                status: 'pending',
                result: null,
                retryCount: 0,
                dependsOn: step.dependsOn || [],
            })),
            currentIndex: 0,
            state: 'pending_approval',  // Start paused — user must approve
            userRequest,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        // Persist to storage
        await this._saveRoadmap(conversationId, roadmap);
        this._cache.set(conversationId, roadmap);

        // Notify UI
        broadcast(Events.ROADMAP_CREATED, { roadmap });
        emitRoadmapUpdate(roadmap);

        console.log(`[Roadmap] Created ${roadmap.steps.length} steps for conversation ${conversationId}`);
        return roadmap;
    }

    // ─── GET ROADMAP ─────────────────────────────────────────

    /**
     * Get the current roadmap for a conversation.
     * Checks in-memory cache first, then falls back to storage.
     *
     * @param {string} conversationId
     * @returns {Promise<RoadmapState|null>}
     */
    async getRoadmap(conversationId) {
        // Check cache first
        if (this._cache.has(conversationId)) {
            return this._cache.get(conversationId);
        }

        // Load from storage
        await storageMutex.lock();
        try {
            const { activeRoadmaps = {} } = await chrome.storage.local.get(['activeRoadmaps']);
            const roadmap = activeRoadmaps[conversationId] || null;
            if (roadmap) {
                this._cache.set(conversationId, roadmap);
            }
            return roadmap;
        } finally {
            storageMutex.unlock();
        }
    }

    // ─── EXECUTE NEXT STEP ───────────────────────────────────

    /**
     * Get the next step to execute. Advances the roadmap if possible.
     * Returns null if all steps are done or roadmap is paused.
     *
     * @param {string} conversationId
     * @returns {Promise<{step: RoadmapStep, index: number}|null>}
     */
    async getNextStep(conversationId) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap || roadmap.state === 'completed') return null;

        // Find the next pending step whose dependencies are all done
        for (let i = 0; i < roadmap.steps.length; i++) {
            const step = roadmap.steps[i];
            if (step.status !== 'pending') continue;

            // Check dependencies
            const depsResolved = step.dependsOn.every(depIdx => {
                const depStep = roadmap.steps[depIdx];
                return depStep && depStep.status === 'done';
            });

            if (depsResolved) {
                return { step, index: i };
            }
        }

        return null; // No step ready
    }

    // ─── MARK STEP RUNNING ────────────────────────────────────

    /**
     * Transition a step to 'running' state.
     *
     * @param {string} conversationId
     * @param {number} stepIndex
     */
    async markStepRunning(conversationId, stepIndex) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap) return;

        roadmap.steps[stepIndex].status = 'running';
        roadmap.currentIndex = stepIndex;
        roadmap.state = 'running';
        roadmap.updatedAt = Date.now();

        await this._saveRoadmap(conversationId, roadmap);
        emitRoadmapUpdate(roadmap);
    }

    // ─── MARK STEP DONE (→ CHECKPOINT) ───────────────────────

    /**
     * Mark a step as done and transition roadmap to 'pending_approval'.
     * This is the CHECKPOINT — the orchestrator pauses here until the user
     * sends CONTINUE, RETRY, or EDIT_ROADMAP.
     *
     * @param {string} conversationId
     * @param {number} stepIndex
     * @param {string} result - The agent's final report for this step
     */
    async markStepDone(conversationId, stepIndex, result) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap) return;

        roadmap.steps[stepIndex].status = 'done';
        roadmap.steps[stepIndex].result = result;
        roadmap.updatedAt = Date.now();

        // Check if all steps are done
        const allDone = roadmap.steps.every(s => s.status === 'done' || s.status === 'skipped');

        if (allDone) {
            roadmap.state = 'completed';
            broadcast(Events.ROADMAP_COMPLETED, { roadmap });
        } else {
            // CHECKPOINT: pause and wait for user approval
            roadmap.state = 'pending_approval';
            emitRoadmapCheckpoint(stepIndex, roadmap.steps[stepIndex]);
        }

        await this._saveRoadmap(conversationId, roadmap);
        emitRoadmapUpdate(roadmap);

        console.log(`[Roadmap] Step ${stepIndex} completed. State: ${roadmap.state}`);
    }

    // ─── MARK STEP ERROR ─────────────────────────────────────

    /**
     * Mark a step as errored.
     *
     * @param {string} conversationId
     * @param {number} stepIndex
     * @param {string} errorMsg
     */
    async markStepError(conversationId, stepIndex, errorMsg) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap) return;

        roadmap.steps[stepIndex].status = 'error';
        roadmap.steps[stepIndex].result = `❌ Error: ${errorMsg}`;
        roadmap.state = 'pending_approval'; // Pause on error too
        roadmap.updatedAt = Date.now();

        await this._saveRoadmap(conversationId, roadmap);
        emitRoadmapUpdate(roadmap);
        emitRoadmapCheckpoint(stepIndex, roadmap.steps[stepIndex]);
    }

    // ─── DASHBOARD COMMANDS ──────────────────────────────────

    /**
     * CONTINUE: Approve the last checkpoint and proceed to the next step.
     *
     * @param {string} conversationId
     * @returns {Promise<{step: RoadmapStep, index: number}|null>} The next step to execute, or null if completed
     */
    async continueRoadmap(conversationId) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap || roadmap.state === 'completed') return null;

        // Resume from pending_approval
        roadmap.state = 'running';
        roadmap.updatedAt = Date.now();
        await this._saveRoadmap(conversationId, roadmap);

        // Find and return the next step
        return this.getNextStep(conversationId);
    }

    /**
     * RETRY: Reset the current step and re-execute it.
     * Optionally update the step description with new instructions.
     *
     * @param {string} conversationId
     * @param {string} [updatedInstructions] - Optional new instructions for the step
     * @returns {Promise<{step: RoadmapStep, index: number}|null>}
     */
    async retryStep(conversationId, updatedInstructions = null) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap) return null;

        // Find the last non-pending step (the one to retry)
        let retryIndex = -1;
        for (let i = roadmap.steps.length - 1; i >= 0; i--) {
            if (roadmap.steps[i].status === 'done' || roadmap.steps[i].status === 'error') {
                retryIndex = i;
                break;
            }
        }

        if (retryIndex === -1) return null;

        // Reset the step
        roadmap.steps[retryIndex].status = 'pending';
        roadmap.steps[retryIndex].result = null;
        roadmap.steps[retryIndex].retryCount++;

        if (updatedInstructions) {
            roadmap.steps[retryIndex].description = updatedInstructions;
        }

        roadmap.state = 'running';
        roadmap.updatedAt = Date.now();
        await this._saveRoadmap(conversationId, roadmap);
        emitRoadmapUpdate(roadmap);

        return { step: roadmap.steps[retryIndex], index: retryIndex };
    }

    /**
     * EDIT_ROADMAP: Replace all remaining (pending) steps with a new array.
     * Completed steps are preserved.
     *
     * @param {string} conversationId
     * @param {Array<{description: string, skill: string, url: string}>} newSteps
     * @returns {Promise<RoadmapState>}
     */
    async editRoadmap(conversationId, newSteps) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap) throw new Error('No active roadmap for this conversation');

        // Keep completed steps, replace the rest
        const completedSteps = roadmap.steps.filter(s => s.status === 'done');
        const newStepObjects = newSteps.map((step, index) => ({
            id: `step_${completedSteps.length + index}_${Date.now()}`,
            description: step.description,
            skill: step.skill || 'researcher',
            url: step.url || '',
            status: 'pending',
            result: null,
            retryCount: 0,
            dependsOn: step.dependsOn || [],
        }));

        roadmap.steps = [...completedSteps, ...newStepObjects];
        roadmap.currentIndex = completedSteps.length;
        roadmap.state = 'pending_approval';
        roadmap.updatedAt = Date.now();

        await this._saveRoadmap(conversationId, roadmap);
        emitRoadmapUpdate(roadmap);

        console.log(`[Roadmap] Edited: ${completedSteps.length} kept, ${newStepObjects.length} new steps`);
        return roadmap;
    }

    // ─── DELETE ROADMAP ──────────────────────────────────────

    /**
     * Remove a roadmap from storage and cache.
     *
     * @param {string} conversationId
     */
    async deleteRoadmap(conversationId) {
        this._cache.delete(conversationId);

        await storageMutex.lock();
        try {
            const { activeRoadmaps = {} } = await chrome.storage.local.get(['activeRoadmaps']);
            delete activeRoadmaps[conversationId];
            await chrome.storage.local.set({ activeRoadmaps });
        } finally {
            storageMutex.unlock();
        }
    }

    // ─── COLLECT PREVIOUS RESULTS ─────────────────────────────

    /**
     * Collect all completed step results as context for the next step.
     * This data is injected into the agent's task description so it has
     * access to all previous research/work.
     *
     * @param {string} conversationId
     * @returns {Promise<string>} Formatted context string
     */
    async collectPreviousResults(conversationId) {
        const roadmap = await this.getRoadmap(conversationId);
        if (!roadmap) return '';

        const completedSteps = roadmap.steps.filter(s => s.status === 'done' && s.result);
        if (completedSteps.length === 0) return '';

        return completedSteps.map((step, i) =>
            `=== Step ${i + 1}: ${step.description} (${step.skill}) ===\n${step.result}`
        ).join('\n\n');
    }

    // ─── PRIVATE: PERSIST TO STORAGE ─────────────────────────

    /**
     * Save roadmap to chrome.storage.local under the `activeRoadmaps` key.
     * @private
     */
    async _saveRoadmap(conversationId, roadmap) {
        this._cache.set(conversationId, roadmap);

        await storageMutex.lock();
        try {
            const { activeRoadmaps = {} } = await chrome.storage.local.get(['activeRoadmaps']);
            activeRoadmaps[conversationId] = roadmap;
            await chrome.storage.local.set({ activeRoadmaps });
        } finally {
            storageMutex.unlock();
        }
    }
}
