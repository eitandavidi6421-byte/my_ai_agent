// content-agent.js - מבצע פעולות אמיתיות על הדף ביעילות מרבית

// ═══════════════════════════════════════════════════════════
// ADVANCED DOM ENGINE (Shadow DOM, React/Vue, Human Clicks)
// ═══════════════════════════════════════════════════════════
const DOMUtils = {
    // 1. Deep Query Selector (Pierces Shadow DOMs)
    querySelectorAllDeep: function (selector, root = document) {
        const result = [];
        const traverse = (node) => {
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
            if (node.matches && node.matches(selector)) result.push(node);
            if (node.shadowRoot) traverse(node.shadowRoot);
            for (const child of node.children) traverse(child);
        };
        traverse(root);
        return result;
    },

    // 2. Visibility Checker (Ignores visually hidden elements)
    isVisible: function (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
        return true;
    },

    // 3. React/Vue Native Value Setter
    setNativeValue: function (element, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

        // React overrides the default setter. We must call the prototype's setter.
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else if (valueSetter) {
            valueSetter.call(element, value);
        } else {
            element.value = value;
        }

        // Dispatch events to trigger framework state updates
        element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    },

    // 4. Human-like Click Simulator
    simulateClick: function (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.focus?.();

        const events = ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        events.forEach(evType => {
            const ev = new MouseEvent(evType, {
                bubbles: true,
                cancelable: true,
                view: window,
                buttons: 1
            });
            element.dispatchEvent(ev);
        });

        // Fallback for extremely stubborn elements
        if (typeof element.click === 'function') {
            try { element.click(); } catch (e) { }
        }
    },

    // 5. DOM Quiet Observer (Detects when page stops rendering)
    waitForDOMQuiet: function (timeoutMs = 3000, debounceMs = 400) {
        return new Promise(resolve => {
            let timer = null;
            let maxTimer = null;
            let observer = null;

            const finish = () => {
                if (timer) clearTimeout(timer);
                if (maxTimer) clearTimeout(maxTimer);
                if (observer) observer.disconnect();
                resolve();
            };

            observer = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(finish, debounceMs);
            });

            // Start observing mutations in the body/document
            // CRITICAL FIX: Removed 'attributes' to prevent infinite loops from blinking cursors or tracking scripts
            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true
            });

            // Initial timers
            timer = setTimeout(finish, debounceMs);
            maxTimer = setTimeout(finish, timeoutMs);
        });
    }
};

