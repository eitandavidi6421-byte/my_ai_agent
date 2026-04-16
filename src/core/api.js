/**
 * @fileoverview Gemini API integration
 * @description Handles all API calls to Google's Gemini AI service
 */

import { getValidToken } from "./auth.js";
import { parseJSON } from "../utils/helpers.js";

/**
 * Default AI model to use
 */
import { CONFIG } from "./config.js";
const DEFAULT_MODEL = CONFIG.DEFAULT_MODEL;

/**
 * Safety settings for Gemini API (permissive for agent operations)
 */
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

/**
 * Call Gemini API with retry logic
 * @param {string} systemPrompt - System instruction for the AI
 * @param {Array} messages - Conversation messages
 * @param {number} retries - Number of retries on failure
 * @param {number} delay - Initial delay between retries (ms)
 * @returns {Promise<string>} AI response text
 * @throws {Error} If API call fails after all retries
 */
export async function callGeminiAPI(
  systemPrompt,
  messages,
  options = {},
  retries = 3,
  delay = 2000,
) {
  const token = await getValidToken();
  if (!token) {
    throw new Error("חסר טוקן אימות");
  }

  // Get AI Model configuration from storage
  const { aiModel } = await chrome.storage.local.get(["aiModel"]);
  const modelToUse = aiModel || DEFAULT_MODEL;

  try {
    const reqBody = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: messages,
      generationConfig: {
        temperature: options.temperature || 0.7,
      },
      safetySettings: SAFETY_SETTINGS,
    };

    // Add responseMimeType only if useSearch is NOT enabled (tools clash with JSON schema often in some models)
    if (!options.useSearch) {
      reqBody.generationConfig.responseMimeType = "application/json";
    } else {
      reqBody.tools = [{ googleSearch: {} }];
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(reqBody),
      },
    );

    // Handle rate limiting and server errors with retry
    if (!response.ok) {
      if ([429, 500, 503].includes(response.status) && retries > 0) {
        console.warn(
          `Gemini API ${response.status}. Retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callGeminiAPI(
          systemPrompt,
          messages,
          options,
          retries - 1,
          delay * 2,
        );
      }

      const body = await response.text().catch(() => "");
      throw new Error(`Gemini ${response.status}: ${body.substring(0, 200)}`);
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    let text = candidate?.content?.parts?.[0]?.text;

    if (!text) {
      // Check for finish reason to give a better error message
      const finishReason = candidate?.finishReason;
      if (finishReason === "SAFETY") {
        throw new Error('תגובה נחסמה ע"י מסנני הבטיחות של Gemini');
      }
      if (finishReason === "RECITATION") {
        throw new Error("תגובה נחסמה בגלל ציטוט (RECITATION)");
      }
      // If empty with JSON mime type, retry without forcing JSON mime type
      if (retries > 0 && !options.useSearch) {
        console.warn(
          "Empty Gemini response, retrying without responseMimeType...",
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callGeminiAPI(
          systemPrompt,
          messages,
          { ...options, useSearch: true },
          retries - 1,
          delay * 2,
        );
      }
      throw new Error(
        "תגובה ריקה מ-Gemini (finishReason: " +
          (finishReason || "unknown") +
          ")",
      );
    }

    // --- NEW: Add Bibliography if grounding metadata exists ---
    if (options.useSearch && candidate?.groundingMetadata?.groundingChunks) {
      const chunks = candidate.groundingMetadata.groundingChunks;
      const sources = chunks
        .map((chunk) => chunk.web)
        .filter((web) => web && web.uri)
        .map((web) => `- [${web.title || web.uri}](${web.uri})`);

      // Deduplicate sources
      const uniqueSources = [...new Set(sources)];

      if (uniqueSources.length > 0) {
        text +=
          "\n\n---\n**📚 ביבליוגרפיה ומקורות מחקר:**\n" +
          uniqueSources.join("\n");
      }
    }

    return text;
  } catch (error) {
    // Retry on network failures
    if (error.message.includes("Failed to fetch") && retries > 0) {
      console.warn(`Network error. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callGeminiAPI(
        systemPrompt,
        messages,
        options,
        retries - 1,
        delay * 2,
      );
    }
    throw error;
  }
}

/**
 * Call Gemini API and parse JSON response
 * @param {string} systemPrompt - System instruction
 * @param {Array} messages - Conversation messages
 * @returns {Promise<Object>} Parsed JSON response
 * @throws {Error} If parsing fails or API call fails
 */
export async function callGeminiAPIJSON(systemPrompt, messages) {
  const rawResponse = await callGeminiAPI(systemPrompt, messages);
  const parsed = parseJSON(rawResponse);

  if (!parsed) {
    throw new Error("Failed to parse JSON response from Gemini");
  }

  return parsed;
}

/**
 * Get available AI models
 * @returns {Promise<Array>} List of available models
 */
export async function getAvailableModels() {
  const token = await getValidToken();

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error("Error fetching models:", error);
    return [{ name: DEFAULT_MODEL }];
  }
}

/**
 * Set the AI model to use
 * @param {string} modelName - Model name to use
 */
export async function setAIModel(modelName) {
  await chrome.storage.local.set({ aiModel: modelName });
}

/**
 * Get current AI model
 * @returns {Promise<string>} Current model name
 */
export async function getCurrentModel() {
  const { aiModel } = await chrome.storage.local.get(["aiModel"]);
  return aiModel || DEFAULT_MODEL;
}
