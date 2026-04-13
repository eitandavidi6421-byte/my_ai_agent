// dashboard.js — Swarm Dashboard v4.0 (Gemini-style)

// ══════════════ DOM REFS ══════════════
const chatWindow = document.getElementById("chat-window");
const inputField = document.getElementById("dash-input");
const sendBtn = document.getElementById("dash-send");
const agentsGrid = document.getElementById("agents-grid");
const emptyState = document.getElementById("empty-state");
const activeCountEl = document.getElementById("active-count");
const modelSelect = document.getElementById("model-select");
const themeToggle = document.getElementById("theme-toggle");
const convList = document.getElementById("conversations-list");
const newChatBtn = document.getElementById("new-chat-btn");
const convTitle = document.getElementById("current-conv-title");

// ══════════════ STATE ══════════════
let activeConvId = null; // currently selected conversation ID
let localMessages = []; // UI messages for the current conversation
let pendingUpdate = null; // requestAnimationFrame handle for batched worker updates

// ══════════════ SETTINGS & THEME ══════════════

function applyTheme(theme) {
  if (theme === "dark") {
    document.body.setAttribute("data-theme", "dark");
    themeToggle.textContent = "☀️";
  } else {
    document.body.removeAttribute("data-theme");
    themeToggle.textContent = "🌙";
  }
}

chrome.storage.local.get(["theme", "aiModel"], (data) => {
  applyTheme(data.theme || "light");
  // Migrate old/invalid model names to valid API names
  const VALID_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ];
  const storedModel = data.aiModel;
  if (storedModel && VALID_MODELS.includes(storedModel)) {
    modelSelect.value = storedModel;
  } else {
    // Reset to default if model is invalid/old
    const defaultModel = "gemini-2.0-flash";
    modelSelect.value = defaultModel;
    chrome.storage.local.set({ aiModel: defaultModel });
  }
});

themeToggle.addEventListener("click", () => {
  const isDark = document.body.getAttribute("data-theme") === "dark";
  const next = isDark ? "light" : "dark";
  applyTheme(next);
  chrome.storage.local.set({ theme: next });
});

// UI Logic for Research Mode Segmented Controls
document.querySelectorAll(".res-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    document
      .querySelectorAll(".res-btn")
      .forEach((b) => b.classList.remove("active"));
    // If they click on the icon/text inside, we want the button
    const targetBtn = e.target.closest(".res-btn");
    if (targetBtn) targetBtn.classList.add("active");
  });
});

modelSelect.addEventListener("change", (e) => {
  chrome.storage.local.set({ aiModel: e.target.value });
});

// Auto-resize textarea
inputField.addEventListener("input", () => {
  inputField.style.height = "auto";
  inputField.style.height = Math.min(inputField.scrollHeight, 120) + "px";
});

// ══════════════ CONVERSATIONS SIDEBAR ══════════════

function formatTimeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "עכשיו";
  if (m < 60) return `לפני ${m} דק'`;
  if (h < 24) return `לפני ${h} שע'`;
  if (d < 7) return `לפני ${d} ימים`;
  return new Date(ts).toLocaleDateString("he-IL");
}

function renderSidebar(conversations) {
  convList.innerHTML = "";

  if (!conversations || conversations.length === 0) {
    convList.innerHTML =
      '<div class="conv-empty">עדיין אין שיחות.<br>התחל שיחה חדשה 👆</div>';
    return;
  }

  conversations.forEach((conv) => {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === activeConvId ? " active" : "");
    item.dataset.id = conv.id;

    item.innerHTML = `
            <span class="conv-icon">💬</span>
            <span class="conv-title" title="${conv.title}">${conv.title}</span>
            <button class="conv-delete" data-id="${conv.id}" title="מחק שיחה">✕</button>
        `;

    item.addEventListener("click", (e) => {
      if (e.target.closest(".conv-delete")) return;
      selectConversation(conv.id, conv.title);
    });

    const delBtn = item.querySelector(".conv-delete");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });

    convList.appendChild(item);
  });
}

function loadSidebar() {
  chrome.runtime.sendMessage({ action: "list_conversations" }, (resp) => {
    if (chrome.runtime.lastError) return;
    renderSidebar(resp?.conversations || []);
  });
}

function selectConversation(id, title) {
  activeConvId = id;
  convTitle.textContent = title || "שיחה";
  convList.querySelectorAll(".conv-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });

  closeCanvas(); // Automatically close Canvas when switching chats
  closeProjectPlan(); // Also close Project Plan when switching chats
  syncProjectPlanToggle(); // Show/hide toggle button based on whether this conv has a plan

  // Load chat history for this conversation
  chrome.runtime.sendMessage(
    { action: "load_conversation_history", id },
    (resp) => {
      if (chrome.runtime.lastError) return;
      const messages = resp?.messages || [];
      rebuildChatFromHistory(messages);
    },
  );

  // Immediately reload workers for the newly selected conversation
  chrome.storage.local.get(["activeWorkers"], (data) =>
    renderWorkers(data.activeWorkers || {}),
  );
}

function rebuildChatFromHistory(messages) {
  chatWindow.innerHTML = "";
  localMessages = [];

  // Show up to last 20 messages (each turn = 2 entries: user + model)
  const pairs = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const rawText = m.parts?.[0]?.text || "";

    if (m.role === "user") {
      const trimmed = rawText.trim();
      // Skip internal feedback messages (prefixed with ✅ ⏳ etc.)
      if (
        !trimmed.startsWith("✅") &&
        !trimmed.startsWith("⏳") &&
        !trimmed.startsWith("🚨") &&
        !trimmed.startsWith("שגיאת") &&
        !trimmed.startsWith("⚠️")
      ) {
        pairs.push({ role: "user", text: rawText });
      }
    } else if (m.role === "model") {
      try {
        const cleanText = rawText
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .trim();
        const obj = JSON.parse(cleanText);
        if (obj.action === "done" && obj.parameters?.text) {
          pairs.push({ role: "model", text: obj.parameters.text });
        } else if (obj.text) {
          pairs.push({ role: "model", text: obj.text });
        } else if (obj.parameters && obj.parameters.text) {
          pairs.push({ role: "model", text: obj.parameters.text });
        }
      } catch {
        // Not JSON, raw text
        if (rawText.trim().length > 0)
          pairs.push({ role: "model", text: rawText });
      }
    }
  }

  if (pairs.length === 0) {
    addMessageUI("שלום! שגר סוכנים לחפש, לכתוב, לבדוק... 🚀", false);
    return;
  }

  pairs.forEach((p) => {
    if (p.role === "user") addMessageUI(p.text, true);
    else addMessageUI(p.text, false, false, null, true); // skipAnimation
  });
}

