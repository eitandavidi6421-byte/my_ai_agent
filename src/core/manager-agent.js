/**
 * @fileoverview Manager Agent (CEO) — Hierarchical Multi-Agent Orchestration
 * @description Implements the CEO agent that receives high-level goals, decomposes them
 *   into sub-tasks, creates and assigns specialized sub-agents, monitors their progress,
 *   and aggregates results. Inspired by the Apex platform.
 */

import { callGeminiAPIJSON } from "./api.js";
import { storageMutex } from "./storage.js";
import { parseJSON } from "../utils/helpers.js";

// ═══════════════════════════════════════════════════════════
// MANAGER AGENT SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════

const MANAGER_AGENT_PROMPT = `## MANAGER AGENT (CEO) — HIERARCHICAL ORCHESTRATOR

You are the **CEO** of an autonomous AI workforce. Your role is to:
1. Receive high-level goals from the user
2. Decompose them into concrete sub-tasks
3. Assign specialized agents (researcher, writer, analyst, automation)
4. Monitor progress and handle failures
5. Aggregate results and report back

### Your Capabilities:
- Analyze complex requests and identify sub-tasks
- Assign appropriate agent types to each task
- Monitor agent progress via status updates
- Make decisions about retries and reassignments
- Synthesize final results from multiple agents

### Agent Types You Can Delegate To:
| Type | Specialization | Use When |
|------|-----------------|----------|
| researcher | Web research, data gathering | Need to find information |
| writer | Content creation, emails, documents | Need to write or edit content |
| analyst | Data analysis, comparisons, summaries | Need to process and analyze data |
| automation | Form filling, purchases, bookings | Need to automate transactions |

### Task Decomposition Strategy:
1. Break down the user's goal into independent sub-tasks
2. Identify dependencies (what must complete before what)
3. Assign each task to the most suitable agent type
4. Set clear success criteria for each task
5. Plan how to aggregate results

### Output Format: JSON only
{
  "thought": "Your reasoning",
  "action": "decompose_goal" | "delegate_task" | "monitor_progress" | "synthesize_results",
  "parameters": {
    // Varies by action
  }
}

### Available Actions:

**decompose_goal**: Analyze a high-level goal and break it into sub-tasks
{
  "action": "decompose_goal",
  "parameters": {
    "goal": "User's high-level request",
    "analysis": "Your breakdown of the goal"
  }
}

**delegate_task**: Assign a task to a sub-agent
{
  "action": "delegate_task",
  "parameters": {
    "taskId": "unique_task_id",
    "agentType": "researcher|writer|analyst|automation",
    "task": "Detailed task description",
    "context": "Relevant context from previous tasks",
    "successCriteria": "How to know this task succeeded"
  }
}

**monitor_progress**: Check status of delegated tasks
{
  "action": "monitor_progress",
  "parameters": {
    "taskIds": ["task_1", "task_2"]
  }
}

**synthesize_results**: Combine results from multiple agents into final output
{
  "action": "synthesize_results",
  "parameters": {
    "results": [{ "taskId": "...", "result": "..." }],
    "finalReport": "Comprehensive summary for user"
  }
}

### Critical Rules:
1. Always decompose before delegating — understand the full scope first
2. Delegate to the most appropriate agent type — don't overload one agent
3. Provide clear context to each agent — they need to understand their role in the bigger picture
4. Monitor progress — if an agent fails, reassign or try a different approach
5. Aggregate results carefully — combine findings into a coherent narrative
6. Report back to user with complete, well-organized results
`;

// ═══════════════════════════════════════════════════════════
// MANAGER AGENT CLASS
// ═══════════════════════════════════════════════════════════

