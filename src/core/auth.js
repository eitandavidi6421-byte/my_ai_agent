/**
 * @fileoverview Authentication management for Google OAuth
 * @description Handles Google OAuth token management and user authentication
 */

import { setLoggedInEmail } from "./storage.js";

// In-memory token cache
let userToken = null;

/**
 * Get valid OAuth token, refreshing if necessary
 * @returns {Promise<string>} Valid OAuth token
 * @throws {Error} If authentication fails
 */
export async function getValidToken() {
  if (!userToken) {
    let result = await chrome.identity.getAuthToken({ interactive: false });
    let token = typeof result === "string" ? result : result && result.token;

    if (!token) {
      throw new Error("לא מחובר - נדרש אימות");
    }
    userToken = token;
  }
  return userToken;
}

/**
 * Handle user login with Google OAuth
 * @param {boolean} interactive - Whether to show interactive login UI
 * @param {Function} sendResponse - Callback to send response
 * @param {string} expectedEmail - Expected email for validation (optional)
 */
export async function handleLogin(interactive, sendResponse, expectedEmail) {
  try {
    let result = await chrome.identity.getAuthToken({ interactive });
    let token = typeof result === "string" ? result : result && result.token;

    if (!token) {
      sendResponse({ success: false, error: "לא התקבל טוקן" });
      return;
    }

    userToken = token;

    // Fetch user info from Google
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "Failed to fetch user info. Status:",
        response.status,
        "Error:",
        errorText,
      );
      // If token is invalid (401), clear it so next attempt gets a fresh one
      if (response.status === 401) {
        await chrome.identity.removeCachedAuthToken({ token });
        userToken = null;
      }
      throw new Error(
        `Failed to fetch user info: ${response.status} ${response.statusText}`,
      );
    }

    const userInfo = await response.json();
    const email = userInfo.email;

    // Validate email if expected email is provided
    if (expectedEmail && email !== expectedEmail) {
      // Wrong account - clear token and show error
      await chrome.identity.clearAllCachedAuthTokens();
      userToken = null;
      sendResponse({
        success: false,
        error: `חשבון שגוי. נדרש: ${expectedEmail}`,
        wrongAccount: true,
      });
      return;
    }

    // Save logged in email
    await setLoggedInEmail(email);

    sendResponse({
      success: true,
      token: token,
      user: {
        email: email,
        name: userInfo.name,
        picture: userInfo.picture,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    sendResponse({
      success: false,
      error: error.message || "שגיאה באימות",
    });
  }
}

/**
 * Logout user and clear all cached tokens
 */
export async function logout() {
  await chrome.identity.clearAllCachedAuthTokens();
  userToken = null;
  await setLoggedInEmail(null);
}

/**
 * Check if user is currently logged in
 * @returns {Promise<boolean>} True if logged in
 */
export async function isLoggedIn() {
  try {
    let result = await chrome.identity.getAuthToken({ interactive: false });
    let token = typeof result === "string" ? result : result && result.token;
    return !!token;
  } catch {
    return false;
  }
}

/**
 * Get current user token (cached)
 * @returns {string|null} Current token or null
 */
export function getCurrentToken() {
  return userToken;
}

/**
 * Clear cached token (force refresh on next request)
 */
export function clearTokenCache() {
  userToken = null;
}
