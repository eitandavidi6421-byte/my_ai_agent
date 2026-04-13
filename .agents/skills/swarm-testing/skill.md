---
name: Swarm Extension Testing (Jest + VM)
description: >
  Load this skill when writing or debugging tests for the Chrome Extension (background.js or 
  content-scripts). Essential for: mock Chrome API setups, testing non-module scripts using 
  Node's VM module, handling JSON parsing logic, and validating AI refusal / sanitization 
  regexes without a full browser environment.
---

# Extension Testing – Jest & VM Skill

## The VM Sandbox Pattern

Because Chrome Extension background scripts often aren't ES modules and rely on global `chrome` APIs, we use Node's `vm` module to run the script in a custom context for testing.

### Setup (background.test.js)

```javascript
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "./background.js"), "utf8");

const sandbox = {
  chrome: {
    storage: { local: { get: jest.fn(), set: jest.fn() } },
    runtime: { onMessage: { addListener: jest.fn() } },
    tabs: { create: jest.fn(), executeScript: jest.fn() },
    // ... more mocks
  },
  crypto: { randomUUID: () => "test-id" },
  fetch: jest.fn(),
  console,
  setTimeout,
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);
```

---

## Testing Core Logic

Once loaded into the `sandbox`, we can test internal functions directly via `sandbox.functionName`.

### 1. AI Refusal Detection

```javascript
describe("isRefusal", () => {
  it("should catch Hebrew refusals", () => {
    expect(sandbox.isRefusal("כמודל שפה, איני יכול...")).toBe(true);
  });
});
```

### 2. Robust JSON Parsing

````javascript
describe("parseJSON", () => {
  it("should extract JSON from markdown blocks", () => {
    const raw = 'Sure! ```json\n{"action": "done"}\n```';
    expect(sandbox.parseJSON(raw)).toEqual({ action: "done" });
  });
});
````

---

## Mocking Chrome API Responses

When testing async functions (like `updDirect`), mock the `chrome.storage.local.get` return value.

```javascript
it("should update worker status atomically", async () => {
  sandbox.chrome.storage.local.get.mockImplementation((keys, cb) => {
    cb({ activeWorkers: { agent_1: { status: "running" } } });
  });

  await sandbox.updDirect("agent_1", { status: "done" });

  expect(sandbox.chrome.storage.local.set).toHaveBeenCalledWith(
    expect.objectContaining({
      activeWorkers: expect.objectContaining({
        agent_1: expect.objectContaining({ status: "done" }),
      }),
    }),
  );
});
```

---

## Best Practices

1. **Keep it Pure**: Extract complex logic into pure functions (no side effects) in `background.js` to make them easily testable in the sandbox.
2. **Global Cleanup**: If you add variables to the `sandbox`, ensure they don't persist between tests if they maintain state.
3. **Mock Fetch**: Always `jest.fn()` the `fetch` API to prevent actual network calls to Gemini during tests.
4. **Error Boundaries**: Test failing scenarios (invalid JSON, network 429/500) to ensure the `updDirect` status is correctly set to `'error'`.
5. **Coverage**: Focus on the Orchestrator loop logic and the message hub dispatching.
