/**
 * @fileoverview System configuration and constants
 */

export const CONFIG = {
  DEFAULT_MODEL: "gemini-2.0-flash",
  STORAGE_MUTEX_WAIT: 100,
  BATCH_UPDATE_DELAY: 500,
  API_RETRIES: 3,
  API_DELAY: 2000,
  TAB_WAIT_TIMEOUT: 12000,
  KEEP_ALIVE_PERIOD: 0.4, // minutes
};

export const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];
