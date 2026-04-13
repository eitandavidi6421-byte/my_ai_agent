---
name: Swarm Dashboard UI Patterns
description: >
  Load this skill when writing or modifying the Swarm Dashboard frontend (dashboard.js/html). 
  Essential for: Chat UI message rendering (Gemini-style), dynamic agent pills/chips, 
  expandable thinking-log panels, Canvas/Project-Plan sidebars, glassmorphic styling conventions, 
  and syncing UI state with chrome.storage.local/activeWorkers.
---

# Swarm Dashboard UI – Skill Guide

## UI Philosophy

The dashboard follows a "Gemini-inspired" aesthetic:

- **Clean Layout**: Large whitespace, centered chat, collapsable sidebars.
- **Glassmorphism**: Subtle blurs, semi-transparent surfaces, thin borders.
- **Micro-animations**: Smooth transitions for opening panels, fading in messages.
- **Real-time Sync**: UI components are reactive to `chrome.storage.onChanged`.

---

## Chat Message Pattern

Messages are differentiated by roles: `user`, `ai`, and `progress` (loading state).

```javascript
function addMessageUI(
  text,
  isUser = false,
  isProgress = false,
  spawnedWorkers = null,
) {
  const msg = document.createElement("div");
  msg.className = `message ${isUser ? "user" : isProgress ? "progress" : "ai"}`;

  if (isProgress) {
    msg.id = "temp-loader";
    msg.innerHTML = `<div class="msg-bubble-progress">
        <div class="pill-spinner"></div>
        <span id="progress-text">${text}</span>
    </div>`;
  } else if (isUser) {
    msg.innerHTML = `<div class="msg-bubble-user">${escapeHtml(text)}</div>`;
  } else {
    // AI Message with potential Agent Pills
    const wrap = document.createElement("div");
    wrap.className = "msg-ai-wrap";

    if (spawnedWorkers?.length > 0) {
      const pillGroup = document.createElement("div");
      pillGroup.className = "agent-pills-group";
      spawnedWorkers.forEach((wid) =>
        pillGroup.appendChild(buildAgentPill(wid)),
      );
      wrap.appendChild(pillGroup);
    }

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble-ai";
    bubble.innerHTML = marked.parse(text); // Uses marked.js for Markdown
    wrap.appendChild(bubble);
    msg.appendChild(wrap);
  }

  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msg;
}
```

---

## Agent Pill & Thinking Panel

This is the primary way to show agent activity without cluttering the chat.

```javascript
function buildAgentPill(workerId) {
  const wrapper = document.createElement("div");
  wrapper.className = "agent-pill-wrapper";

  // The Chip
  const pill = document.createElement("div");
  pill.className = "agent-pill";
  pill.dataset.workerId = workerId;
  pill.innerHTML = `
    <div class="pill-spinner" id="pill-spin-${workerId}"></div>
    <span class="pill-status-prefix">Working on:</span>
    <span class="pill-label">${workerId}</span>
    <svg class="pill-chevron" ...></svg>
  `;

  // The Collapsible Panel
  const panel = document.createElement("div");
  panel.className = "agent-thinking";
  panel.id = `thinking-${workerId}`;
  panel.innerHTML = `
    <div class="thinking-header">
       <span class="thinking-step-count" id="pill-count-${workerId}">0 actions</span>
    </div>
    <div class="thinking-steps-list" id="pill-steps-${workerId}"></div>
  `;

  pill.addEventListener("click", () => {
    panel.classList.toggle("open");
    pill.classList.toggle("expanded");
    // Refresh logs on open...
  });

  wrapper.appendChild(pill);
  wrapper.appendChild(panel);
  return wrapper;
}
```

---

## Reactive UI Syncing

The UI must listen for storage changes to update worker statuses in real-time.

```javascript
chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns === "local" && changes.activeWorkers) {
    const workers = changes.activeWorkers.newValue || {};

    // Update existing pills in the chat window
    document.querySelectorAll(".agent-pill[data-worker-id]").forEach((pill) => {
      const wid = pill.dataset.workerId;
      const data = workers[wid];
      if (!data) return;

      // Update status icon, step count, and logs panel
      updatePillUI(pill, data);
    });
  }
});
```

---

## Canvas & Sidebars

The dashboard uses a grid/flex layout that shifts when a sidebar (Canvas or Project Plan) is opened.

```javascript
// Toggle CSS class on the main wrapper
function openCanvas(content) {
  document.getElementById("main-layout").classList.add("canvas-open");
  document.getElementById("canvas-content").innerHTML = marked.parse(content);
}

function closeCanvas() {
  document.getElementById("main-layout").classList.remove("canvas-open");
}
```

---

## CSS Variables (Design System)

Always use the predefined CSS variables in `style.css` to maintain visual consistency.

```css
:root {
  --bg: #f8faff;
  --surface: #ffffff;
  --accent: #1a73e8;
  --text: #1f1f1f;
  --text-muted: #5f6368;
  --border: #e0e4e8;
  --glass: rgba(255, 255, 255, 0.7);
  --blur: 12px;
}
```

---

## Best Practices

1. **Auto-Scroll**: Always scroll the chat window to the bottom after adding a message or expanding a pill.
2. **Sanitize Output**: Use `escapeHtml` for user input, but `marked` for AI output.
3. **Lazy Rendering**: Don't rebuild the entire workers grid on every heartbeat; use `updateExistingCard` logic to only touch changed elements.
4. **Accessibility**: Ensure all buttons have `title` attributes for tooltips and standard icons.
5. **Debouncing**: Batch UI updates if multiple workers are firing messages simultaneously to avoid DOM thrashing.
