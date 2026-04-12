/**
 * @fileoverview DOM Engine for AI Agents
 * @description Injects and executes scripts in the target page
 */

export async function waitForTab(tabId, timeout = 12000) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeout;
        const poll = () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError) return resolve(false);
                if (tab.status === 'complete') return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(poll, 300); // Poll faster: 300ms instead of 400ms
            });
        };
        poll();
    });
}

// Assigns data-ai-id to all interactive elements and returns page text + map
// Smart mode: detects if we are inside a rich-text editor and exposes toolbar buttons.
const READ_PAGE_FUNC = () => {
    // ─── Error Page Detection (Intelligent Site Diagnostics) ───
    const checkError = () => {
        // 1. Browser Level Errors (Chrome DNS/Network errors)
        if (document.querySelector('.error-code') || document.getElementById('main-frame-error')) {
            return `\n[🚨 FATAL_BROWSER_ERROR: Network or DNS failure. The domain does not exist or is unreachable. DO NOT retry this domain. Switch to Google search immediately. 🚨]\n\n`;
        }

        // 2. HTTP Error Signatures (404, 403, 500)
        const title = (document.title || '').toLowerCase();
        const h1 = (document.querySelector('h1')?.innerText || '').toLowerCase();
        const bodyText = (document.body?.innerText || '').toLowerCase().substring(0, 1200);
        const url = location.href.toLowerCase();

        const is404 = title.includes('404') || h1.includes('404') ||
            title.includes('not found') || h1.includes('not found') ||
            title.includes('page not found') || bodyText.includes('page not found') ||
            title.includes('דף לא נמצא') || h1.includes('דף לא נמצא') ||
            bodyText.includes('out of nothing') || // Medium 404
            bodyText.includes("the page you're looking for") ||
            bodyText.includes('this page could not be found') ||
            bodyText.includes('no longer available') ||
            bodyText.includes('does not exist');

        const is403 = title.includes('403') || h1.includes('403') ||
            title.includes('access denied') || h1.includes('access denied') ||
            title.includes('forbidden') || bodyText.includes('access denied') ||
            bodyText.includes('permission denied');

        const is500 = title.includes('500') || title.includes('server error') ||
            bodyText.includes('internal server error') ||
            bodyText.includes('something went wrong') && bodyText.length < 500;

        // 3. Paywall / Login wall detection
        const isPaywall = (bodyText.includes('subscribe') || bodyText.includes('sign up') || bodyText.includes('create an account')) &&
            document.querySelectorAll('article p, .article-body p').length < 2;

        if (is404) return `\n[❌ 404_NOT_FOUND: This specific page does not exist. Do NOT interact with it. IMMEDIATELY search Google for the topic instead: open_url https://www.google.com/search?q=TOPIC]\n\n`;
        if (is403) return `\n[🚫 403_FORBIDDEN: Access denied. Try a different URL or search Google for the information instead.]\n\n`;
        if (is500) return `\n[⚠️ 500_SERVER_ERROR: The server is having issues. Try a different source or search Google.]\n\n`;
        if (isPaywall) return `\n[💰 PAYWALL_DETECTED: Content is behind a paywall/login wall. Search Google for the same information from a free source.]\n\n`;

        // 4. Information Absence / Empty Page heuristic
        const meaningfulElements = document.querySelectorAll('a, button, input, p, h1, h2, h3, li').length;
        if (meaningfulElements < 5 && bodyText.length < 200) {
            return `\n[⚠️ WARNING_EMPTY_PAGE: The page loaded but appears empty or still loading. Try read_page again in 2 seconds, or navigate to a different URL.]\n\n`;
        }

        return '';
    };
    const errorPrefix = checkError();
    // Detect editor pages (Google Docs, Notion, Medium, WordPress etc.)
    const isEditorPage = !!(
        document.querySelector('.docs-toolbar, .kix-appview-editor, .ProseMirror, .ql-editor, .ck-editor, #tinymce, .mce-container, .notion-topbar, [data-editor], .trix-content, .fr-toolbar') ||
        document.title.toLowerCase().includes('docs') ||
        location.hostname.includes('docs.google') ||
        location.hostname.includes('notion.so') ||
        location.hostname.includes('medium.com') ||
        document.querySelector('[role="toolbar"]')
    );

    // Main content
    const mainNode = document.querySelector('main, article, #content, .content, [role="main"]') || document.body;
    const pageText = (mainNode.innerText || document.body?.innerText || '')
        .replace(/\s+/g, ' ').trim().substring(0, isEditorPage ? 1000 : 2500);

    const dom = [];
    let n = 0;
    const seen = new Set();
    const MAX = isEditorPage ? 150 : 80;

    // Recursive Shadow DOM Selector
    function querySelectAllShadow(selector, root = document) {
        let elements = Array.from(root.querySelectorAll(selector));
        const allNodes = root.querySelectorAll('*');
        for (const node of allNodes) {
            if (node.shadowRoot) {
                elements = elements.concat(querySelectAllShadow(selector, node.shadowRoot));
            }
        }
        return elements;
    }

    const allElements = querySelectAllShadow('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="switch"], [role="searchbox"], [role="option"]');

    for (const el of allElements) {
        if (n >= MAX) break;

        // In normal mode, skip nav/footer. In editor mode, keep toolbars.
        if (!isEditorPage && el.closest('nav, footer, .header, .menu')) continue;

        // Skip invisible or duplicate elements
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;

        // Avoid duplicates by position
        const posKey = `${Math.round(r.left)},${Math.round(r.top)}`;
        if (seen.has(posKey)) continue;
        seen.add(posKey);

        const label = [
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('data-tooltip'),
            el.innerText,
            el.value,
            el.placeholder,
            el.getAttribute('aria-pressed') ? `[pressed:${el.getAttribute('aria-pressed')}]` : '',
        ].map(v => (v || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ').substring(0, 60);

        const role = el.getAttribute('role') || '';
        const type = el.tagName.toLowerCase() + (el.type ? ':' + el.type : '') + (role ? `[${role}]` : '');
        n++;
        el.setAttribute('data-ai-id', String(n));
        dom.push(`[ID:${n}][${type}] ${label}`);
    }

    const header = isEditorPage
        ? `📝 EDITOR PAGE DETECTED — toolbar buttons included below.\n`
        : '';

    return errorPrefix + header + pageText + '\n\n--- ELEMENTS ---\n' + dom.join('\n');
};

export async function scriptReadPage(tabId) {
    try {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: READ_PAGE_FUNC
        });
        return res?.result || '(דף ריק)';
    } catch (e) {
        return `❌ קריאת דף נכשלה: ${e.message}`;
    }
}

