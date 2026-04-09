# 🏗️ ארכיטקטורת המערכת — "הבינה המלאכותית שלי"

מסמך זה נועד לספק הבנה עמוקה של זרימת הנתונים והלוגיקה הפנימית של התוסף עבור מפתחים ו-AI.

---

## 🔄 זרימת הודעה (Message Lifecycle)

1.  **קלט משתמש:** המשתמש מקליד הודעה ב-`dashboard.js`.
2.  **שליחה ל-Background:** ההודעה נשלחת דרך `chrome.runtime.sendMessage` עם הפעולה `manager_prompt`.
3.  **Orchestrator (המנהל):**
    *   `runManagerOrchestrator` ב-`background.js` מקבל את ההודעה.
    *   הוא טוען את היסטוריית השיחה המבודדת (`conversationId`).
    *   הוא שולח את ההודעה ל-LLM (Gemini) עם `SYSTEM_PROMPT` של מנהל.
4.  **שיגור סוכנים (Workers):**
    *   אם ה-LLM מחליט שצריך סוכנים, הוא מוציא פקודת `spawn_worker`.
    *   ה-Background פותח טאב חדש ומריץ את `runSwarmWorkerLoop`.
5.  **לולאת הסוכן (Agent Loop):**
    *   הסוכן מזריק את `content-agent.js` לטאב.
    *   הוא קורא את תוכן העמוד (`read_page`).
    *   הוא שולח את המידע ל-LLM עם `getWorkerPrompt`.
    *   הוא מבצע פעולות (לחיצה, הקלדה) עד שהוא מסיים (`done`).
6.  **דיווח סופי:** המנהל אוסף את הדיווחים מכל הסוכנים ומציג תשובה סופית למשתמש ב-Dashboard.

---

## 💾 ניהול זיכרון (Storage & State)

התוסף משתמש ב-`chrome.storage.local` לניהול כל המידע:

*   **`conversations`**: רשימת כל השיחות (מזהה, כותרת, תאריך).
*   **`convHistory`**: אובייקט שבו המפתח הוא `conversationId` והערך הוא מערך הודעות.
*   **`activeWorkers`**: אובייקט המכיל את כל הסוכנים הפעילים, הסטטוס שלהם והלוגים שלהם.
*   **`loggedInEmail`**: אימייל המשתמש המחובר (לצורך אימות).

---

## 🛡️ מנגנון ה-Mutex (נעילת זיכרון)

כדי למנוע מצב שבו שני סוכנים שפועלים במקביל מנסים לכתוב ל-Storage באותו זמן (מה שגורם לאובדן נתונים), הוטמע מנגנון `storageMutex`:

```javascript
await storageMutex.lock();
try {
    // קריאה וכתיבה ל-Storage
} finally {
    storageMutex.unlock();
}
```

---

## 🔍 זיהוי אלמנטים (DOM Interaction)

התוסף משתמש בשיטה ייחודית לזיהוי אלמנטים:
1.  **`READ_PAGE_FUNC`** סורק את ה-DOM (כולל Shadow DOM).
2.  הוא נותן לכל אלמנט אינטראקטיבי (כפתור, לינק, שדה טקסט) מזהה ייחודי: `data-ai-id="N"`.
3.  ה-AI מקבל רשימה של אלמנטים עם ה-IDs שלהם.
4.  כשה-AI רוצה ללחוץ על כפתור, הוא פשוט אומר: `interact_element({ id: 5 })`.
