/**
 * @fileoverview Self-Improving Feedback Loop Foundation
 * @description Stores success/failure patterns, agent performance scores,
 *   and user ratings to enable continuous improvement and learning.
 */

import { storageMutex } from "./storage.js";

// ═══════════════════════════════════════════════════════════
// FEEDBACK LOOP MANAGER
// ═══════════════════════════════════════════════════════════

export class FeedbackLoopManager {
  constructor() {
    /**
     * In-memory cache of performance metrics.
     * @type {Map<string, AgentPerformance>}
     *
     * @typedef {Object} AgentPerformance
     * @property {string} agentType - 'researcher' | 'writer' | 'analyst' | 'automation'
     * @property {number} tasksCompleted - Total completed tasks
     * @property {number} tasksFailed - Total failed tasks
     * @property {number} averageRating - Average user rating (1-5)
     * @property {Array} recentFeedback - Last 10 feedback entries
     * @property {number} lastUpdated - Timestamp
     */
    this.performanceMetrics = new Map();

    /**
     * Learned preferences from user feedback.
     * @type {Map<string, UserPreference>}
     *
     * @typedef {Object} UserPreference
     * @property {string} key - Preference key (e.g., "researcher_search_depth")
     * @property {string} value - Preference value
     * @property {number} strength - How strongly this preference is held (0-1)
     * @property {number} lastUpdated - Timestamp
     */
    this.learnedPreferences = new Map();

    console.log("[FeedbackLoopManager] Initialized");
  }

  /**
   * Record task completion with success/failure status.
   *
   * @param {string} agentType - Agent type
   * @param {string} taskId - Task ID
   * @param {boolean} success - Whether task succeeded
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<void>}
   */
  async recordTaskCompletion(agentType, taskId, success, metadata = {}) {
    await storageMutex.lock();
    try {
      const { agentPerformance = {} } = await chrome.storage.local.get([
        "agentPerformance",
      ]);

      if (!agentPerformance[agentType]) {
        agentPerformance[agentType] = {
          agentType,
          tasksCompleted: 0,
          tasksFailed: 0,
          averageRating: 3.0,
          recentFeedback: [],
          lastUpdated: Date.now(),
        };
      }

      const perf = agentPerformance[agentType];
      if (success) {
        perf.tasksCompleted++;
      } else {
        perf.tasksFailed++;
      }

      // Add to recent feedback
      perf.recentFeedback.push({
        taskId,
        success,
        timestamp: Date.now(),
        metadata,
      });

      // Keep only last 10 feedback entries
      if (perf.recentFeedback.length > 10) {
        perf.recentFeedback = perf.recentFeedback.slice(-10);
      }

      perf.lastUpdated = Date.now();

      await chrome.storage.local.set({ agentPerformance });
      console.log(
        `[FeedbackLoopManager] Recorded ${success ? "success" : "failure"} for ${agentType}/${taskId}`,
      );
    } finally {
      storageMutex.unlock();
    }
  }

  /**
   * Record user rating for an agent's output.
   *
   * @param {string} agentType - Agent type
   * @param {string} taskId - Task ID
   * @param {number} rating - User rating (1-5 stars)
   * @param {string} feedback - Optional text feedback
   * @returns {Promise<void>}
   */
  async recordUserRating(agentType, taskId, rating, feedback = "") {
    if (rating < 1 || rating > 5) {
      throw new Error("Rating must be between 1 and 5");
    }

    await storageMutex.lock();
    try {
      const { agentPerformance = {} } = await chrome.storage.local.get([
        "agentPerformance",
      ]);

      if (!agentPerformance[agentType]) {
        agentPerformance[agentType] = {
          agentType,
          tasksCompleted: 0,
          tasksFailed: 0,
          averageRating: 3.0,
          recentFeedback: [],
          lastUpdated: Date.now(),
        };
      }

      const perf = agentPerformance[agentType];

      // Update average rating (exponential moving average)
      const totalRatings = perf.recentFeedback.filter((f) => f.rating).length;
      const alpha = 0.3; // Weight for new rating
      perf.averageRating =
        alpha * rating + (1 - alpha) * perf.averageRating;

      // Add to recent feedback
      perf.recentFeedback.push({
        taskId,
        rating,
        feedback,
        timestamp: Date.now(),
      });

      if (perf.recentFeedback.length > 10) {
        perf.recentFeedback = perf.recentFeedback.slice(-10);
      }

      perf.lastUpdated = Date.now();

      await chrome.storage.local.set({ agentPerformance });
      console.log(
        `[FeedbackLoopManager] Recorded ${rating}★ rating for ${agentType}/${taskId}`,
      );
    } finally {
      storageMutex.unlock();
    }
  }