function createConversation(callback) {
  chrome.runtime.sendMessage({ action: "new_conversation" }, (resp) => {
    if (chrome.runtime.lastError || !resp?.id) return;
    callback(resp.id);
    loadSidebar();
  });
}

function deleteConversation(id) {
  if (!confirm("למחוק שיחה זו?")) return;
  chrome.runtime.sendMessage({ action: "delete_conversation", id }, () => {
    if (activeConvId === id) {
      activeConvId = null;
      convTitle.textContent = "בחר שיחה או התחל חדשה";
      chatWindow.innerHTML = "";
      addMessageUI("שלום! בחר שיחה קיימת או התחל שיחה חדשה. 🚀", false);
    }
    loadSidebar();
    // Immediately unmount agents that were deleted to avoid UI lag
    chrome.storage.local.get(["activeWorkers"], (data) =>
      renderWorkers(data.activeWorkers || {}),
    );
  });
}

newChatBtn.addEventListener("click", () => {
  createConversation((id) => {
    // selectConversation כבר טוען את הצ'אט ומציגה את הודעת הפתיחה דרך rebuildChatFromHistory
    // אסור להוסיף אותה שוב כאן כדי למנוע הכפלה
    selectConversation(id, "שיחה חדשה");
  });
});

// Listen for storage updates (sidebar rename after first message)
chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns === "local" && changes.conversations) {
    loadSidebar();
    // Update the active conv title if it was auto-renamed
    if (activeConvId) {
      const convs = changes.conversations.newValue || [];
      const c = convs.find((x) => x.id === activeConvId);
      if (c && convTitle.textContent !== c.title) {
        convTitle.textContent = c.title;
      }
    }
  }
  if (ns === "local" && changes.activeWorkers) {
    const newData = changes.activeWorkers.newValue || {};
    if (pendingUpdate) cancelAnimationFrame(pendingUpdate);
    pendingUpdate = requestAnimationFrame(() => {
      renderWorkers(newData); // updates hidden grid (for JS compat)
      liveUpdatePills(newData); // updates chips + open panels in chat
      pendingUpdate = null;
    });
  }
});

// ── Live-update every pill chip + open log panel from storage ──
function liveUpdatePills(workersMap) {
  // 1. Find or create a live-pills container inside the progress loader
  const loader = document.getElementById("temp-loader");
  if (loader) {
    let livePillsGroup = loader.querySelector(".live-pills-group");
    if (!livePillsGroup) {
      livePillsGroup = document.createElement("div");
      livePillsGroup.className = "agent-pills-group live-pills-group";
      livePillsGroup.style.marginTop = "10px";
      loader.appendChild(livePillsGroup);
    }

    // Add pill for any new worker that doesn't have one yet
    Object.keys(workersMap).forEach((wid) => {
      const w = workersMap[wid];
      if (w.conversationId && w.conversationId !== activeConvId) return;

      if (!loader.querySelector(`.agent-pill[data-worker-id="${wid}"]`)) {
        const pillWrapper = buildAgentPill(wid);
        livePillsGroup.appendChild(pillWrapper);
      }
    });
  }

  // 2. Update all pill chips already in the chat (including those in the loader)
  chatWindow.querySelectorAll(".agent-pill[data-worker-id]").forEach((pill) => {
    const wid = pill.dataset.workerId;
    const w = workersMap[wid];

    // Remove pill if it doesn't belong to the active conversation
    if (w && w.conversationId && w.conversationId !== activeConvId) {
      pill.remove();
      return;
    }

    if (!w) {
      pill.remove();
      return;
    }

    // Update status prefix
    const prefix = pill.querySelector(".pill-status-prefix");
    if (prefix) {
      if (w.status === "done") prefix.textContent = "סיים:";
      else if (w.status === "error" || w.status === "cancelled")
        prefix.textContent = "שגיאה ב:";
      else if (w.status === "paused") prefix.textContent = "ממתין לאדם:";
      else prefix.textContent = "עובד על:";
    }

    // Swap spinner → status icon when finished
    const spinner = pill.querySelector(".pill-spinner");
    if (
      spinner &&
      (w.status === "done" || w.status === "error" || w.status === "cancelled")
    ) {
      spinner.remove();
      if (!pill.querySelector(".pill-done-icon, .pill-err-icon")) {
        const icon = document.createElement("span");
        icon.className =
          w.status === "done" ? "pill-done-icon" : "pill-err-icon";
        icon.textContent = w.status === "done" ? "✓" : "✗";
        pill.insertBefore(
          icon,
          pill.querySelector(".pill-status-prefix") || pill.firstChild,
        );
      }
    }

    // Update step count badge
    const countEl = document.getElementById(`pill-count-${wid}`);
    if (countEl && w.logs) countEl.textContent = `${w.logs.length} פעולות`;

    // Add visual alert and show resume box if paused
    const panelEl = pill.nextElementSibling;
    const resumeContainer = panelEl
      ? panelEl.querySelector(".pill-resume-container")
      : null;

    if (w.status === "paused") {
      pill.classList.add("needs-help");
      // Change the prefix text for paused state
      const prefix = pill.querySelector(".pill-status-prefix");
      if (prefix) prefix.textContent = "ממתין לאדם:";

      if (resumeContainer) {
        resumeContainer.style.display = "block";
        const msgEl = resumeContainer.querySelector(".pill-resume-msg");
        if (msgEl)
          msgEl.textContent =
            w.errorMsg || 'סיים את הפעולה הדרושה בטאב הפתוח ולחץ "סיימתי".';
      }
      // Auto open the panel so the user sees the button
      if (panelEl && !panelEl.classList.contains("open")) {
        pill.classList.add("expanded");
        panelEl.classList.add("open");
        if (w.logs) updatePillThinking(wid, w.logs, w.status);
      }
    } else {
      pill.classList.remove("needs-help");
      if (resumeContainer) resumeContainer.style.display = "none";
    }

    // If panel is open — refresh logs immediately
    if (panelEl && panelEl.classList.contains("open") && w.logs) {
      updatePillThinking(wid, w.logs, w.status);
    }
  });
}

