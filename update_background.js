const fs = require("fs");
const path = require("path");

const filePath = path.join(
  "c:/Users/IMOE001/Documents/הבינה המלכותית שלי/background.js",
);
let content = fs.readFileSync(filePath, "utf8");

// 1. Add scriptAnalyzeEditor function
const analyzeFunc = `
async function scriptAnalyzeEditor(tabId) {
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
                if (label && label.trim().length > 0) elements.push(\`[WP Button] \${label.trim().replace(/\\n/g,' ')}\`);
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
                if (lbl && lbl.trim().length > 0) elements.push(\`[Docs Menu/Btn] \${lbl.trim().replace(/\\n/g,' ')}\`);
            });
        }
        else if (document.querySelector('.tox-tinymce') || document.querySelector('.cke') || document.querySelector('.ql-editor') || document.querySelector('.fr-box')) {
            platform = "Rich Text Editor (Generic)";
            capabilities.push("editor_format", "click_text", "type_in_editor");
            info = "Standard HTML-based rich text editor. Use 'editor_format' to style text, or 'type_in_editor'.";
            document.querySelectorAll('button[title], .tox-tbtn, .cke_button, .fr-command').forEach(btn => {
                const label = btn.title || btn.getAttribute('aria-label') || btn.getAttribute('data-cmd') || btn.innerText;
                if (label && label.trim().length > 0) elements.push(\`[Editor Btn] \${label.trim().replace(/\\n/g,' ')}\`);
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
        const responseText = "Editor Platform: " + platform + "\\nCapabilities Supported Here: " + capabilities.join(', ') + "\\nStrategy: " + info + (uniqueElements.length > 0 ? "\\nAvailable Document Editing Toolbar Buttons:\\n" + uniqueElements.slice(0, 25).join('\\n') : "");
        return { ok: true, text: responseText };
      }
    });
    return res?.result || { ok: false, text: "Failed to run analyze_editor script." };
  } catch (e) {
    return { ok: false, text: "Error: " + e.message };
  }
}
`;

// Insert the function just before `async function scriptEditorFormat`
if (!content.includes("scriptAnalyzeEditor")) {
  content = content.replace(
    "async function scriptEditorFormat",
    analyzeFunc + "\\nasync function scriptEditorFormat",
  );
}

// 2. Add action router in message listener
const analyzeRouter =
  "} else if (action === 'analyze_editor' && tabId) {\\n" +
  "    const res = await scriptAnalyzeEditor(tabId);\\n" +
  "    feedback = res.ok ? 'הניתוח הושלם בהצלחה:\\n' + res.text : 'שגיאה בניתוח העורך:' + res.text;\\n";

if (!content.includes("action === 'analyze_editor'")) {
  content = content.replace(
    "} else if (action === 'editor_format' && tabId && p.command) {",
    analyzeRouter +
      "  } else if (action === 'editor_format' && tabId && p.command) {",
  );
}

// 3. Update the prompt to include analyze_editor
const promptAddition =
  "\\n| analyze_editor | {} - מנתח את אתר העריכה (WordPress/Notion/Docs) ומחזיר המלצות לפעולה ורשימת כפתורי עריכה קיימים בסרגל (Toolbar) |";
if (!content.includes("| analyze_editor |")) {
  content = content.replace(
    /\\| editor_format \\|/,
    promptAddition.trim() + "\\n  | editor_format |",
  );
}

fs.writeFileSync(filePath, content, "utf8");
console.log("Update complete.");