  /**
   * Store a learned user preference.
   *
   * @param {string} key - Preference key
   * @param {string} value - Preference value
   * @param {number} strength - Strength of preference (0-1)
   * @returns {Promise<void>}
   */
  async storePreference(key, value, strength = 0.8) {
    await storageMutex.lock();
    try {
      const { userPreferences = {} } = await chrome.storage.local.get([
        "userPreferences",
      ]);

      userPreferences[key] = {
        key,
        value,
        strength: Math.min(1, Math.max(0, strength)),
        lastUpdated: Date.now(),
      };

      await chrome.storage.local.set({ userPreferences });
      console.log(
        `[FeedbackLoopManager] Stored preference: ${key} = ${value}`,
      );
    } finally {
      storageMutex.unlock();
    }
  }

  /**
   * Get a learned user preference.
   *
   * @param {string} key - Preference key
   * @returns {Promise<string|null>} Preference value or null
   */
  async getPreference(key) {
    const { userPreferences = {} } = await chrome.storage.local.get([
      "userPreferences",
    ]);
    const pref = userPreferences[key];
    return pref ? pref.value : null;
  }

  /**
   * Get all learned preferences.
   *
   * @returns {Promise<Object>} All preferences
   */
  async getAllPreferences() {
    const { userPreferences = {} } = await chrome.storage.local.get([
      "userPreferences",
    ]);
    return userPreferences;
  }

  /**
   * Get performance metrics for an agent type.
   *
   * @param {string} agentType - Agent type
   * @returns {Promise<Object|null>} Performance metrics or null
   */
  async getPerformanceMetrics(agentType) {
    const { agentPerformance = {} } = await chrome.storage.local.get([
      "agentPerformance",
    ]);
    return agentPerformance[agentType] || null;
  }

  /**
   * Get performance metrics for all agent types.
   *
   * @returns {Promise<Object>} All performance metrics
   */
  async getAllPerformanceMetrics() {
    const { agentPerformance = {} } = await chrome.storage.local.get([
      "agentPerformance",
    ]);
    return agentPerformance;
  }

  /**
   * Get success rate for an agent type.
   *
   * @param {string} agentType - Agent type
   * @returns {Promise<number>} Success rate (0-1)
   */
  async getSuccessRate(agentType) {
    const metrics = await this.getPerformanceMetrics(agentType);
    if (!metrics) return 0.5; // Default neutral

    const total = metrics.tasksCompleted + metrics.tasksFailed;
    if (total === 0) return 0.5;

    return metrics.tasksCompleted / total;
  }

  /**
   * Generate a performance report for the dashboard.
   *
   * @returns {Promise<Object>} Performance report
   */
  async generatePerformanceReport() {
    const allMetrics = await this.getAllPerformanceMetrics();
    const allPreferences = await this.getAllPreferences();

    const report = {
      timestamp: Date.now(),
      agentMetrics: {},
      topPerformers: [],
      needsImprovement: [],
      learnedPreferences: allPreferences,
    };

    // Analyze each agent type
    for (const [agentType, metrics] of Object.entries(allMetrics)) {
      const total = metrics.tasksCompleted + metrics.tasksFailed;
      const successRate = total > 0 ? metrics.tasksCompleted / total : 0.5;

      report.agentMetrics[agentType] = {
        type: agentType,
        tasksCompleted: metrics.tasksCompleted,
        tasksFailed: metrics.tasksFailed,
        successRate: (successRate * 100).toFixed(1) + "%",
        averageRating: metrics.averageRating.toFixed(1),
        recentFeedback: metrics.recentFeedback.slice(-3),
      };

      // Categorize performance
      if (metrics.averageRating >= 4.0 && successRate >= 0.8) {
        report.topPerformers.push(agentType);
      } else if (metrics.averageRating < 3.0 || successRate < 0.5) {
        report.needsImprovement.push(agentType);
      }
    }

    return report;
  }

  /**
   * Clear all feedback data (for testing or reset).
   *
   * @returns {Promise<void>}
   */
  async clearAllFeedback() {
    await storageMutex.lock();
    try {
      await chrome.storage.local.set({
        agentPerformance: {},
        userPreferences: {},
      });
      console.log("[FeedbackLoopManager] Cleared all feedback data");
    } finally {
      storageMutex.unlock();
    }
  }
}