// ══════════════ CHAT UI ══════════════

function addMessageUI(
  text,
  isUser = false,
  isProgress = false,
  spawnedWorkers = null,
  instant = false,
) {
  const msg = document.createElement("div");
  msg.className = `message ${isUser ? "user" : isProgress ? "progress" : "ai"}`;
  if (instant) msg.style.animation = "none";

  if (isProgress) {
    msg.id = "temp-loader";
    msg.innerHTML = `<div class="msg-bubble-progress">
            <div class="pill-spinner"></div>
            <span id="progress-text">מנהל הפרויקטים מתכנן שיגור סוכנים...</span>
        </div>`;
  } else if (isUser) {
    msg.innerHTML = `<div class="msg-bubble-user">${escapeHtml(text)}</div>`;
  } else {
    // AI message — possibly with agent pills
    const wrap = document.createElement("div");
    wrap.className = "msg-ai-wrap";

    // Agent pills (before final answer)
    if (spawnedWorkers && spawnedWorkers.length > 0) {
      const pillGroup = document.createElement("div");
      pillGroup.className = "agent-pills-group";

      spawnedWorkers.forEach((wid) => {
        const pill = buildAgentPill(wid);
        pillGroup.appendChild(pill);
      });

      wrap.appendChild(pillGroup);
    }

    // Final answer bubble
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble-ai";

    function simpleMarkdownParser(md) {
      let html = md.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      html = html
        .replace(/^### (.*$)/gim, "<h3>$1</h3>")
        .replace(/^## (.*$)/gim, "<h2>$1</h2>")
        .replace(/^# (.*$)/gim, "<h1>$1</h1>")
        .replace(/\*\*(.*?)\*\*/gim, "<b>$1</b>")
        .replace(/\*(.*?)\*/gim, "<i>$1</i>")
        .replace(/---/gim, "<hr>")
        .replace(/\`\`\`([^`]+)\`\`\`/gim, "<pre><code>$1</code></pre>")
        .replace(/\`([^`]+)\`/gim, "<code>$1</code>");
      html = html
        .split("\n")
        .map((line) => {
          if (line.match(/^[-*] /)) return "<li>" + line.substring(2) + "</li>";
          if (line.match(/^\d+\. /))
            return "<li>" + line.replace(/^\d+\. /, "") + "</li>";
          if (line.trim() === "") return "<br>";
          return line;
        })
        .join("<br>")
        .replace(/(<br>\s*){2,}/g, "<br><br>");
      return html;
    }

    if (typeof marked !== "undefined") {
      bubble.innerHTML = marked.parse(text);
    } else {
      bubble.innerHTML = simpleMarkdownParser(text);
    }
    bubble.querySelectorAll("a").forEach((a) => (a.target = "_blank"));
    wrap.appendChild(bubble);

    // Add Canvas trigger if content is substantial (has headings or is long)
    const hasHeadings = text.includes("#");
    const isLong = text.length > 300;

    if (hasHeadings || isLong) {
      const trigger = document.createElement("button");
      trigger.className = "canvas-trigger";
      trigger.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="9" y1="21" x2="9" y2="9"/>
                </svg>
                צפייה ב-Canvas
            `;
      trigger.addEventListener("click", () => openCanvas(text));
      wrap.appendChild(trigger);
    }

    msg.appendChild(wrap);
  }

  requestAnimationFrame(() => {
    chatWindow.appendChild(msg);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  });

  return msg;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildAgentPill(workerId) {
  // Outer wrapper
  const wrapper = document.createElement("div");
  wrapper.className = "agent-pill-wrapper";

  // The chip
  const pill = document.createElement("div");
  pill.className = "agent-pill";
  pill.dataset.workerId = workerId;
  pill.innerHTML = `
        <div class="pill-spinner" id="pill-spin-${workerId}"></div>
        <span class="pill-status-prefix">ממתין ל:</span>
        <span class="pill-label">${workerId}</span>
        <svg class="pill-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
        </svg>
    `;

  // Expandable log panel
  const panel = document.createElement("div");
  panel.className = "agent-thinking";
  panel.id = `thinking-${workerId}`;
  panel.innerHTML = `
        <div class="thinking-header">
            <span class="thinking-header-title">🤖 ${workerId}</span>
            <span class="thinking-step-count" id="pill-count-${workerId}">0 פעולות</span>
        </div>
        <div class="thinking-steps-list" id="pill-steps-${workerId}">
            <div style="padding:8px 0;color:var(--text-dim);font-size:0.82rem;">ממתין לפעולות...</div>
        </div>
        <div class="pill-resume-container" style="display:none; padding:10px; background:var(--surface); border-top:1px solid var(--border);">
            <div style="color:var(--red); font-weight:700; margin-bottom:6px;">🚨 נדרשת עזרתך!</div>
            <div class="pill-resume-msg" style="font-size:0.82rem; margin-bottom:8px; color:var(--text-muted);"></div>
            <div style="display:flex; gap:6px;">
                <input type="text" class="pill-resume-input" placeholder="הערות להמשך..." style="flex:1; border:1px solid var(--border); border-radius:4px; padding:6px; background:var(--bg2); color:var(--text); font-size:0.8rem; outline:none;">
                <button class="pill-resume-btn" style="background:var(--red); color:white; border:none; border-radius:4px; padding:6px 12px; font-weight:600; cursor:pointer;">סיימתי!</button>
            </div>
        </div>
    `;

  const resumeBtn = panel.querySelector(".pill-resume-btn");
  const resumeInput = panel.querySelector(".pill-resume-input");
  resumeBtn.addEventListener("click", () => {
    resumeBtn.disabled = true;
    resumeBtn.textContent = "ממשיך...";
    chrome.runtime.sendMessage({
      action: "resume_worker",
      workerId: workerId,
      input: resumeInput.value,
    });
  });

  pill.addEventListener("click", () => {
    const isOpen = panel.classList.contains("open");
    pill.classList.toggle("expanded", !isOpen);
    panel.classList.toggle("open", !isOpen);

    if (!isOpen) {
      // Load latest logs when opening
      chrome.storage.local.get(["activeWorkers"], (data) => {
        const w = (data.activeWorkers || {})[workerId];
        if (w) updatePillThinking(workerId, w.logs || [], w.status);
      });
    }
  });

  wrapper.appendChild(pill);
  wrapper.appendChild(panel);
  return wrapper;
}

function updatePillThinking(workerId, logs, status) {
  const stepsEl = document.getElementById(`pill-steps-${workerId}`);
  const countEl = document.getElementById(`pill-count-${workerId}`);
  if (!stepsEl) return;

  if (!logs || logs.length === 0) {
    stepsEl.innerHTML =
      '<div style="padding:8px 0;color:var(--text-dim);font-size:0.82rem;">אין פעולות עדיין...</div>';
    if (countEl) countEl.textContent = "0 פעולות";
    return;
  }

  if (countEl) countEl.textContent = `${logs.length} פעולות`;

  const actionIcons = {
    open_url: "🌐",
    read_page: "📄",
    click_element: "🖱️",
    type_in_editor: "✏️",
    search: "🔍",
    scroll: "↕️",
    done: "✅",
    wait: "⏳",
    key_press: "⌨️",
    editor_format: "🎨",
    analyze_editor: "🔬",
  };

  stepsEl.innerHTML = logs
    .map((log, i) => {
      const isFail =
        String(log.message || "").includes("❌") ||
        String(log.message || "")
          .toLowerCase()
          .includes("error");
      const isLast = i === logs.length - 1;
      const dotClass = isFail
        ? "fail"
        : isLast && status === "running"
          ? "running"
          : "done";
      const icon = actionIcons[log.action] || "⚡";
      const title = toTitleCase(log.action || "פעולה");
      const body = log.thought
        ? log.thought.substring(0, 120) +
          (log.thought.length > 120 ? "..." : "")
        : "";
      const msgSnippet = log.message
        ? String(log.message).substring(0, 60)
        : "";
      const tagClass = isFail ? "t-tag fail" : "t-tag";

      return `<div class="t-step">
            <div class="t-dot ${dotClass}">${icon}</div>
            <div class="t-content">
                <div class="t-title${isFail ? " fail" : ""}">${title}</div>
                ${body ? `<div class="t-body">${body}</div>` : ""}
                ${msgSnippet ? `<span class="${tagClass}">${log.action}${msgSnippet ? " — " + msgSnippet : ""}</span>` : ""}
            </div>
        </div>`;
    })
    .join("");

  // Auto scroll to bottom
  stepsEl.scrollTop = stepsEl.scrollHeight;
}

function toTitleCase(action) {
  const map = {
    open_url: "פתיחת כתובת",
    read_page: "קריאת עמוד",
    click_element: "לחיצה על אלמנט",
    type_in_editor: "כתיבה בעורך",
    search: "חיפוש",
    scroll: "גלילה",
    done: "סיום",
    wait: "המתנה",
    analyze_editor: "ניתוח עורך",
    key_press: "קיצור מקלדת",
    editor_format: "עיצוב טקסט",
  };
  return (
    map[action] ||
    action.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
  );
}

function updateProgressText(text) {
  const el = document.getElementById("progress-text");
  if (el) el.textContent = text;
}

function removeLoader() {
  const l = document.getElementById("temp-loader");
  if (l) l.remove();
}

// ══════════════ SEND LOGIC ══════════════

function handleSend() {
  const text = inputField.value.trim();
  if (!text) return;
  inputField.value = "";
  inputField.style.height = "auto";
  sendBtn.disabled = true;

  // If no active conversation, create one first
  if (!activeConvId) {
    createConversation((id) => {
      activeConvId = id;
      convTitle.textContent = "שיחה חדשה";
      doSend(text);
    });
  } else {
    doSend(text);
  }
}

function doSend(text) {
  const originalConvId = activeConvId;
  addMessageUI(text, true);
  addMessageUI("", false, true); // progress loader

  const activeResBtn = document.querySelector(".res-btn.active");
  const researchMode = activeResBtn
    ? activeResBtn.getAttribute("data-mode")
    : "none";

  const options = {
    action: "manager_prompt",
    text,
    conversationId: activeConvId,
    researchMode,
  };
  chrome.runtime.sendMessage(options, (response) => {
    if (activeConvId === originalConvId) {
      removeLoader();
    }
    sendBtn.disabled = false;

    if (activeConvId !== originalConvId) return;

    if (chrome.runtime.lastError || !response) {
      addMessageUI(
        "❌ שגיאת תקשורת: " + (chrome.runtime.lastError?.message || "Unknown"),
        false,
      );
      return;
    }
    if (response.error) {
      addMessageUI("❌ שגיאה: " + response.error, false);
      return;
    }

    const finalText = response.text || "המשימה הושלמה.";
    const spawnedIds = response.spawnedIds || [];
    addMessageUI(
      finalText,
      false,
      false,
      spawnedIds.length ? spawnedIds : null,
    );

    // Update pill statuses after a short delay to ensure workers are loaded
    if (spawnedIds.length) {
      setTimeout(() => finalizePills(spawnedIds), 500);
    }
  });
}

function finalizePills(spawnedIds) {
  chrome.storage.local.get(["activeWorkers"], (data) => {
    const aw = data.activeWorkers || {};
    spawnedIds.forEach((wid) => {
      const w = aw[wid];
      const pill = chatWindow.querySelector(
        `.agent-pill[data-worker-id="${wid}"]`,
      );
      if (!pill) return;

      // Remove spinner
      const spin = pill.querySelector(`#pill-spin-${wid}`);
      if (spin) spin.remove();

      // Update prefix text
      const prefix = pill.querySelector(".pill-status-prefix");
      const status = w?.status || "done";
      if (prefix)
        prefix.textContent =
          status === "done"
            ? "סיים:"
            : status === "error"
              ? "שגיאה ב:"
              : "ממתין ל:";

      // Add status icon
      const icon = document.createElement("span");
      icon.className = status === "done" ? "pill-done-icon" : "pill-err-icon";
      icon.textContent = status === "done" ? "✓" : "✗";
      pill.insertBefore(icon, pill.querySelector(".pill-status-prefix"));

      // Update thinking panel if open
      if (w?.logs) updatePillThinking(wid, w.logs, w.status);
    });
  });
}

sendBtn.addEventListener("click", handleSend);
inputField.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "manager_progress") updateProgressText(request.text);
  if (request.action === "render_project_plan") openProjectPlan(request.tasks);
});