export async function scriptInteract(tabId, id, typeText, pressEnter) {
    try {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (elId, txt, doEnter) => {
                function findInShadow(id, root = document) {
                    let el = root.querySelector(`[data-ai-id="${id}"]`);
                    if (el) return el;
                    const all = root.querySelectorAll('*');
                    for (const node of all) {
                        if (node.shadowRoot) {
                            const found = findInShadow(id, node.shadowRoot);
                            if (found) return found;
                        }
                    }
                    return null;
                }
                const el = findInShadow(elId);
                if (!el) return { ok: false, msg: `ID ${elId} לא נמצא. קרא read_page שוב.` };
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // ── SELECT dropdown ──
                if (el.tagName === 'SELECT' && txt !== null) {
                    const opts = Array.from(el.options);
                    const match = opts.find(o => o.text.toLowerCase().includes(txt.toLowerCase()) || o.value.toLowerCase() === txt.toLowerCase());
                    if (match) { el.value = match.value; el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, msg: `בחרתי ב-SELECT: "${match.text}"` }; }
                    return { ok: false, msg: `ערך "${txt}" לא נמצא ב-SELECT. אפשרויות: ${opts.map(o => o.text).join(', ')}` };
                }

                // ── CHECKBOX / RADIO ──
                if ((el.type === 'checkbox' || el.type === 'radio') && txt === null) {
                    el.checked = !el.checked;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    return { ok: true, msg: `${el.type} [ID:${elId}] → ${el.checked ? 'סומן' : 'בוטל'}` };
                }

                // ── TEXT INPUT / TEXTAREA / contenteditable ──
                if (txt !== null && (
                    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
                    el.isContentEditable || el.getAttribute('role') === 'textbox' ||
                    el.getAttribute('role') === 'searchbox'
                )) {
                    el.focus();
                    el.click?.();
                    if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
                        el.innerText = '';
                        el.focus();
                        document.execCommand('insertText', false, txt);
                        if (!el.innerText.includes(txt)) el.innerText = txt;
                    } else {
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                        if (setter) setter.call(el, txt); else el.value = txt;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    if (doEnter) {
                        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    }
                    return { ok: true, msg: `הוקלד "${txt.substring(0, 40)}" ב-[ID:${elId}]${doEnter ? ' + Enter' : ''}` };
                }

                // ── CLICK ──
                el.focus?.();
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(ev =>
                    el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
                );
                el.click?.();
                return { ok: true, msg: `נלחץ [ID:${elId}]: ${(el.innerText || el.value || el.tagName).substring(0, 40)}` };
            },
            args: [String(id), typeText !== undefined ? typeText : null, !!pressEnter]
        });
        return res?.result || { ok: false, msg: 'תגובה ריקה' };
    } catch (e) {
        return { ok: false, msg: e.message };
    }
}

