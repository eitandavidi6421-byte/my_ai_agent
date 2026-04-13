const fs = require("fs");
const file = "c:/Users/IMOE001/Documents/הבינה המלכותית שלי/background.js";
let content = fs.readFileSync(file, "utf8");

// Replace literal "\n" strings that were mistakenly placed
content = content.replace(
  "\\nasync function scriptEditorFormat",
  "\nasync function scriptEditorFormat",
);

let analyzeRouterLiteral =
  "} else if (action === 'analyze_editor' && tabId) {\\n" +
  "    const res = await scriptAnalyzeEditor(tabId);\\n" +
  "    feedback = res.ok ? 'הניתוח הושלם בהצלחה:\\n' + res.text : 'שגיאה בניתוח העורך:' + res.text;\\n" +
  "  } else if (action === 'editor_format' && tabId && p.command) {";

let correctRouter =
  "} else if (action === 'analyze_editor' && tabId) {\n" +
  "    const res = await scriptAnalyzeEditor(tabId);\n" +
  "    feedback = res.ok ? 'הניתוח הושלם בהצלחה:\\n' + res.text : 'שגיאה בניתוח העורך:' + res.text;\n" +
  "  } else if (action === 'editor_format' && tabId && p.command) {";

content = content.replace(analyzeRouterLiteral, correctRouter);

fs.writeFileSync(file, content, "utf8");
console.log("Fixed");
