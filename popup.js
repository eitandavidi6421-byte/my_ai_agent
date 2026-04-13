const Sanitizer = {
  cleanHTML(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, "text/html");
    const allowedTags = new Set([
      "P",
      "BR",
      "B",
      "I",
      "STRONG",
      "EM",
      "UL",
      "OL",
      "LI",
      "A",
      "CODE",
      "PRE",
      "H1",
      "H2",
      "H3",
      "SPAN",
      "DIV",
      "DETAILS",
      "SUMMARY",
    ]);
    const allowedAttrs = new Set(["href", "title", "class", "target", "style"]);

    // In-place DOM mutation is significantly faster than rebuilding the tree
    const walker = document.createTreeWalker(
      doc.body,
      NodeFilter.SHOW_ELEMENT,
      null,
      false,
    );
    const nodesToRemove = [];

    let currentNode;
    while ((currentNode = walker.nextNode())) {
      const tagName = currentNode.tagName.toUpperCase();
      if (!allowedTags.has(tagName)) {
        nodesToRemove.push(currentNode);
        continue;
      }

      // Clean attributes efficiently
      const attrs = currentNode.attributes;
      for (let i = attrs.length - 1; i >= 0; i--) {
        const attr = attrs[i];
        const attrName = attr.name.toLowerCase();
        const cleanAttrVal = attr.value
          .replace(
            /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205f\u3000]/g,
            "",
          )
          .toLowerCase();
        if (
          !allowedAttrs.has(attrName) ||
          cleanAttrVal.startsWith("javascript:")
        ) {
          currentNode.removeAttribute(attrName);
        }
      }
    }

    // Replace invalid nodes with their children to preserve safe text/elements inside them
    for (let i = nodesToRemove.length - 1; i >= 0; i--) {
      const node = nodesToRemove[i];
      const parent = node.parentNode;
      if (!parent) continue;

      const fragment = document.createDocumentFragment();
      while (node.firstChild) {
        fragment.appendChild(node.firstChild);
      }
      parent.replaceChild(fragment, node);
    }

    // Move all sanitized children into a single fragment
    const fragment = document.createDocumentFragment();
    while (doc.body.firstChild) {
      fragment.appendChild(doc.body.firstChild);
    }
    return fragment;
  },
};

const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const chat = document.getElementById("chat");
const input = document.getElementById("input");

function showScreen(screen) {
  if (loginScreen) loginScreen.style.display = "none";
  if (appScreen) appScreen.style.display = "none";

  if (screen === "login" && loginScreen) loginScreen.style.display = "flex";
  if (screen === "app" && appScreen) appScreen.style.display = "flex";
}

// בדיקת סשן קיים בעת פתיחת הפאנל
async function checkSessionAndStart() {
  const { loggedInEmail } = await chrome.storage.local.get(["loggedInEmail"]);
  if (loggedInEmail) {
    chrome.runtime.sendMessage(
      { action: "login", interactive: false, expectedEmail: loggedInEmail },
      (response) => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.remove("loggedInEmail");
          showScreen("login");
          return;
        }
        if (response && response.token && response.user) {
          const profileUI = document.getElementById("user-profile-ui");
          const avatar = document.getElementById("user-avatar");
          const name = document.getElementById("user-name");
          if (profileUI) profileUI.style.display = "flex";
          if (avatar) avatar.src = response.user.picture || "";
          if (name) name.textContent = response.user.name || loggedInEmail;
          showScreen("app");
          loadChat();
        } else {
          chrome.storage.local.remove("loggedInEmail");
          showScreen("login");
        }
      },
    );
  } else {
    showScreen("login");
  }
}

window.addEventListener("load", () => {
  checkSessionAndStart();
});