export async function scriptClickText(tabId, text) {
    try {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (txt) => {
                const lower = txt.toLowerCase().trim();
                const candidates = document.querySelectorAll('button,a,[role="button"],[role="link"],input[type="submit"],input[type="button"]');
                let best = null;
                for (const el of candidates) {
                    if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
                    const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
                    if (t === lower || t.includes(lower)) { best = el; break; }
                }
                if (!best) return { ok: false };
                best.scrollIntoView({ behavior: 'smooth', block: 'center' });
                best.focus?.();
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(ev =>
                    best.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true }))
                );
                best.click?.();
                return { ok: true };
            },
            args: [text]
        });
        return res?.result?.ok === true;
    } catch (e) {
        return false;
    }
}

export async function scriptTypeText(tabId, label, text) {
    try {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (lbl, txt) => {
                const lower = lbl.toLowerCase();
                const inputs = document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"],[role="searchbox"]');
                let target = null;
                for (const el of inputs) {
                    if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
                    const attrs = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id, el.title]
                        .map(a => (a || '').toLowerCase());
                    if (attrs.some(a => a === lower || a.includes(lower))) { target = el; break; }
                }
                if (!target) return false;
                target.focus?.();
                target.click?.();
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(target, txt); else target.value = txt;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            },
            args: [label, text]
        });
        return res?.result === true;
    } catch (e) {
        return false;
    }
}

export async function scriptExtract(tabId, selector) {
    try {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (sel) => {
                const els = document.querySelectorAll(sel);
                if (!els.length) return null;
                return Array.from(els).slice(0, 25)
                    .map((el, i) => `[${i + 1}] ${(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()}`)
                    .join('\n');
            },
            args: [selector]
        });
        return res?.result || null;
    } catch (e) {
        return null;
    }
}