// ═══════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // ═══════════════════════════════════════════════════════════
    // SKILL INITIALIZATION & HEARTBEAT (Orchestrator Integration)
    // ═══════════════════════════════════════════════════════════

    /**
     * init_skill: Called by the SwarmOrchestrator after tab creation.
     * Sets this agent's skill type and starts a heartbeat interval
     * that prevents the orchestrator's watchdog from killing this tab.
     *
     * Message: { action: 'init_skill', skill: 'researcher', agentId: 'agent_xxx' }
     */
    if (request.action === 'init_skill') {
        window.__agentSkill = request.skill;      // 'researcher' | 'action_writer' | 'google_manager'
        window.__agentId = request.agentId;

        // Clear previous heartbeat if re-initialized
        if (window.__heartbeatInterval) {
            clearInterval(window.__heartbeatInterval);
        }

        // Send heartbeat every 15s (well within 30-60s watchdog windows)
        window.__heartbeatInterval = setInterval(() => {
            try {
                chrome.runtime.sendMessage({
                    action: 'agent_heartbeat',
                    agentId: window.__agentId,
                });
            } catch (e) {
                // Extension context invalidated — stop heartbeat
                clearInterval(window.__heartbeatInterval);
            }
        }, 15_000);

        console.log(`[Content-Agent] Initialized with skill: ${request.skill}, id: ${request.agentId}`);
        sendResponse({ success: true, skill: request.skill });
        return true;
    }

    /**
     * get_agent_info: Returns the current agent's skill and ID.
     * Used by the dashboard to identify which agent is running in a tab.
     */
    if (request.action === 'get_agent_info') {
        sendResponse({
            skill: window.__agentSkill || null,
            agentId: window.__agentId || null,
        });
        return true;
    }

    if (request.action === "scroll") {
        window.scrollBy(0, request.amount || 800);
        sendResponse({ success: true });
        return true;
    }

    // ─── READ PAGE (Advanced Mapping) ───
    if (request.action === "read_page") {
        // המתן עד שה-DOM "שקט" (מסיימים לרנדר React/Vue) או מקסימום 3 שניות
        DOMUtils.waitForDOMQuiet(3000, 400).then(() => {
            // העדפה לאלמנטים מרכזיים (main, article) ומניעת זבל מתחתית האתר
            const mainNode = document.querySelector('main, article, #content, .content, [role="main"]') || document.body || document.documentElement;
            let pageText = mainNode ? mainNode.innerText.replace(/\s+/g, ' ').trim().substring(0, 2500) : "ריק.";

            let domMap = [];
            let idCounter = 1;
            window.__agentElementsMap = new Map();

            // Use our deep selector to find elements even inside Shadow DOMs
            const selectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="switch"], [role="searchbox"], [role="option"]';
            const elements = DOMUtils.querySelectorAllDeep(selectors);

            for (let el of elements) {
                if (idCounter > 100) break; // Prevent massive payloads
                if (!DOMUtils.isVisible(el)) continue;

                let text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || "").replace(/\s+/g, ' ').trim();
                let typeStr = el.tagName.toLowerCase() + (el.type ? `:${el.type}` : '');

                // Filter out useless empty elements
                if (!text && !['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue;

                domMap.push(`[ID:${idCounter}] [${typeStr}] ${text.substring(0, 50)}`);
                window.__agentElementsMap.set(idCounter, el);
                idCounter++;
            }

            let mapString = domMap.length > 0
                ? "\n\n--- מפת אלמנטים אינטראקטיביים במסך ---\n" + domMap.join('\n')
                : "\n\n--- אין אלמנטים אינטראקטיביים קריאים במסך ---";

            sendResponse({ success: true, text: pageText + mapString });
        });

        // CRITICAL FIX: Returning true immediately to keep the Chrome messaging port open for the async sendResponse!
        return true;
        return true; // Keep channel open for async response
    }

    // ─── INTERACT ELEMENT (Robust Execution) ───
    if (request.action === "interact_element") {
        let el = window.__agentElementsMap ? window.__agentElementsMap.get(request.id) : null;
        if (!el) {
            sendResponse({ success: false, feedback: `❌ שגיאה: ID ${request.id} לא נמצא. בצע read_page מחדש.` });
            return true;
        }

        try {
            // 1. Handle Select Dropdowns
            if (el.tagName === 'SELECT' && request.typeText !== undefined && request.typeText !== null) {
                const opts = Array.from(el.options);
                const match = opts.find(o => o.text.toLowerCase().includes(request.typeText.toLowerCase()) || o.value.toLowerCase() === request.typeText.toLowerCase());
                if (match) {
                    el.value = match.value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    sendResponse({ success: true, feedback: `✅ בחרתי ב-SELECT: "${match.text}"` });
                } else {
                    sendResponse({ success: false, feedback: `❌ ערך "${request.typeText}" לא נמצא ב-SELECT.` });
                }
                return true;
            }

            // 2. Handle Checkbox / Radio
            if ((el.type === 'checkbox' || el.type === 'radio') && (request.typeText === undefined || request.typeText === null)) {
                el.checked = !el.checked;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
                sendResponse({ success: true, feedback: `✅ ${el.type} [ID:${request.id}] ${el.checked ? 'סומן' : 'בוטל'}.` });
                return true;
            }

            // 3. Handle Text Input (React/Vue safe)
            if (request.typeText !== undefined && request.typeText !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'searchbox')) {
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
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                }
                sendResponse({ success: true, feedback: `✅ הוקלד "${request.typeText.substring(0, 40)}" ב-[ID:${request.id}]${request.pressEnter ? ' + Enter' : ''}` });
                return true;
            }

            // 4. Handle Clicks (Human-like)
            DOMUtils.simulateClick(el);
            sendResponse({ success: true, feedback: `✅ נלחץ בהצלחה אלמנט [ID:${request.id}].` });

        } catch (e) {
            sendResponse({ success: false, feedback: `❌ שגיאה באינטראקציה: ${e.message}` });
        }
        return true;
    }

    if (request.action === "click_css") {
        try {
            const target = document.querySelector(request.selector);
            if (target) {
                DOMUtils.simulateClick(target);
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false });
            }
        } catch (e) {
            sendResponse({ success: false });
        }
        return true;
    }

    if (request.action === "extract_data") {
        try {
            const elements = document.querySelectorAll(request.selector);
            if (elements.length > 0) {
                const extractedText = Array.from(elements)
                    .map(el => (el.innerText || el.textContent || "").replace(/\s+/g, ' ').trim())
                    .filter(text => text.length > 5)
                    .map((text, index) => `[פריט ${index + 1}] ${text}`)
                    .join('\n');

                sendResponse({ success: true, text: extractedText.substring(0, 3000) });
            } else {
                sendResponse({ success: false, text: "לא נמצאו נתונים התואמים לבקשה." });
            }
        } catch (e) {
            sendResponse({ success: false });
        }
        return true;
    }

    // ─── ADVANCED EDITING & TYPING ───
    if (request.action === "key_press") {
        let el = request.id && window.__agentElementsMap ? window.__agentElementsMap.get(request.id) : document.activeElement;
        if (!el || el === document.body) {
            sendResponse({ success: false, feedback: `❌ לא נמצא אלמנט ממוקד לשליחת מקשים. ניתן לציין id מה-read_page.` });
            return true;
        }

        try {
            const keyParts = request.key.split('+');
            const keyName = keyParts.pop(); // e.g. 'b' from 'Ctrl+b' or 'Enter'
            const ctrlKey = keyParts.includes('Ctrl') || keyParts.includes('Cmd');
            const shiftKey = keyParts.includes('Shift');
            const altKey = keyParts.includes('Alt');

            const eventInfo = {
                key: keyName,
                code: keyName,
                keyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 13,
                ctrlKey, shiftKey, altKey, metaKey: ctrlKey,
                bubbles: true, cancelable: true
            };

            el.dispatchEvent(new KeyboardEvent('keydown', eventInfo));
            if (keyName.length === 1 && !ctrlKey && !altKey) {
                el.dispatchEvent(new KeyboardEvent('keypress', eventInfo));
            }
            el.dispatchEvent(new KeyboardEvent('keyup', eventInfo));

            sendResponse({ success: true, feedback: `✅ הוקש [${request.key}] בהצלחה.` });
        } catch (e) {
            sendResponse({ success: false, feedback: `❌ שגיאה בשליחת מקש: ${e.message}` });
        }
        return true;
    }

    if (request.action === "editor_format") {
        try {
            const { command, value } = request;
            let success = false;

            // Using document.execCommand for rich text editors (contenteditable)
            if (document.queryCommandSupported && document.queryCommandSupported(command)) {
                success = document.execCommand(command, false, value || null);
            }

            if (success) {
                sendResponse({ success: true, feedback: `✅ הופעל עיצוב: ${command} ${value ? 'עם הערך ' + value : ''}` });
            } else {
                // Fallback: force focus on active edit area and try again
                let active = document.activeElement;
                if (active && (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
                    success = document.execCommand(command, false, value || null);
                    if (success) {
                        sendResponse({ success: true, feedback: `✅ (אילוץ פוקוס) הופעל עיצוב: ${command}` });
                    } else {
                        sendResponse({ success: false, feedback: `❌ הפעלת עיצוב (${command}) נכשלה. ייתכן שאין טקסט מסומן בחלון או שהפקודה אינה נתמכת בעורך זה.` });
                    }
                } else {
                    sendResponse({ success: false, feedback: `❌ טכניקת עיצוב נכשלה. ודא שסמן העריכה נמצא בתוך תיבת הטקסט.` });
                }
            }
        } catch (e) {
            sendResponse({ success: false, feedback: `❌ שגיאה בעיצוב: ${e.message}` });
        }
        return true;
    }

    if (request.action === "analyze_editor") {
        try {
            let platform = "Web (Generi)";
            let capabilities = ["read", "click", "type"];
            let elements = [];

            // 1. WordPress (Gutenberg/Classic)
            if (document.body.classList.contains('wp-admin') || document.querySelector('.edit-post-layout') || document.querySelector('#wpadminbar')) {
                platform = "WordPress";
                capabilities.push("formatting", "blocks", "autosave");
                document.querySelectorAll('.components-button, .mce-btn').forEach(btn => {
                    const label = btn.getAttribute('aria-label') || btn.innerText || btn.getAttribute('data-toolbar-item') || btn.title;
                    if (label && label.trim().length > 0) elements.push(`[WP Button] ${label.trim().replace(/\n/g, ' ')}`);
                });
            }
            // 2. Notion
            else if (document.querySelector('.notion-app-inner') || document.querySelector('[data-block-id]')) {
                platform = "Notion";
                capabilities.push("blocks", "slash-commands", "markdown");
                elements.push("ניתן להשתמש בלוכסן '/' לפתיחת תפריט הבלוקים ופקודות הטקסט");
            }
            // 3. Google Docs
            else if (window.location.hostname.includes('docs.google.com/document')) {
                platform = "Google Docs";
                capabilities.push("canvas-based", "menus", "offline-sync");
                elements.push("עורך קנבס ייעודי - ניתן לגשת לתפריטים העליונים דרך מבנה .docs-material-menu-button-inner-box");
            }
            // 4. Standard Rich Text (TinyMCE, CKEditor, Quill, Froala)
            else if (document.querySelector('.tox-tinymce') || document.querySelector('.cke') || document.querySelector('.ql-editor') || document.querySelector('.fr-box')) {
                platform = "Rich Text Editor (Generic)";
                capabilities.push("html-formatting", "toolbar-clicks");
                document.querySelectorAll('button[title], .tox-tbtn, .cke_button, .fr-command').forEach(btn => {
                    const label = btn.title || btn.getAttribute('aria-label') || btn.getAttribute('data-cmd') || btn.innerText;
                    if (label && label.trim().length > 0) elements.push(`[Editor Btn] ${label.trim().replace(/\n/g, ' ')}`);
                });
            }
            // 5. Native ContentEditable
            else {
                const editable = document.querySelector('[contenteditable="true"]');
                if (editable) {
                    platform = "ContentEditable Element";
                    capabilities.push("native-execCommand", "html-formatting");
                }
            }

            // remove duplicates from elements list
            const uniqueElements = [...new Set(elements)];

            const responseText = `🔍 ניתוח סביבת טקסט:
פלטפורמה מזוהה: ${platform}
יכולות סוכן נתמכות כאן: ${capabilities.join(', ')}
${uniqueElements.length > 0 ? '\nכפתורי עורך/סרגל כלים זמינים כרגע:\n' + uniqueElements.slice(0, 20).join('\n') : ''}`;

            sendResponse({ success: true, text: responseText, platform, capabilities });
        } catch (e) {
            sendResponse({ success: false, text: `❌ שגיאה בניתוח סביבת העורך: ${e.message}` });
        }
        return true;
    }

    // --- לוגיקה חכמה וסבלנית לזיהוי ולחיצה על אלמנטים (Legacy Fallback) ---
    if (request.action === "complex_click") {
        const txt = request.text.toLowerCase().trim();

        const searchInElements = (elements) => {
            let bestEl = null;
            let minDiff = Infinity;
            for (let el of elements) {
                if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
                const innerTxt = (el.innerText || el.textContent || '').toLowerCase().trim();
                const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
                const title = (el.getAttribute('title') || '').toLowerCase().trim();
                if (innerTxt === txt || aria === txt || title === txt) return el;
                if (innerTxt.includes(txt) || aria.includes(txt) || title.includes(txt)) {
                    let matchText = innerTxt.includes(txt) ? innerTxt : (aria.includes(txt) ? aria : title);
                    let diff = Math.abs(matchText.length - txt.length);
                    if (diff < minDiff && diff < 30) { minDiff = diff; bestEl = el; }
                }
            }
            return bestEl;
        };

        let attempts = 0;
        const attemptClick = () => {
            let errClose = document.querySelector('button[name="ok"], button[name="close"]');
            if (errClose && (txt === "שליחה" || txt === "send")) {
                errClose.click();
            }

            let target = null;

            // צלף ייעודי ואגרסיבי לכפתור שליחה בג'ימייל
            if (txt === "שליחה" || txt === "send" || txt.includes("שלח")) {
                target = document.querySelector('div[aria-label^="שליחה"], div[aria-label^="Send"], div[data-tooltip^="Send"][role="button"]');
            }

            if (!target) {
                target = searchInElements(document.querySelectorAll('button, a, [role="button"], [role="link"], div[role="button"], input[type="button"], div[aria-label="שליחה"], input[type="radio"]'));
            }
            if (!target) {
                target = searchInElements(document.querySelectorAll('span, div, li, label'));
            }

            if (target && target.offsetParent !== null) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (target.tagName === 'LABEL' || target.tagName === 'SPAN' || target.tagName === 'DIV') {
                    let radio = target.querySelector('input[type="radio"]') || target.parentElement.querySelector('input[type="radio"]');
                    if (radio) { radio.click(); sendResponse({ success: true }); return; }
                }
                let clickTarget = target.closest('button, a, [role="button"]') || target;
                DOMUtils.simulateClick(clickTarget);
                sendResponse({ success: true });
            } else {
                attempts++;
                if (attempts < 8) {
                    // מנגנון סבלנות: מנסה שוב בעוד חצי שנייה (עד 4 שניות המתנה)
                    setTimeout(attemptClick, 500);
                } else {
                    sendResponse({ success: false });
                }
            }
        };

        attemptClick();
        return true;
    }

    // Helper to penetrate Shadow DOM barriers (Legacy Fallback)
    const querySelectorDeep = (selector, root = document) => {
        let el = root.querySelector && root.querySelector(selector);
        if (el) return el;
        const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let e of elements) {
            if (e.shadowRoot) {
                el = querySelectorDeep(selector, e.shadowRoot);
                if (el) return el;
            }
        }
        return null;
    };

    // חיפוש חכם בהיררכיית DOM (Legacy Fallback)
    if (request.action === "complex_type") {
        const lbl = request.label.toLowerCase().trim();
        const txt = request.text;
        let target = null;
        let fieldType = "";

        const findInput = () => {
            if (lbl.includes('נמענים') || lbl.includes('to') || lbl === 'אל') {
                fieldType = "to";
                return querySelectorDeep('[role="combobox"], input[aria-label="To"], input[aria-label="נמענים"]');
            }
            if (lbl.includes('נושא') || lbl.includes('subject')) {
                fieldType = "subject";
                return querySelectorDeep('input[name="subjectbox"], input[placeholder="נושא"], input[placeholder="Subject"]');
            }
            if (lbl.includes('תוכן') || lbl.includes('הודעה') || lbl.includes('body') || lbl.includes('message')) {
                fieldType = "body";
                return querySelectorDeep('div[aria-label="Message Body"], div[role="textbox"][aria-multiline="true"]');
            }

            let labels = Array.from(document.querySelectorAll('label'));
            for (let l of labels) {
                const labelText = (l.innerText || l.textContent || '').toLowerCase().trim();
                if (labelText === lbl || labelText.includes(lbl)) {
                    const inputId = l.getAttribute('for');
                    if (inputId) {
                        const input = document.getElementById(inputId);
                        if (input) return input;
                    }
                    let associatedInput = l.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]');
                    if (associatedInput) return associatedInput;
                    associatedInput = l.nextElementSibling?.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]');
                    if (associatedInput) return associatedInput;
                }
            }

            const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'));
            for (let el of inputs) {
                if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();

                if ((aria.includes("חיפוש") || aria.includes("search") || placeholder.includes("חיפוש")) && !lbl.includes("חיפוש")) continue;

                const attrs = [placeholder, aria, (el.getAttribute('name') || '').toLowerCase()];
                if (attrs.some(a => a === lbl || a.includes(lbl))) { target = el; break; }
            }
        }

        target = findInput();

        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.focus();
            target.click();

            setTimeout(() => {
                if (fieldType === "body" || target.isContentEditable || target.getAttribute('role') === 'textbox') {
                    target.innerText = txt;
                    target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                    target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
                } else {
                    DOMUtils.setNativeValue(target, txt);

                    if (fieldType === "to") {
                        setTimeout(() => {
                            ['Enter', 'Tab'].forEach(k => {
                                target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: k === 'Enter' ? 13 : 9, bubbles: true }));
                                target.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, keyCode: k === 'Enter' ? 13 : 9, bubbles: true }));
                            });
                            sendResponse({ success: true, type: fieldType });
                        }, 600);
                        return;
                    }
                }
                sendResponse({ success: true, type: fieldType });
            }, 300);
            return true;
        } else {
            sendResponse({ success: false, type: "not_found" });
        }
        return true;
    }

    return true;
});