// כפתור כניסה עם Google - מאמת אימייל ומשיג טוקן OAuth
const loginBtn = document.getElementById("login-btn");
if (loginBtn) {
  loginBtn.addEventListener("click", async () => {
    const emailInput = document.getElementById("email-input");
    const errorEl = document.getElementById("auth-error-msg");
    const email = emailInput ? emailInput.value.trim().toLowerCase() : "";

    if (!email || !email.includes("@")) {
      if (errorEl) {
        errorEl.style.display = "block";
        errorEl.textContent = "אנא הזן כתובת אימייל תקינה.";
      }
      return;
    }

    if (errorEl) errorEl.style.display = "none";
    loginBtn.disabled = true;
    loginBtn.textContent = "מתחבר...";

    chrome.runtime.sendMessage(
      { action: "login", interactive: true, expectedEmail: email },
      async (response) => {
        loginBtn.disabled = false;
        loginBtn.textContent = "כניסה עם Google";

        if (chrome.runtime.lastError || (response && response.error)) {
          const errMsg = response?.error || chrome.runtime.lastError.message;
          if (errorEl) {
            errorEl.style.display = "block";
            errorEl.textContent = "שגיאת חיבור: " + errMsg;
          }
          return;
        }

        if (response && response.token && response.user) {
          const actualEmail = (response.user.email || "").toLowerCase();
          if (actualEmail !== email) {
            if (errorEl) {
              errorEl.style.display = "block";
              errorEl.textContent = `האימייל שהוזן (${email}) לא תואם לחשבון Google שנבחר (${actualEmail}).`;
            }
            return;
          }

          // שמירת הסשן וכניסה ישירה לאפליקציה
          await chrome.storage.local.set({ loggedInEmail: actualEmail });

          const profileUI = document.getElementById("user-profile-ui");
          const avatar = document.getElementById("user-avatar");
          const name = document.getElementById("user-name");
          if (profileUI) profileUI.style.display = "flex";
          if (avatar) avatar.src = response.user.picture || "";
          if (name) name.textContent = response.user.name || actualEmail;

          showScreen("app");
          loadChat();
        } else {
          if (errorEl) {
            errorEl.style.display = "block";
            errorEl.textContent = "לא ניתן היה לאמת את החשבון. אנא נסה שוב.";
          }
        }
      },
    );
  });
}

const exportLogBtn = document.getElementById("export-log");
if (exportLogBtn) {
  exportLogBtn.addEventListener("click", async () => {
    try {
      const { chatHistory = [] } =
        await chrome.storage.local.get("chatHistory");
      if (chatHistory.length === 0) {
        alert("אין יומן שיחה קיים לייצוא.");
        return;
      }

      const logText = chatHistory
        .map((msg) => `[${msg.isUser ? "USER" : "AI"}]: ${msg.text}`)
        .join("\n\n-----------------\n\n");

      const blob = new Blob(["\uFEFF" + logText], {
        type: "text/plain;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-agent-log-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert("שגיאה בייצוא היומן.");
    }
  });
}

// --- ניהול שיחה עשירה (Markdown) ---
async function loadChat() {
  const { chatHistory = [] } = await chrome.storage.local.get("chatHistory");
  chat.textContent = "";

  // Use DocumentFragment to batch DOM insertions and prevent layout thrashing
  const fragment = document.createDocumentFragment();

  if (chatHistory.length === 0) {
    fragment.appendChild(
      createMessageElement("שלום! המערכת מחוברת. מה נרצה לעשות היום?", false),
    );
  } else {
    chatHistory.forEach((msg) => {
      fragment.appendChild(createMessageElement(msg.text, msg.isUser));
    });
  }

  // Yield to main thread for rendering
  requestAnimationFrame(() => {
    chat.appendChild(fragment);
    chat.scrollTop = chat.scrollHeight;
  });
}

async function saveChat() {
  const history = Array.from(chat.children)
    .filter((el) => !el.classList.contains("typing-indicator"))
    .map((el) => ({
      text: el.getAttribute("data-raw") || el.textContent, // שומרים את הטקסט המקורי
      isUser: el.classList.contains("user"),
    }));

  // Limit to the last 20 messages to heavily mitigate Storage QuotaExceeded errors
  const limitedHistory = history.slice(-20);
  await chrome.storage.local.set({ chatHistory: limitedHistory });
}

document.getElementById("clear-chat").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clear_history" }, () => {
    chat.textContent = "";
    addMessageUI("השיחה נוקתה. איך אפשר לעזור?", false);
  });
});