// ─── Key Press (keyboard shortcut dispatcher) ────────────────────────
// Sends real keyboard shortcuts to a tab, targeting all frames.
// Works with Google Docs (sends to textevent iframe), Notion, Medium etc.
export async function scriptKeyPress(tabId, keys) {
    // Parse "ctrl+shift+b", "Enter", "ctrl+1" etc.
    const parts = keys.toLowerCase().split('+').map(s => s.trim());
    const mods = {
        ctrlKey: parts.includes('ctrl') || parts.includes('control'),
        metaKey: parts.includes('meta') || parts.includes('cmd'),
        shiftKey: parts.includes('shift'),
        altKey: parts.includes('alt') || parts.includes('option'),
    };
    const rawKey = parts.find(k => !['ctrl', 'control', 'meta', 'cmd', 'shift', 'alt', 'option'].includes(k)) || '';

    // Normalize key names
    const KEY_MAP = {
        'enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
        'return': { key: 'Enter', code: 'Enter', keyCode: 13 },
        'tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
        'escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
        'esc': { key: 'Escape', code: 'Escape', keyCode: 27 },
        'backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        'delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
        'space': { key: ' ', code: 'Space', keyCode: 32 },
        'arrowup': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        'arrowdown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        'arrowleft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        'arrowright': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        'home': { key: 'Home', code: 'Home', keyCode: 36 },
        'end': { key: 'End', code: 'End', keyCode: 35 },
        'pageup': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        'pagedown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
        'a': { key: 'a', code: 'KeyA', keyCode: 65 },
        'b': { key: 'b', code: 'KeyB', keyCode: 66 },
        'c': { key: 'c', code: 'KeyC', keyCode: 67 },
        'i': { key: 'i', code: 'KeyI', keyCode: 73 },
        'j': { key: 'j', code: 'KeyJ', keyCode: 74 },
        'k': { key: 'k', code: 'KeyK', keyCode: 75 },
        'l': { key: 'l', code: 'KeyL', keyCode: 76 },
        'r': { key: 'r', code: 'KeyR', keyCode: 82 },
        'u': { key: 'u', code: 'KeyU', keyCode: 85 },
        'v': { key: 'v', code: 'KeyV', keyCode: 86 },
        'x': { key: 'x', code: 'KeyX', keyCode: 88 },
        'y': { key: 'y', code: 'KeyY', keyCode: 89 },
        'z': { key: 'z', code: 'KeyZ', keyCode: 90 },
        '1': { key: '1', code: 'Digit1', keyCode: 49 },
        '2': { key: '2', code: 'Digit2', keyCode: 50 },
        '3': { key: '3', code: 'Digit3', keyCode: 51 },
        '4': { key: '4', code: 'Digit4', keyCode: 52 },
        '5': { key: '5', code: 'Digit5', keyCode: 53 },
        '6': { key: '6', code: 'Digit6', keyCode: 54 },
        '7': { key: '7', code: 'Digit7', keyCode: 55 },
        '8': { key: '8', code: 'Digit8', keyCode: 56 },
        'f1': { key: 'F1', code: 'F1', keyCode: 112 },
        'f2': { key: 'F2', code: 'F2', keyCode: 113 },
    };
    const ki = KEY_MAP[rawKey] || { key: rawKey, code: `Key${rawKey.toUpperCase()}`, keyCode: rawKey.charCodeAt(0) || 0 };

    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (ki, mods) => {
                const opts = { ...ki, ...mods, bubbles: true, cancelable: true };
                // Priority targets: active element, the hidden Docs text event iframe body, editor, body
                const docsFrame = document.querySelector('.docs-texteventtarget-iframe');
                const targets = [
                    document.activeElement,
                    docsFrame?.contentDocument?.body,
                    document.querySelector('[contenteditable="true"]'),
                    document.querySelector('.ProseMirror'),
                    document.querySelector('.ql-editor'),
                    document.body,
                ].filter(Boolean);
                for (const t of targets) {
                    try {
                        t.dispatchEvent(new KeyboardEvent('keydown', opts));
                        t.dispatchEvent(new KeyboardEvent('keypress', { ...opts }));
                        t.dispatchEvent(new KeyboardEvent('keyup', { ...opts }));
                    } catch (e) { }
                }
                return { ok: true };
            },
            args: [ki, mods]
        });
        await new Promise(r => setTimeout(r, 300));
        return { ok: true };
    } catch (e) {
        return { ok: false, msg: e.message };
    }
}

// ─── Editor Format (execCommand-based formatting) ────────────────
// Applies text formatting via execCommand in all frames.