// ══════════════ AGENTS GRID ══════════════

function getStatusLabel(status) {
  const map = {
    running: "פעיל",
    done: "סיים ✓",
    paused: "ממתין לאדם",
    error: "שגיאה",
    cancelled: "בוטל",
  };
  return map[status] || status;
}

function getBadgeClass(status) {
  const map = {
    running: "badge-running",
    done: "badge-done",
    paused: "badge-paused",
    error: "badge-error",
    cancelled: "badge-cancelled",
  };
  return map[status] || "badge-running";
}

function generateThinkingHTML(logsArray) {
  if (!logsArray || logsArray.length === 0) {
    return `<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;">מאתחל את הסוכן...</div>`;
  }
  return logsArray
    .map((log) => {
      const isFail = String(log.message || "").includes("❌");
      const title = toTitleCase(log.action || "פעולה");
      const body = log.thought
        ? log.thought.substring(0, 180) +
          (log.thought.length > 180 ? "..." : "")
        : "";
      const actionLine = log.message
        ? `<div class="log-step-action${isFail ? " fail" : ""}">⚡ ${log.action}${log.message ? " — " + String(log.message).substring(0, 60) : ""}</div>`
        : "";
      return `<div class="log-step">
            <div class="log-step-title">${title}</div>
            ${body ? `<div class="log-step-body">${body}</div>` : ""}
            ${actionLine}
        </div>`;
    })
    .join("");
}

