const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, './background.js'), 'utf8');

const logs = [];

const sandbox = {
    chrome: {
        storage: { 
            local: { 
                get: async () => ({ loggedInEmail: 'test@test.com', convHistory: {}, conversations: [{id: 'default', title: 'שיחה חדשה'}] }), 
                set: async () => {} 
            } 
        },
        runtime: { 
            onMessage: { addListener: () => {} },
            sendMessage: async (msg) => { logs.push("UI MSG: " + JSON.stringify(msg)); }
        },
        tabs: { create: (opts, cb) => { logs.push("TAB CREATED"); cb({id: 1}); }, executeScript: () => {}, remove: async () => {}, get: async () => ({url:'https://a.com'}), update: async () => {} },
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
        action: { onClicked: { addListener: () => {} } }
    },
    // Mock the external API
    callGeminiAPI: async (prompt, messages) => {
        logs.push("GEMINI CALLED WITH " + messages.length + " MESSAGES");
        return JSON.stringify({
            thought: "I will spawn a worker",
            action: "spawn_worker",
            parameters: { url: "https://example.com", task: "test" }
        });
    },
    parseJSON: (x) => JSON.parse(x),
    heartbeat: () => {},
    console: { log: (...args) => logs.push("LOG: " + args.join(' ')), error: (...args) => logs.push("ERR: " + args.join(' ')) },
    setTimeout: (cb) => cb(),
    isRefusal: () => false
};

const context = vm.createContext(sandbox);

// Provide a way to run orchestrator and track the response
vm.runInContext(`
    ${code}
    
    // We overwrite the callGeminiAPI with our mock that loops 
    // We will make it return spawn_worker on first call, wait_for_workers on second, done on third
    let callCount = 0;
    callGeminiAPI = async (prompt, messages) => {
        callCount++;
        const msgs = messages.map(m => m.parts[0].text);
        console.log("MESSAGES RECEIVED:", msgs[msgs.length-1]);
        if (callCount === 1) {
            return JSON.stringify({ action: "spawn_worker", parameters: { url: "https://a.com", task: "t" } });
        } else if (callCount === 2) {
            return JSON.stringify({ action: "wait_for_workers", parameters: {} });
        } else {
            return JSON.stringify({ action: "done", parameters: { text: "All done" } });
        }
    };

    runManagerOrchestrator("Hello", "default", (res) => {
        console.log("FINAL RESPONSE:", JSON.stringify(res));
    }).catch(e => console.error(e));
`, context);

setTimeout(() => {
    console.log(logs.join('\\n'));
}, 500);