export async function scriptAnalyzeEditor(tabId) {
    try {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                let platform = "Web (Generic)";
                let capabilities = ["read_page", "interact_element", "type_text"];
                let elements = [];
                let info = "";

                if (document.body.classList.contains('wp-admin') || document.querySelector('.edit-post-layout') || document.querySelector('#wpadminbar')) {
                    platform = "WordPress Editor";
                    capabilities.push("editor_format", "key_press", "type_in_editor");
                    document.querySelectorAll('.components-button, .mce-btn').forEach(btn => {
                        const label = btn.getAttribute('aria-label') || btn.innerText || btn.getAttribute('data-toolbar-item') || btn.title;
                        if (label && label.trim().length > 0) elements.push(`[WP Button] ${label.trim().replace(/\n/g, ' ')}`);
                    });
                    info = "Use 'editor_format' for basics. To interact with specific editor buttons, use 'click_text' with the button name.";
                }
                else if (document.querySelector('.notion-app-inner') || document.querySelector('[data-block-id]')) {
                    platform = "Notion";
                    capabilities.push("key_press", "type_in_editor");
                    info = "Notion relies fully on Markdown and slash commands. Use 'key_press' for enter/formatting, and 'type_text' starting with '/' to invoke Notion blocks.";
                }
                else if (window.location.hostname.includes('docs.google.com/document')) {
                    platform = "Google Docs";
                    capabilities.push("key_press", "click_text");
                    info = "Google Docs is canvas-based. 'editor_format' DOES NOT WORK. You MUST use 'key_press' for keyboard shortcuts (e.g., 'ctrl+b') or 'click_text' on top menu items.";
                    document.querySelectorAll('.docs-material-menu-button-inner-box, .goog-toolbar-button').forEach(btn => {
                        let lbl = btn.innerText || btn.getAttribute('aria-label') || btn.getAttribute('data-tooltip');
                        if (lbl && lbl.trim().length > 0) elements.push(`[Docs Menu/Btn] ${lbl.trim().replace(/\n/g, ' ')}`);
                    });
                }
                else if (document.querySelector('.tox-tinymce') || document.querySelector('.cke') || document.querySelector('.ql-editor') || document.querySelector('.fr-box')) {
                    platform = "Rich Text Editor (Generic)";
                    capabilities.push("editor_format", "click_text", "type_in_editor");
                    info = "Standard HTML-based rich text editor. Use 'editor_format' to style text, or 'type_in_editor'.";
                    document.querySelectorAll('button[title], .tox-tbtn, .cke_button, .fr-command').forEach(btn => {
                        const label = btn.title || btn.getAttribute('aria-label') || btn.getAttribute('data-cmd') || btn.innerText;
                        if (label && label.trim().length > 0) elements.push(`[Editor Btn] ${label.trim().replace(/\n/g, ' ')}`);
                    });
                }
                else {
                    const editable = document.querySelector('[contenteditable="true"]');
                    if (editable) {
                        platform = "ContentEditable Element";
                        capabilities.push("editor_format", "type_in_editor");
                        info = "A generic contenteditable wrapper. 'editor_format' should work natively.";
                    } else {
                        platform = "No Rich Editor Detected";
                        info = "Standard web page forms. Use standard interactive commands.";
                    }
                }

                const uniqueElements = [...new Set(elements)];
                const responseText = "Editor Platform: " + platform + "\nCapabilities Supported Here: " + capabilities.join(', ') + "\nStrategy: " + info + (uniqueElements.length > 0 ? "\nAvailable Document Editing Toolbar Buttons:\n" + uniqueElements.slice(0, 25).join('\n') : "");
                return { ok: true, text: responseText };
            }
        });
        return res?.result || { ok: false, text: "Failed to run analyze_editor script." };
    } catch (e) {
        return { ok: false, text: "Error: " + e.message };
    }
}

export async function scriptEditorFormat(tabId, command, value) {
    // Map high-level intuitive commands to execCommand equivalents
    const CMD_MAP = {
        'bold': ['bold', null], 'italic': ['italic', null],
        'underline': ['underline', null], 'strikethrough': ['strikeThrough', null],
        'h1': ['formatBlock', 'h1'], 'h2': ['formatBlock', 'h2'],
        'h3': ['formatBlock', 'h3'], 'h4': ['formatBlock', 'h4'],
        'h5': ['formatBlock', 'h5'], 'h6': ['formatBlock', 'h6'],
        'paragraph': ['formatBlock', 'p'], 'blockquote': ['formatBlock', 'blockquote'],
        'pre': ['formatBlock', 'pre'],
        'align-left': ['justifyLeft', null], 'align-center': ['justifyCenter', null],
        'align-right': ['justifyRight', null], 'align-justify': ['justifyFull', null],
        'bullet-list': ['insertUnorderedList', null],
        'numbered-list': ['insertOrderedList', null],
        'indent': ['indent', null], 'outdent': ['outdent', null],
        'remove-format': ['removeFormat', null],
        'select-all': ['selectAll', null],
        'undo': ['undo', null], 'redo': ['redo', null],
        'link': ['createLink', value],
        'unlink': ['unlink', null],
        'superscript': ['superscript', null],
        'subscript': ['subscript', null],
        'font-size': ['fontSize', value],  // value: 1-7
        'font-name': ['fontName', value],  // value: font name
        'fore-color': ['foreColor', value], // value: #hex or color name
        'back-color': ['backColor', value],
    };

    let [cmd, val] = CMD_MAP[command] || [command, value ?? null];
    if (value !== undefined && value !== null && !CMD_MAP[command]) val = value;

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (cmd, val) => {
                try {
                    const ok = document.execCommand(cmd, false, val || null);
                    return { ok, method: `execCommand[${cmd}=${val}]` };
                } catch (e) {
                    return { ok: false, msg: e.message };
                }
            },
            args: [cmd, val]
        });
        const success = results.find(r => r.result?.ok);
        return success?.result || { ok: false, method: 'no-frame-succeeded' };
    } catch (e) {
        return { ok: false, msg: e.message };
    }
}