function buildAgentCard(id, worker) {
  const card = document.createElement("div");
  card.className = `agent-card status-${worker.status}`;
  card.id = `agent-card-${id}`;

  const isRunning = worker.status === "running";

  const header = document.createElement("div");
  header.className = "card-header";
  header.innerHTML = `
        <div class="card-title-group">
            <div class="card-icon">🤖</div>
            <span class="card-name" title="${id}">${id.replace(/_/g, " ")}</span>
        </div>
        <div class="card-header-right">
            <span class="status-badge ${getBadgeClass(worker.status)}">${getStatusLabel(worker.status)}</span>
            ${
              isRunning
                ? `<button class="stop-btn" data-worker-id="${id}" title="עצור סוכן">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </button>`
                : ""
            }
        </div>
    `;
  card.appendChild(header);

  // Progress bar
  const pbWrap = document.createElement("div");
  pbWrap.className = "progress-bar-wrap";
  const pbFill = document.createElement("div");
  pbFill.className = "progress-bar-fill";
  pbWrap.appendChild(pbFill);
  card.appendChild(pbWrap);

  if (worker.task) {
    const taskEl = document.createElement("div");
    taskEl.className = "card-task";
    taskEl.textContent = worker.task;
    card.appendChild(taskEl);
  }

  const urlEl = document.createElement("div");
  urlEl.className = "card-url";
  urlEl.title = worker.url || "";
  urlEl.textContent = worker.url || "ממתין לקישור...";
  card.appendChild(urlEl);

  // Thinking accordion
  const accordBtn = document.createElement("button");
  accordBtn.className = "logs-accordion-toggle" + (isRunning ? " open" : "");
  accordBtn.innerHTML = `<span>▲ הצגת תהליך החשיבה</span><span class="toggle-arrow">▾</span>`;

  const logsContainer = document.createElement("div");
  logsContainer.className = "card-logs-container" + (isRunning ? " open" : "");

  accordBtn.addEventListener("click", () => {
    const isOpen = logsContainer.classList.contains("open");
    logsContainer.classList.toggle("open", !isOpen);
    accordBtn.classList.toggle("open", !isOpen);
  });

  const logsEl = document.createElement("div");
  logsEl.className = "card-logs";
  const logs = worker.logs || [];
  logsEl.dataset.logsHash = JSON.stringify(logs);
  logsEl.innerHTML = generateThinkingHTML(logs);

  logsContainer.appendChild(logsEl);
  card.appendChild(accordBtn);
  card.appendChild(logsContainer);

  // Final report
  if (worker.status === "done" && worker.finalReport) {
    const report = document.createElement("div");
    report.className = "card-report";
    const rtitle = document.createElement("div");
    rtitle.className = "card-report-title";
    rtitle.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> התשובה הסופית`;
    report.appendChild(rtitle);
    const rcontent = document.createElement("div");
    rcontent.textContent = worker.finalReport;
    report.appendChild(rcontent);
    card.appendChild(report);
  }

  // Resume box
  if (worker.status === "paused") {
    card.appendChild(buildResumeBox(id, worker.errorMsg));
  }

  // Error
  if (
    (worker.status === "error" || worker.status === "cancelled") &&
    worker.errorMsg
  ) {
    const err = document.createElement("div");
    err.className = "card-error-msg";
    err.innerText = worker.errorMsg;
    card.appendChild(err);
  }

  return card;
}

function buildResumeBox(id, errorMsg) {
  const box = document.createElement("div");
  box.className = "card-resume-box";
  box.innerHTML = `
        <div class="resume-msg">🚨 נדרשת עזרתך — הסוכן נתקע!</div>
        ${errorMsg ? `<div class="resume-agent-msg">● ${errorMsg}</div>` : ""}
        <div class="resume-hint">סיים את הפעולה הנדרשת בטאב הפתוח, ולחץ "סיימתי" להמשיך.</div>
        <div class="resume-input-row">
            <input type="text" class="resume-input" data-worker-id="${id}" placeholder="פרטים נוספים (אופציונלי)...">
            <button class="resume-btn resume-btn-done" data-worker-id="${id}">✅ סיימתי! המשך</button>
        </div>
    `;
  return box;
}

function updateExistingCard(id, worker) {
  const card = document.getElementById(`agent-card-${id}`);
  if (!card) return false;

  card.className = `agent-card status-${worker.status}`;

  const badge = card.querySelector(".status-badge");
  if (badge) {
    badge.className = `status-badge ${getBadgeClass(worker.status)}`;
    badge.textContent = getStatusLabel(worker.status);
  }

  if (worker.status !== "running") {
    const stopBtn = card.querySelector(".stop-btn");
    if (stopBtn) stopBtn.remove();

    // Auto-close accordion when done
    if (worker.status === "done") {
      card.querySelector(".card-logs-container")?.classList.remove("open");
      card.querySelector(".logs-accordion-toggle")?.classList.remove("open");
    }
  }

  const urlEl = card.querySelector(".card-url");
  if (urlEl && worker.url && urlEl.textContent !== worker.url) {
    urlEl.textContent = worker.url;
    urlEl.title = worker.url;
  }

  const logsEl = card.querySelector(".card-logs");
  if (logsEl) {
    const logs = worker.logs || [];
    const newHash = JSON.stringify(logs);
    if (logsEl.dataset.logsHash !== newHash) {
      logsEl.dataset.logsHash = newHash;
      logsEl.innerHTML = generateThinkingHTML(logs);
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  }

  let existingReport = card.querySelector(".card-report");
  if (worker.status === "done" && worker.finalReport) {
    if (!existingReport) {
      const report = document.createElement("div");
      report.className = "card-report";
      report.innerHTML = `<div class="card-report-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> התשובה הסופית</div>`;
      const content = document.createElement("div");
      content.textContent = worker.finalReport;
      report.appendChild(content);
      card.appendChild(report);
    } else {
      existingReport.lastElementChild.textContent = worker.finalReport;
    }
  }

  let existingResume = card.querySelector(".card-resume-box");
  if (worker.status === "paused" && !existingResume)
    card.appendChild(buildResumeBox(id, worker.errorMsg));
  else if (worker.status !== "paused" && existingResume)
    existingResume.remove();

  let existingErr = card.querySelector(".card-error-msg");
  if (
    (worker.status === "error" || worker.status === "cancelled") &&
    worker.errorMsg
  ) {
    if (!existingErr) {
      const e = document.createElement("div");
      e.className = "card-error-msg";
      e.innerText = worker.errorMsg;
      card.appendChild(e);
    } else if (existingErr.innerText !== worker.errorMsg)
      existingErr.innerText = worker.errorMsg;
  }

  return true;
}