// Helper function to create the DOM element without appending it immediately
function createMessageElement(text, isUser = false) {
  const div = document.createElement("div");
  div.className = `message ${isUser ? "user" : "ai"}`;
  div.setAttribute("data-raw", text); // לשמירה בהיסטוריה

  if (text.includes("[PAUSE_FOR_HUMAN]")) {
    div.style.background = "linear-gradient(135deg, #f59e0b, #ea580c)";
    div.style.color = "#fff";
    text = text.replace("[PAUSE_FOR_HUMAN]", "👋 פעולה נדרשת:\n");
  }

  if (isUser || typeof marked === "undefined") {
    div.textContent = text;
  } else {
    // רנדור Markdown מאובטח לסוכן
    const rawHtml = marked.parse(text);
    const safeFragment = Sanitizer.cleanHTML(rawHtml);
    div.appendChild(safeFragment);

    // Optimize link targeting (getElementsByTagName is faster than querySelectorAll)
    const links = div.getElementsByTagName("a");
    for (let i = 0; i < links.length; i++) {
      links[i].target = "_blank";
      links[i].style.color = "#60a5fa";
    }
  }
  return div;
}

function addMessageUI(text, isUser = false, skipSave = false) {
  const div = createMessageElement(text, isUser);

  // Batch the DOM append and scroll into the next animation frame
  requestAnimationFrame(() => {
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    if (!skipSave) saveChat();
  });
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "message ai typing-indicator";
  div.id = "active-typing";
  const dot1 = document.createElement("div");
  dot1.className = "dot";
  const dot2 = document.createElement("div");
  dot2.className = "dot";
  const dot3 = document.createElement("div");
  dot3.className = "dot";
  div.append(dot1, dot2, dot3);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

// שליחת הבקשה ל-Background Service Worker תוך שימוש במזהה שיחה מבודד
function sendPrompt(text) {
  addMessageUI(text, true);
  showTyping();

  // שולחים את action כ-manager_prompt יחד עם מזהה ייחודי לפאנל!
  chrome.runtime.sendMessage(
    {
      action: "manager_prompt",
      text: text,
      conversationId: "side_panel_main",
    },
    (response) => {
      const typingEl = document.getElementById("active-typing");
      if (typingEl) typingEl.remove();

      if (chrome.runtime.lastError || response?.error) {
        const errMsg = response?.error || chrome.runtime.lastError.message;
        addMessageUI(`⚠️ שגיאה: ${errMsg}`, false);
        return;
      }

      if (response?.text) {
        addMessageUI(response.text, false);
      }

      // אם הסוכן ביקש לייצא CSV, נטפל בזה פה (בצד לקוח)
      if (response?.csvCmd) {
        const exportMatch = response.csvCmd.match(
          /\[EXPORT_CSV\]\s*(.+?)\s*\|\s*([\s\S]+?)(?=\n\[|$)/i,
        );
        if (exportMatch) {
          let filename = exportMatch[1].trim();
          if (!filename.endsWith(".csv")) filename += ".csv";
          const blob = new Blob(["\uFEFF" + exportMatch[2].trim()], {
            type: "text/csv;charset=utf-8;",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    },
  );
}

// אירועי שליחה
document.getElementById("send-btn").addEventListener("click", () => {
  if (input.value.trim()) {
    sendPrompt(input.value.trim());
    input.value = "";
  }
});
input.addEventListener("keypress", (e) => {
  if (e.key === "Enter" && input.value.trim()) {
    sendPrompt(input.value.trim());
    input.value = "";
  }
});

// כפתורים מהירים
document.querySelectorAll(".quick-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url || "";
    if (
      url.startsWith("chrome://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:")
    ) {
      addMessageUI(
        "⚠️ שגיאה: לא ניתן לבצע פעולות על דפי מערכת מוגבלים.",
        false,
        true,
      );
      return;
    }
    sendPrompt(btn.textContent);
  });
});

const openDashBtn = document.getElementById("open-dashboard-btn");
if (openDashBtn) {
  openDashBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
}