export class ManagerAgent {
  constructor() {
    /**
     * Active goals being managed.
     * @type {Map<string, GoalState>}
     *
     * @typedef {Object} GoalState
     * @property {string} id - Goal ID
     * @property {string} userRequest - Original user request
     * @property {string} conversationId - Owning conversation
     * @property {Array} subTasks - Decomposed sub-tasks
     * @property {Map<string, TaskState>} delegatedTasks - Assigned tasks
     * @property {string} status - 'decomposing' | 'delegating' | 'monitoring' | 'synthesizing' | 'done'
     * @property {number} createdAt - Timestamp
     */
    this.activeGoals = new Map();

    /**
     * Task results cache.
     * @type {Map<string, TaskResult>}
     *
     * @typedef {Object} TaskResult
     * @property {string} taskId - Task ID
     * @property {string} agentType - Agent type that executed it
     * @property {string} result - Task result/report
     * @property {string} status - 'pending' | 'running' | 'done' | 'failed'
     * @property {number} completedAt - Timestamp
     */
    this.taskResults = new Map();

    console.log("[ManagerAgent] Initialized");
  }

  /**
   * Start a new goal — decompose and begin delegation.
   *
   * @param {string} userRequest - High-level goal from user
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<Object>} Goal state with decomposed tasks
   */
  async startGoal(userRequest, conversationId) {
    const goalId = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    console.log(`[ManagerAgent] Starting goal ${goalId}: ${userRequest.substring(0, 50)}...`);

    const goalState = {
      id: goalId,
      userRequest,
      conversationId,
      subTasks: [],
      delegatedTasks: new Map(),
      status: "decomposing",
      createdAt: Date.now(),
    };

    this.activeGoals.set(goalId, goalState);

    // Call Gemini to decompose the goal
    try {
      const decomposition = await this._decomposeGoal(userRequest);
      goalState.subTasks = decomposition.subTasks || [];
      goalState.status = "delegating";

      // Persist to storage
      await this._persistGoal(goalState);

      return {
        goalId,
        status: "decomposed",
        subTasks: goalState.subTasks,
      };
    } catch (error) {
      console.error(`[ManagerAgent] Failed to decompose goal: ${error.message}`);
      goalState.status = "failed";
      throw error;
    }
  }

  /**
   * Decompose a high-level goal using Gemini.
   *
   * @private
   * @param {string} userRequest
   * @returns {Promise<Object>} { subTasks: [...] }
   */
  async _decomposeGoal(userRequest) {
    const messages = [
      {
        role: "user",
        parts: [
          {
            text: `Analyze this goal and decompose it into concrete sub-tasks:\n\n"${userRequest}"\n\nReturn a JSON object with:\n{\n  "subTasks": [\n    {\n      "id": "task_1",\n      "agentType": "researcher|writer|analyst|automation",\n      "description": "What this task does",\n      "dependencies": ["task_0"] or [],\n      "successCriteria": "How to know it succeeded"\n    }\n  ],\n  "strategy": "Overall execution strategy"\n}`,
          },
        ],
      },
    ];

    const response = await callGeminiAPIJSON(MANAGER_AGENT_PROMPT, messages);
    return response;
  }

  /**
   * Delegate a task to a sub-agent (enqueue it in the orchestrator).
   *
   * @param {string} goalId - Goal this task belongs to
   * @param {Object} taskDef - Task definition
   * @param {string} taskDef.id - Task ID
   * @param {string} taskDef.agentType - Agent type
   * @param {string} taskDef.description - Task description
   * @returns {Promise<string>} Task ID
   */
  async delegateTask(goalId, taskDef, orchestrator) {
    const goalState = this.activeGoals.get(goalId);
    if (!goalState) {
      throw new Error(`Goal ${goalId} not found`);
    }

    console.log(
      `[ManagerAgent] Delegating task ${taskDef.id} (${taskDef.agentType}) for goal ${goalId}`,
    );

    // Enqueue task in the orchestrator
    const taskId = orchestrator.enqueueTask({
      skill: taskDef.agentType,
      url: taskDef.url || "about:blank",
      task: taskDef.description,
      conversationId: goalState.conversationId,
    });

    // Track in goal state
    goalState.delegatedTasks.set(taskDef.id, {
      taskId,
      agentType: taskDef.agentType,
      status: "running",
      createdAt: Date.now(),
    });

    // Track in results cache
    this.taskResults.set(taskId, {
      taskId,
      agentType: taskDef.agentType,
      result: null,
      status: "pending",
      completedAt: null,
    });

    return taskId;
  }