function renderWorkers(workersMap) {
  const defaultIds = Object.keys(workersMap || {});
  // Only show workers related to the currently active conversation
  const ids = defaultIds.filter(
    (wid) =>
      !workersMap[wid].conversationId ||
      workersMap[wid].conversationId === activeConvId,
  );

  if (ids.length === 0) {
    Array.from(agentsGrid.querySelectorAll(".agent-card")).forEach((card) =>
      card.remove(),
    );
    emptyState.style.display = "flex";
    activeCountEl.textContent = "0 סוכנים פעילים";
    // Ensure to remove cards that were detached but might be in memory
    return;
  }
  emptyState.style.display = "none";
  const runningCount = ids.filter(
    (id) => workersMap[id].status === "running",
  ).length;
  const totalCount = ids.length;
  activeCountEl.textContent =
    runningCount > 0
      ? `${runningCount} פעילים / ${totalCount} סה"כ`
      : `${totalCount} סוכנים`;

  Array.from(agentsGrid.querySelectorAll(".agent-card")).forEach((card) => {
    const cardId = card.id.replace("agent-card-", "");
    if (!ids.includes(cardId)) card.remove();
  });
  ids.forEach((id) => {
    if (!updateExistingCard(id, workersMap[id]))
      agentsGrid.appendChild(buildAgentCard(id, workersMap[id]));
  });
}

