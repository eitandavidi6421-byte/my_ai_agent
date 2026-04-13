const fs = require("fs");
let txt = fs.readFileSync(
  "c:/Users/IMOE001/Documents/הבינה המלכותית שלי/background.js",
  "utf8",
);
const startMatch = "const SYSTEM_PROMPT = `";
const startIdx = txt.indexOf(startMatch) + startMatch.length;
const endStr = "3. click_text עם שם הכפתור";
const endIdx = txt.indexOf(endStr, startIdx) + endStr.length;

let inside = txt.substring(startIdx, endIdx);
inside = inside.replace(/`/g, "\\`");

txt =
  txt.substring(0, startIdx) +
  inside +
  "\n`;\n// ═════════════════════════════\n" +
  txt.substring(txt.indexOf("function getWorkerPrompt()", endIdx));

fs.writeFileSync(
  "c:/Users/IMOE001/Documents/הבינה המלכותית שלי/background.js",
  txt,
  "utf8",
);
console.log("Fixed");