  /**
   * Record task completion.
   *
   * @param {string} goalId - Goal ID
   * @param {string} taskId - Task ID (from orchestrator)
   * @param {string} result - Task result/report
   */
  async recordTaskCompletion(goalId, taskId, result) {
    const goalState = this.activeGoals.get(goalId);
    if (!goalState) return;

    // Find the delegated task
    let delegatedTaskId = null;
    for (const [dtId, dt] of goalState.delegatedTasks) {
      if (dt.taskId === taskId) {
        delegatedTaskId = dtId;
        dt.status = "done";
        dt.completedAt = Date.now();
        break;
      }
    }

    // Update results cache
    const taskResult = this.taskResults.get(taskId);
    if (taskResult) {
      taskResult.result = result;
      taskResult.status = "done";
      taskResult.completedAt = Date.now();
    }

    console.log(`[ManagerAgent] Task ${taskId} completed for goal ${goalId}`);

    // Check if all tasks are done
    const allDone = Array.from(goalState.delegatedTasks.values()).every(
      (t) => t.status === "done" || t.status === "failed",
    );

    if (allDone) {
      goalState.status = "synthesizing";
      await this._persistGoal(goalState);
    }
  }

  /**
   * Synthesize results from all completed tasks.
   *
   * @param {string} goalId - Goal ID
   * @returns {Promise<string>} Final synthesized report
   */
  async synthesizeResults(goalId) {
    const goalState = this.activeGoals.get(goalId);
    if (!goalState) {
      throw new Error(`Goal ${goalId} not found`);
    }

    console.log(`[ManagerAgent] Synthesizing results for goal ${goalId}`);

    // Collect all task results
    const results = [];
    for (const [delegatedId, delegated] of goalState.delegatedTasks) {
      const taskResult = this.taskResults.get(delegated.taskId);
      if (taskResult) {
        results.push({
          taskId: delegatedId,
          agentType: delegated.agentType,
          result: taskResult.result,
        });
      }
    }

    // Call Gemini to synthesize
    const messages = [
      {
        role: "user",
        parts: [
          {
            text: `Synthesize these task results into a comprehensive final report:\n\nOriginal Goal: "${goalState.userRequest}"\n\nTask Results:\n${JSON.stringify(results, null, 2)}\n\nProvide a well-organized, complete summary that directly addresses the original goal.`,
          },
        ],
      },
    ];

    const synthesis = await callGeminiAPIJSON(MANAGER_AGENT_PROMPT, messages);
    const finalReport = synthesis.finalReport || JSON.stringify(synthesis);

    goalState.status = "done";
    goalState.finalReport = finalReport;
    await this._persistGoal(goalState);

    return finalReport;
  }

  /**
   * Get goal status.
   *
   * @param {string} goalId
   * @returns {Object} Goal state
   */
  getGoalStatus(goalId) {
    const goalState = this.activeGoals.get(goalId);
    if (!goalState) return null;

    return {
      goalId,
      status: goalState.status,
      subTasks: goalState.subTasks,
      delegatedTasks: Array.from(goalState.delegatedTasks.entries()).map(
        ([id, dt]) => ({
          id,
          agentType: dt.agentType,
          status: dt.status,
        }),
      ),
      finalReport: goalState.finalReport || null,
    };
  }

  /**
   * Persist goal state to storage.
   *
   * @private
   * @param {GoalState} goalState
   */
  async _persistGoal(goalState) {
    await storageMutex.lock();
    try {
      const { managerGoals = {} } = await chrome.storage.local.get([
        "managerGoals",
      ]);

      managerGoals[goalState.id] = {
        id: goalState.id,
        userRequest: goalState.userRequest,
        conversationId: goalState.conversationId,
        subTasks: goalState.subTasks,
        status: goalState.status,
        finalReport: goalState.finalReport || null,
        createdAt: goalState.createdAt,
      };

      await chrome.storage.local.set({ managerGoals });
    } finally {
      storageMutex.unlock();
    }
  }

  /**
   * Load goal from storage.
   *
   * @param {string} goalId
   * @returns {Promise<Object|null>}
   */
  async loadGoal(goalId) {
    const { managerGoals = {} } = await chrome.storage.local.get([
      "managerGoals",
    ]);
    return managerGoals[goalId] || null;
  }
}
