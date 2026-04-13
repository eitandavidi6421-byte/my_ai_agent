# 🤖 הבינה המלאכותית שלי — Swarm Extension v4.0

תוסף Chrome מתקדם המאפשר ניהול "נחיל" (Swarm) של סוכני AI הפועלים במקביל בדפדפן לביצוע משימות מורכבות כמו מחקר, כתיבה, ניתוח נתונים ואוטומציה.

---

## 📂 מבנה הפרויקט (Project Map)

| קובץ                    | תפקיד                                                                    | טכנולוגיה            |
| :---------------------- | :----------------------------------------------------------------------- | :------------------- |
| **`manifest.json`**     | הגדרות התוסף, הרשאות ונקודות כניסה.                                      | JSON                 |
| **`background.js`**     | **המוח המרכזי.** מנהל את ה-Orchestrator, ה-Storage, והלוגיקה של הסוכנים. | Service Worker (MV3) |
| **`dashboard.html/js`** | ממשק המשתמש הראשי (Gemini-style). ניהול שיחות וצפייה בסוכנים.            | HTML/JS/CSS          |
| **`content-agent.js`**  | הסקריפט שמוזרק לכל טאב ומאפשר לסוכן "לראות" וללחוץ על אלמנטים.           | Content Script       |
| **`popup.html/js`**     | ממשק צדדי (Side Panel) לגישה מהירה ופעולות בטאב הנוכחי.                  | Side Panel UI        |

---

## ⚙️ איך זה עובד? (The Flow)

1. **Manager Orchestrator:** המשתמש שולח הודעה ב-Dashboard. ה-Manager (ב-`background.js`) מנתח את המשימה ויוצר "תוכנית עבודה".
2. **Worker Spawning:** המנהל משגר סוכנים (`spawn_worker`) לטאבים חדשים ברקע.
3. **Agent Loop:** כל סוכן מריץ לולאה (`runSwarmWorkerLoop`) שבה הוא קורא את העמוד, מחליט על פעולה (לחיצה, הקלדה, גלילה) ומבצע אותה דרך `content-agent.js`.
4. **Final Report:** הסוכנים מדווחים חזרה למנהל, שמרכז את כל המידע לתשובה סופית אחת למשתמש.

---

## 🛠️ הנחיות ל-AI (Developer/AI Guide)

אם אתה AI שמנסה לתקן או לשפר את הקוד הזה, שים לב לנקודות הבאות:

- **Storage Mutex:** כל גישה ל-`chrome.storage.local` חייבת לעבור דרך `storageMutex.lock()` כדי למנוע דריסת נתונים בין סוכנים שפועלים במקביל.
- **READ_PAGE_FUNC:** זו הפונקציה הקריטית ביותר ב-`background.js`. היא אחראית על הפיכת ה-DOM לטקסט שה-AI יכול להבין. היא משתמשת ב-`data-ai-id` כדי לזהות אלמנטים.
- **Shadow DOM:** התוסף תומך ב-Shadow DOM דרך פונקציות רקורסיביות ב-`background.js` וב-`content-agent.js`.
- **Isolated Conversations:** כל שיחה מבודדת לפי `conversationId` בתוך `convHistory` ב-Storage.

---

## 🚀 איך להתקין?

1. פתח את `chrome://extensions/`.
2. הפעל **Developer Mode**.
3. לחץ על **Load unpacked** ובחר את התיקייה הזו.