// ═══════════════════════════════════════════════════════════
// YOUTUBE AD KILLER (Optimized)
// ═══════════════════════════════════════════════════════════
if (window.location.hostname.includes("youtube.com")) {
    console.log("AI Agent: YouTube Ad Killer is running (Optimized)...");

    const handleAds = () => {
        const isAdPlaying = document.querySelector('.ad-showing') || document.querySelector('.ytp-ad-player-overlay');
        const videoElement = document.querySelector('video');

        if (isAdPlaying && videoElement && !isNaN(videoElement.duration)) {
            videoElement.currentTime = videoElement.duration;
            console.log("AI Agent: הרצתי את הפרסומת לסוף!");
        }

        const skipButton = document.querySelector(`
            .ytp-ad-skip-button, 
            .ytp-ad-skip-button-modern, 
            .ytp-skip-ad-button, 
            .videoAdUiSkipButton,
            button[id^="skip-button"]
        `);

        if (skipButton && skipButton.offsetParent !== null) {
            skipButton.click();
            console.log("AI Agent: נלחץ כפתור דילוג מובנה.");
        }

        const specificSkipButtons = document.querySelectorAll('.ytp-ad-text.ytp-ad-skip-button-text, .ytp-ad-skip-button-container *');
        for (let el of specificSkipButtons) {
            if (el.offsetParent === null) continue;
            const text = (el.innerText || el.textContent || "").trim();
            if (["דילוג", "דילוג על מודעות", "skip ads", "skip ad", "skip"].includes(text.toLowerCase())) {
                el.click();
                if (el.parentElement) el.parentElement.click();
            }
        }

        const overlayAdCloseButton = document.querySelector('.ytp-ad-overlay-close-button');
        if (overlayAdCloseButton && overlayAdCloseButton.offsetParent !== null) {
            overlayAdCloseButton.click();
        }
    };

    function throttle(func, limit) {
        let inThrottle;
        return function () {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        }
    }

    const throttledHandleAds = throttle(handleAds, 500);

    const observer = new MutationObserver((mutations) => {
        throttledHandleAds();
    });

    const initObserver = () => {
        const ytdPlayer = document.getElementById('ytd-player') || document.querySelector('ytd-player');
        if (ytdPlayer) {
            observer.observe(ytdPlayer, { childList: true, subtree: true });
        } else {
            // מאזין קל וזמני רק עד להיווצרות הנגן, כדי למנוע עומס על ה-CPU
            const bodyObserver = new MutationObserver((mutations) => {
                const player = document.getElementById('ytd-player') || document.querySelector('ytd-player');
                if (player) {
                    bodyObserver.disconnect();
                    observer.observe(player, { childList: true, subtree: true });
                }
            });
            bodyObserver.observe(document.body, { childList: true, subtree: true });
        }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initObserver);
    } else {
        initObserver();
    }
}