// Delegated events on grid
agentsGrid.addEventListener("click", (e) => {
  const btnResume = e.target.closest(".resume-btn");
  if (btnResume) {
    const workerId = btnResume.dataset.workerId;
    const input = btnResume
      .closest(".card-resume-box")
      .querySelector(".resume-input");
    const humanMessage = input ? input.value.trim() : "";
    btnResume.disabled = true;
    btnResume.textContent = "מתחיל...";
    chrome.runtime.sendMessage(
      { action: "resume_worker", workerId, humanMessage },
      () => {
        if (input) input.value = "";
      },
    );
    return;
  }
  const btnStop = e.target.closest(".stop-btn");
  if (btnStop) {
    const workerId = btnStop.dataset.workerId;
    if (!workerId) return;
    btnStop.disabled = true;
    btnStop.style.opacity = "0.5";
    chrome.runtime.sendMessage({ action: "stop_worker", workerId });
    return;
  }
});

// ══════════════ TOOLBAR BUTTONS ══════════════

document.getElementById("clear-agents-btn")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clear_workers" });
});

document.getElementById("hard-reset-btn").addEventListener("click", () => {
  if (
    confirm(
      "האם למחוק לחלוטין את כל הזיכרון? זה יאפס את כל השיחות, ההיסטוריה והסוכנים הפעילים.",
    )
  ) {
    chrome.runtime.sendMessage({ action: "clear_history" }, () => {
      activeConvId = null;
      convTitle.textContent = "בחר שיחה או התחל חדשה";
      chatWindow.innerHTML = "";
      addMessageUI("הזיכרון אופס בהצלחה. כעת אני נקי לחלוטין. 🗑️✨", false);
      loadSidebar();
    });
  }
});

