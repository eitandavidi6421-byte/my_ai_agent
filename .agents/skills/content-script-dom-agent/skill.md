---
name: Content Script DOM Agent
description: >
  Load this skill when writing or modifying a Chrome Extension content script (content-agent.js)
  that performs automated DOM interactions on behalf of an AI agent. Essential for tasks
  involving: reading page content, clicking elements in React/Vue/Shadow DOM apps, typing
  into framework-managed inputs, dispatching synthetic keyboard/mouse events, detecting DOM
  quiet periods after dynamic rendering, and implementing element maps for reliable re-use
  across agent steps. Also load when the user reports that clicks or typing don't work on
  specific websites, or when content script actions fail silently.
---

# Content Script DOM Agent – Skill Guide

## Architecture Overview

A content script DOM agent exposes a **message-based API** to the background service worker.
Each `action` name maps to a DOM operation. The agent maintains a registry (`window.__agentElementsMap`)
that maps short numeric IDs → live DOM elements, built fresh during each `read_page` call.

```
Background ──sendMessage──▶ Content Script (action handler)
                                    │
                     ┌──────────────┼──────────────┐
                     ▼              ▼               ▼
               read_page    interact_element    click_css ...
                     │              │
               DOMUtils       agentElementsMap
```

---

## Core DOMUtils (copy-paste ready)

```js
const DOMUtils = {

  // 1. Deep Query — pierces Shadow DOM roots
  querySelectorAllDeep(selector, root = document) {
    const result = [];
    const traverse = (node) => {
      if (![Node.ELEMENT_NODE, Node.DOCUMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(node.nodeType)) return;
      if (node.matches?.(selector)) result.push(node);
      if (node.shadowRoot) traverse(node.shadowRoot);
      for (const child of node.children) traverse(child);
    };
    traverse(root);
    return result;
  },

  // 2. Visibility Check — skips invisible/ARIA-hidden elements
  isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  },

  // 3. React/Vue-safe Value Setter — bypasses framework's synthetic setter
  setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const proto = Object.getPrototypeOf(element);
    const protoSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (protoSetter && valueSetter !== protoSetter) {
      protoSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  },

  // 4. Human-like Click — dispatches full pointer+mouse event chain
  simulateClick(element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.focus?.();
    ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click']
      .forEach(type => element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: 1 })));
    try { element.click(); } catch (_) {}
  },

  // 5. Wait for DOM to stop mutating (React/Vue finish rendering)
  waitForDOMQuiet(timeoutMs = 3000, debounceMs = 400) {
    return new Promise(resolve => {
      let timer, maxTimer;
      const finish = () => { clearTimeout(timer); clearTimeout(maxTimer); observer.disconnect(); resolve(); };
      // NOTE: Do NOT observe 'attributes' — causes infinite loop with blinking cursors
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, debounceMs); });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      timer    = setTimeout(finish, debounceMs);
      maxTimer = setTimeout(finish, timeoutMs);
    });
  }
};
```

---

## Action: `read_page` — Build Element Map

```js
if (request.action === 'read_page') {
  DOMUtils.waitForDOMQuiet(3000, 400).then(() => {
    const INTERACTIVE_SELECTORS =
      'a[href], button, input, textarea, select, [role="button"], [role="link"],' +
      '[role="textbox"], [role="checkbox"], [role="switch"], [role="searchbox"], [role="option"]';

    const mainNode = document.querySelector('main, article, #content, .content, [role="main"]')
                     || document.body;

    let pageText = (mainNode?.innerText || '')
      .replace(/\s+/g, ' ').trim().substring(0, 2500);

    let idCounter = 1;
    window.__agentElementsMap = new Map();   // IMPORTANT: reset before rebuilding
    const domMap = [];

    for (const el of DOMUtils.querySelectorAllDeep(INTERACTIVE_SELECTORS)) {
      if (idCounter > 100) break;          // cap to prevent massive payloads
      if (!DOMUtils.isVisible(el)) continue;

      const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '')
        .replace(/\s+/g, ' ').trim();
      const typeStr = el.tagName.toLowerCase() + (el.type ? `:${el.type}` : '');

      if (!text && !['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue;

      domMap.push(`[ID:${idCounter}] [${typeStr}] ${text.substring(0, 50)}`);
      window.__agentElementsMap.set(idCounter, el);
      idCounter++;
    }

    sendResponse({
      success: true,
      text: pageText + (domMap.length
        ? '\n\n--- Interactive Elements ---\n' + domMap.join('\n')
        : '\n\n--- No interactive elements found ---')
    });
  });
  return true;   // CRITICAL: keeps the Chrome message port open for async sendResponse
}
```

---

## Action: `interact_element` — Multi-type Input Handler