// Works with: Google Docs, Notion, Medium, WordPress/Gutenberg, TinyMCE,
// Quill, Draft.js, CKEditor, ProseMirror, Trix, Froala, and any other
// contenteditable-based rich text editor.
export async function scriptRichTextType(tabId, text, clearFirst = false) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (txt, clr) => {

                // Ordered list of known rich-text editor selectors
                const EDITOR_SELECTORS = [
                    // Google Docs hidden textevent frame body
                    'body[contenteditable="true"]',
                    'body[contenteditable]',
                    // ProseMirror (Notion, Confluence, Outline, many others)
                    '.ProseMirror',
                    // Quill
                    '.ql-editor',
                    // Draft.js (Facebook, Messenger, many React apps)
                    '.public-DraftEditor-content',
                    '.DraftEditor-editorContainer [contenteditable]',
                    // CKEditor 5
                    '.ck-editor__editable',
                    '.ck-content',
                    // TinyMCE (in same-frame mode)
                    '#tinymce',
                    '.mce-content-body',
                    // Froala
                    '.fr-element',
                    // Trix (Basecamp, hey.com, Rails defaults)
                    'trix-editor',
                    // WordPress Gutenberg blocks
                    '.wp-block [contenteditable]',
                    '.editor-post-title__input',
                    // Notion
                    '[contenteditable][data-content-editable-leaf]',
                    '[contenteditable][data-content-editable-void]',
                    // Slate.js
                    '[data-slate-editor="true"]',
                    // Medium / Ghost
                    '.medium-editor-element',
                    '.kg-prose',
                    // Generic: any role="textbox" or contenteditable
                    '[role="textbox"][contenteditable]',
                    '[contenteditable="true"]',
                ];

                function mdToHtml(md) {
                    let lines = md.split('\\n');
                    let htmlLines = [];
                    let listType = null; // 'ul' or 'ol'
                    for (let i = 0; i < lines.length; i++) {
                        let line = lines[i];
                        let isUl = line.match(/^[-*] /);
                        let isOl = line.match(/^\\d+\\. /);

                        if (isUl || isOl) {
                            let currentType = isUl ? 'ul' : 'ol';
                            if (listType !== currentType) {
                                if (listType) htmlLines.push('</' + listType + '>');
                                htmlLines.push('<' + currentType + ' dir="rtl" style="direction: rtl; text-align: right;">');
                                listType = currentType;
                            }
                            let content = line.replace(/^[-*] /, '').replace(/^\\d+\\. /, '');
                            content = content.replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>').replace(/\\*(.*?)\\*/g, '<i>$1</i>');
                            htmlLines.push('<li dir="rtl" style="direction: rtl; text-align: right;">' + content + '</li>');
                        } else {
                            if (listType) {
                                htmlLines.push('</' + listType + '>');
                                listType = null;
                            }
                            let parsedLine = line.replace(/^### (.*$)/gim, '<h3>$1</h3>')
                                .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                                .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                                .replace(/\\*\\*(.*?)\\*\\*/gim, '<b>$1</b>')
                                .replace(/\\*(.*?)\\*/gim, '<i>$1</i>');
                            if (parsedLine.trim() === '') {
                                htmlLines.push('<br>');
                            } else if (!parsedLine.match(/^<h/)) {
                                htmlLines.push('<div dir="rtl" style="direction: rtl; text-align: right;">' + parsedLine + '</div>');
                            } else {
                                htmlLines.push(parsedLine.replace('<h', '<h dir="rtl" style="direction: rtl; text-align: right;" '));
                            }
                        }
                    }
                    if (listType) htmlLines.push('</' + listType + '>');
                    // Wrap everything in a container for Docs
                    return '<div dir="rtl" style="direction: rtl; text-align: right;">' + htmlLines.join('\\n') + '</div>';
                }

                function tryExecCommand(doc, el, txt, clr) {
                    el.click?.();
                    el.focus?.();
                    el.scrollIntoView?.({ block: 'center' });
                    if (clr) doc.execCommand('selectAll', false, null);

                    let htmlText = mdToHtml(txt);

                    let ok = false;

                    // 1. Prioritize simulated Paste event. Google Docs handles this natively.
                    try {
                        const dt = new DataTransfer();
                        dt.setData('text/plain', txt);
                        dt.setData('text/html', htmlText);
                        const pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });

                        // If preventDefault() is called by the host, dispatchEvent returns false.
                        let wasPrevented = !el.dispatchEvent(pasteEvent);
                        if (wasPrevented) {
                            ok = true;
                        }
                    } catch (e) { }

                    // 2. Fallback to execCommand insertHTML
                    if (!ok) {
                        try { ok = doc.execCommand('insertHTML', false, htmlText); } catch (e) { }
                    }

                    // 3. Fallback to raw text
                    if (!ok) {
                        try { ok = doc.execCommand('insertText', false, txt); } catch (e) { }
                    }

                    // 4. Fallback to TextEvent
                    if (!ok) {
                        try {
                            const textEv = doc.createEvent('TextEvent');
                            textEv.initTextEvent('textInput', true, true, window, txt, 9, "en-US");
                            el.dispatchEvent(textEv);
                            ok = true;
                        } catch (e) { }
                    }
                    return ok;
                }

                // ─── Strategy A.1: Google Docs Specific Hack
                const gDocsIframe = document.querySelector('.docs-texteventtarget-iframe');
                if (gDocsIframe && gDocsIframe.contentDocument) {
                    const iBody = gDocsIframe.contentDocument.body;
                    if (iBody) {
                        const ok = tryExecCommand(gDocsIframe.contentDocument, iBody, txt, clr);
                        return { ok: true, method: 'gdocs-iframe-hack' };
                    }
                }

                // ─── Strategy A: Generic iframe body (TinyMCE / etc)
                const body = document.body;
                const isEditableBody = body && (
                    body.contentEditable === 'true' ||
                    body.getAttribute('contenteditable') !== null
                ) && body.children.length <= 3;

                if (isEditableBody) {
                    const ok = tryExecCommand(document, body, txt, clr);
                    if (ok) return { ok: true, method: 'editable-body-frame' };
                }

                // ─── Strategy B: scan known selectors in the current frame (main or sub)
                for (const sel of EDITOR_SELECTORS) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    // Skip zero-size elements (hidden)
                    if (el.tagName !== 'BODY' && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
                    const ok = tryExecCommand(document, el, txt, clr);
                    if (ok) return { ok: true, method: `execCommand[${sel}]` };
                }

                // ─── Strategy C: scan all iframes for embedded editors (TinyMCE, CKEditor 4)
                const iframes = document.querySelectorAll('iframe');
                for (const fr of iframes) {
                    try {
                        const iDoc = fr.contentDocument || fr.contentWindow?.document;
                        if (!iDoc) continue;
                        // Try body first (TinyMCE iframe pattern)
                        const iBody = iDoc.body;
                        if (iBody && (iBody.contentEditable === 'true' || iBody.getAttribute('contenteditable') !== null)) {
                            const ok = tryExecCommand(iDoc, iBody, txt, clr);
                            if (ok) return { ok: true, method: `iframe-body[${fr.id || fr.className.slice(0, 20)}]` };
                        }
                        // Try known selectors inside the iframe
                        for (const sel of EDITOR_SELECTORS) {
                            const el = iDoc.querySelector(sel);
                            if (!el) continue;
                            const ok = tryExecCommand(iDoc, el, txt, clr);
                            if (ok) return { ok: true, method: `iframe-sel[${sel}]` };
                        }
                    } catch (e) { continue; }
                }

                return { ok: false, method: 'no-compatible-editor-found' };
            },
            args: [text, clearFirst]
        });
        // Return the first frame that succeeded
        const success = results.find(r => r.result?.ok);
        if (success) return success.result;
        return results[results.length - 1]?.result || { ok: false, method: 'no-result' };
    } catch (e) {
        return { ok: false, method: 'exception', msg: e.message };
    }
}