document.getElementById("export-logs-btn").addEventListener("click", () => {
  chrome.storage.local.get(["activeWorkers"], (data) => {
    const workers = data.activeWorkers || {};
    const blob = new Blob(
      [
        JSON.stringify(
          { timestamp: new Date().toISOString(), workers },
          null,
          2,
        ),
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swarm_logs_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
});

// ══════════════ CANVAS LOGIC ══════════════

const canvasOverlay = document.getElementById("canvas-overlay");
const canvasContent = document.getElementById("canvas-content");
const canvasTitle = document.getElementById("canvas-title");
const closeCanvasBtn = document.getElementById("close-canvas");
const printCanvasBtn = document.getElementById("canvas-print-btn");

function openCanvas(text) {
  if (typeof closeProjectPlan === "function") closeProjectPlan();

  // 1. Extract Smart Title from content (First h1 or bold line)
  let title = "מחקר מקיף";
  const h1Match = text.match(/^#\s+(.+)$/m);
  if (h1Match) {
    title = h1Match[1];
  } else {
    const firstLine = text.trim().split("\n")[0].replace(/[#*]/g, "");
    if (firstLine.length > 5)
      title = firstLine.substring(0, 40) + (firstLine.length > 40 ? "..." : "");
  }
  canvasTitle.textContent = title;

  // 2. Render Markdown
  if (typeof marked !== "undefined") {
    canvasContent.innerHTML = marked.parse(text);
    canvasContent.querySelectorAll("a").forEach((a) => (a.target = "_blank"));
  } else {
    canvasContent.textContent = text;
  }

  // 3. Show & Focus
  document.getElementById("main-layout").classList.add("canvas-open");
  document.querySelector(".canvas-body").scrollTop = 0;
}

function closeCanvas() {
  document.getElementById("main-layout").classList.remove("canvas-open");
}

closeCanvasBtn.addEventListener("click", closeCanvas);
if (printCanvasBtn) {
  printCanvasBtn.addEventListener("click", () => {
    window.print();
  });
}

// Close on Escape
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && canvasOverlay?.style?.display !== "none") {
    closeCanvas();
    closeProjectPlan();
  }
});

// ══════════════ PROJECT PLAN LOGIC (Per-Conversation) ══════════════

const projectToggleBtn = document.getElementById("project-plan-toggle");

/**
 * Open the project plan panel for the active conversation.
 * If tasks are provided, saves them to storage. Otherwise loads from storage.
 *
 * @param {Array|null} tasks - Array of { text, status } or null to load from storage
 */
function openProjectPlan(tasks) {
  if (!activeConvId) return;

  // Close canvas if open
  document.getElementById("main-layout").classList.remove("canvas-open");
  document.getElementById("main-layout").classList.add("project-open");

  // Update toggle button state
  if (projectToggleBtn) projectToggleBtn.classList.add("active");

  const list = document.getElementById("project-tasks-list");
  if (!list) return;

  // If tasks provided, save to storage and render
  if (tasks && tasks.length) {
    _saveProjectPlan(activeConvId, tasks);
    _renderProjectTasks(list, tasks);
  } else {
    // Load from storage for the active conversation
    _loadAndRenderProjectPlan(activeConvId, list);
  }
}

/**
 * Close the project plan panel.
 */
function closeProjectPlan() {
  const layout = document.getElementById("main-layout");
  if (layout) layout.classList.remove("project-open");
  if (projectToggleBtn) projectToggleBtn.classList.remove("active");
}

/**
 * Toggle the project plan panel open/closed.
 */
function toggleProjectPlan() {
  const layout = document.getElementById("main-layout");
  if (!layout) return;

  if (layout.classList.contains("project-open")) {
    closeProjectPlan();
  } else {
    openProjectPlan(null); // Load from storage
  }
}

/**
 * Save project plan tasks for a specific conversation.
 * @private
 */
function _saveProjectPlan(convId, tasks) {
  chrome.storage.local.get(["projectPlans"], (data) => {
    const plans = data.projectPlans || {};
    plans[convId] = tasks.map((t) => ({
      text: t.text || t,
      status: t.status || "pending",
    }));
    chrome.storage.local.set({ projectPlans: plans }, () => {
      // Show toggle button immediately after saving
      if (projectToggleBtn) projectToggleBtn.style.display = "inline-flex";
    });
  });
}

/**
 * Load and render project plan for a conversation.
 * @private
 */
function _loadAndRenderProjectPlan(convId, listEl) {
  chrome.storage.local.get(["projectPlans"], (data) => {
    const plans = data.projectPlans || {};
    const tasks = plans[convId];

    if (!tasks || !tasks.length) {
      listEl.innerHTML = `
                <div style="padding:40px 24px;text-align:center;color:var(--text-dim);font-size:0.9rem;">
                    <div style="font-size:2rem;margin-bottom:12px;">📋</div>
                    אין תוכנית פרויקט לשיחה זו.<br>
                    <span style="font-size:0.82rem;">שלח בקשה מורכבת והמערכת תיצור תוכנית אוטומטית.</span>
                </div>`;
      return;
    }

    _renderProjectTasks(listEl, tasks);
  });
}

/**
 * Render project tasks into the list element.
 * @private
 */
function _renderProjectTasks(listEl, tasks) {
  listEl.innerHTML = "";

  tasks.forEach((task, index) => {
    const taskText = typeof task === "string" ? task : task.text || "";
    const taskStatus =
      typeof task === "object" ? task.status || "pending" : "pending";

    const item = document.createElement("div");
    item.className =
      "task-item" + (taskStatus === "done" ? " status-done" : "");

    const checkbox = document.createElement("div");
    checkbox.className = "task-checkbox";
    checkbox.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    const textEl = document.createElement("div");
    textEl.className = "task-text";
    textEl.contentEditable = true;
    textEl.textContent = taskText;

    checkbox.addEventListener("click", () => {
      const isDone = item.classList.toggle("status-done");

      // Update storage
      _updateTaskStatus(activeConvId, index, isDone ? "done" : "pending");

      // Send automatic message to AI to continue
      const actionText = isDone
        ? `✅ סיימתי את השלב "${textEl.innerText.trim()}". בוא נמשיך לשלב הבא.`
        : `❌ השלב "${textEl.innerText.trim()}" עדיין לא הושלם. עדכן סטטוס.`;
      inputField.value = actionText;
      handleSend();
    });

    // Save text edits on blur
    textEl.addEventListener("blur", () => {
      _updateTaskText(activeConvId, index, textEl.innerText.trim());
    });

    item.appendChild(checkbox);
    item.appendChild(textEl);
    listEl.appendChild(item);
  });
}

/**
 * Update a single task's status in storage.
 * @private
 */
function _updateTaskStatus(convId, taskIndex, newStatus) {
  chrome.storage.local.get(["projectPlans"], (data) => {
    const plans = data.projectPlans || {};
    if (plans[convId] && plans[convId][taskIndex]) {
      plans[convId][taskIndex].status = newStatus;
      chrome.storage.local.set({ projectPlans: plans });
    }
  });
}

/**
 * Update a single task's text in storage (after user edits it).
 * @private
 */
function _updateTaskText(convId, taskIndex, newText) {
  chrome.storage.local.get(["projectPlans"], (data) => {
    const plans = data.projectPlans || {};
    if (plans[convId] && plans[convId][taskIndex]) {
      plans[convId][taskIndex].text = newText;
      chrome.storage.local.set({ projectPlans: plans });
    }
  });
}

/**
 * Sync the project plan toggle button visibility when switching conversations.
 * Called whenever activeConvId changes.
 */
function syncProjectPlanToggle() {
  if (!projectToggleBtn) return;

  if (!activeConvId) {
    projectToggleBtn.style.display = "none";
    closeProjectPlan();
    return;
  }

  chrome.storage.local.get(["projectPlans"], (data) => {
    const plans = data.projectPlans || {};
    const hasPlan = plans[activeConvId] && plans[activeConvId].length > 0;
    projectToggleBtn.style.display = hasPlan ? "inline-flex" : "none";

    // If panel is open but this conv has no plan, close it
    if (!hasPlan) {
      closeProjectPlan();
    }
  });
}

// Toggle button click handler
if (projectToggleBtn) {
  projectToggleBtn.addEventListener("click", toggleProjectPlan);
}

// Close button in project panel
document
  .getElementById("close-project")
  ?.addEventListener("click", closeProjectPlan);

// ══════════════ INIT & STORAGE SYNC ══════════════

loadSidebar();

chrome.storage.local.get(["activeWorkers"], (data) =>
  renderWorkers(data.activeWorkers || {}),
);