```js
if (request.action === 'interact_element') {
  const el = window.__agentElementsMap?.get(request.id);
  if (!el) {
    sendResponse({ success: false, feedback: `❌ ID ${request.id} not found. Run read_page first.` });
    return true;
  }

  try {
    // SELECT dropdown
    if (el.tagName === 'SELECT' && request.typeText != null) {
      const match = Array.from(el.options).find(o =>
        o.text.toLowerCase().includes(request.typeText.toLowerCase()) ||
        o.value.toLowerCase() === request.typeText.toLowerCase()
      );
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        sendResponse({ success: true, feedback: `✅ Selected: "${match.text}"` });
      } else {
        sendResponse({ success: false, feedback: `❌ Value "${request.typeText}" not found in SELECT.` });
      }
      return true;
    }

    // CHECKBOX / RADIO
    if (['checkbox', 'radio'].includes(el.type) && request.typeText == null) {
      el.checked = !el.checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      sendResponse({ success: true, feedback: `✅ ${el.type} toggled (now: ${el.checked})` });
      return true;
    }

    // TEXT INPUT (React/Vue/contentEditable safe)
    const isTextInput = request.typeText != null &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
       el.isContentEditable || ['textbox', 'searchbox'].includes(el.getAttribute('role')));

    if (isTextInput) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      el.click?.();

      if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
        el.innerText = '';
        document.execCommand('insertText', false, request.typeText);
        if (!el.innerText.includes(request.typeText)) el.innerText = request.typeText;
      } else {
        DOMUtils.setNativeValue(el, request.typeText);
      }

      if (request.pressEnter) {
        ['keydown', 'keyup'].forEach(t =>
          el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
        );
      }
      sendResponse({ success: true, feedback: `✅ Typed "${request.typeText.substring(0, 40)}"${request.pressEnter ? ' + Enter' : ''}` });
      return true;
    }

    // DEFAULT: click
    DOMUtils.simulateClick(el);
    sendResponse({ success: true, feedback: `✅ Clicked [ID:${request.id}]` });

  } catch (e) {
    sendResponse({ success: false, feedback: `❌ Interaction error: ${e.message}` });
  }
  return true;
}
```

---

## Platform Detection (Editor Awareness)

```js
function detectEditorPlatform() {
  if (document.querySelector('.edit-post-layout, #wpadminbar'))
    return { platform: 'WordPress',         capabilities: ['toolbar-clicks', 'blocks'] };

  if (document.querySelector('.notion-app-inner, [data-block-id]'))
    return { platform: 'Notion',            capabilities: ['slash-commands', 'markdown'] };

  if (window.location.hostname.includes('docs.google.com/document'))
    return { platform: 'Google Docs',       capabilities: ['canvas-based', 'menus'] };

  if (document.querySelector('.tox-tinymce, .cke, .ql-editor, .fr-box'))
    return { platform: 'Rich Text Editor',  capabilities: ['toolbar-clicks', 'execCommand'] };

  if (document.querySelector('[contenteditable="true"]'))
    return { platform: 'ContentEditable',   capabilities: ['execCommand', 'formatting'] };

  return { platform: 'Generic Web', capabilities: ['click', 'type', 'read'] };
}
```

---

## Key Press Action

```js
if (request.action === 'key_press') {
  const el = (request.id && window.__agentElementsMap?.get(request.id)) || document.activeElement;
  const parts   = request.key.split('+');
  const keyName = parts.pop();
  const opts = {
    key: keyName, code: keyName,
    keyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 13,
    ctrlKey:  parts.includes('Ctrl') || parts.includes('Cmd'),
    shiftKey: parts.includes('Shift'),
    altKey:   parts.includes('Alt'),
    bubbles: true, cancelable: true
  };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  if (keyName.length === 1 && !opts.ctrlKey && !opts.altKey)
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  sendResponse({ success: true, feedback: `✅ Key [${request.key}] dispatched.` });
  return true;
}
```

---

## Best Practices

| Rule | Why |
|---|---|
| Always `return true` from async handlers | Keeps Chrome port open; without it, `sendResponse` silently fails |
| Reset `__agentElementsMap` on every `read_page` | Stale IDs cause "element not found" errors |
| Don't observe `attributes` in MutationObserver | Causes infinite loops with blinking cursors / injected trackers |
| Cap element map at 100 | Prevents >10KB payloads that can crash the message channel |
| Use `setNativeValue` for React inputs | `element.value = x` doesn't trigger React's synthetic events |
| Always `scrollIntoView` before interacting | Off-screen elements may be detached or invisible to `simulateClick` |
| Validate `sender.id` if handling sensitive data | Prevents spoofed messages from other extensions |

---

## Common Errors & Fixes

| Error | Cause | Fix |
|---|---|---|
| `sendResponse` called after port closed | Missing `return true` in async handler | Always `return true` immediately |
| Click succeeds but page doesn't react | React/Vue synthetic events not triggered | Use `simulateClick` + `dispatchEvent` chain |
| Typing shows in input but React ignores it | Direct `.value =` assignment | Use `setNativeValue` |
| Element found but click fails | Element is in Shadow DOM | Use `querySelectorAllDeep` |
| `read_page` returns stale data | React hasn't finished re-rendering | Wrap in `waitForDOMQuiet` |
