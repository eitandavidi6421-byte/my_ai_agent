const fs = require('fs');
const path = require('path');
const vm = require('vm');

// קריאת קובץ הרקע לתוך קונטקסט וירטואלי כדי לגשת לפונקציות ללא צורך ב-export
const codePath = path.join(__dirname, './background.js');
const code = fs.readFileSync(codePath, 'utf8');

// יצירת סביבה (Mock) ל-Chrome API כדי שהקוד ייטען בהצלחה ב-Node
const sandbox = {
    chrome: {
        alarms: { create: jest.fn(), onAlarm: { addListener: jest.fn() } },
        runtime: { onMessage: { addListener: jest.fn() } },
        action: { onClicked: { addListener: jest.fn() } },
        storage: { local: { get: jest.fn(), set: jest.fn() } },
        tabs: { create: jest.fn(), get: jest.fn(), update: jest.fn(), remove: jest.fn() },
        scripting: { executeScript: jest.fn() },
        identity: { getAuthToken: jest.fn() }
    },
    crypto: { randomUUID: () => 'test-uuid-1234' },
    setTimeout: setTimeout,
    console: console,
    fetch: jest.fn()
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

describe('Background Script - Pure Functions', () => {

    describe('isRefusal', () => {
        it('should identify English AI refusals', () => {
            expect(sandbox.isRefusal("I'm sorry, but I can't fulfill this request.")).toBe(true);
            expect(sandbox.isRefusal("I cannot provide this information.")).toBe(true);
        });

        it('should identify Hebrew AI refusals', () => {
            expect(sandbox.isRefusal("אני מצטער, אבל אינני יכול לעשות זאת.")).toBe(true);
            expect(sandbox.isRefusal("כמודל שפה, אין לי אפשרות לגלוש")).toBe(true);
        });

        it('should ignore normal conversational text', () => {
            expect(sandbox.isRefusal("I successfully completed the task.")).toBe(false);
            expect(sandbox.isRefusal("The response is ready.")).toBe(false);
            expect(sandbox.isRefusal("")).toBe(false);
        });
    });

    describe('parseJSON', () => {
        it('should parse valid raw JSON', () => {
            const data = sandbox.parseJSON('{"action": "test", "parameters": {"key": "val"}}');
            expect(data).toEqual({ action: 'test', parameters: { key: 'val' } });
        });

        it('should parse JSON wrapped in markdown tags', () => {
            const raw = '```json\n{"action": "done"}\n```';
            expect(sandbox.parseJSON(raw)).toEqual({ action: 'done' });
        });

        it('should extract JSON payload mixed with text using fallback regex', () => {
            const raw = 'Here is the requested payload:\n\n{"action": "extract", "parameters": {}}\n\nHope this helps!';
            expect(sandbox.parseJSON(raw)).toEqual({ action: 'extract', parameters: {} });
        });

        it('should return null for malformed JSON without brackets', () => {
            expect(sandbox.parseJSON('just standard text without json formatting')).toBeNull();
        });
    });

    describe('sanitizeHistory', () => {
        it('should merge consecutive messages from the same role', () => {
            const messages = [
                { role: 'user', parts: [{ text: 'First user message' }] },
                { role: 'user', parts: [{ text: 'Second user message' }] }
            ];
            const result = sandbox.sanitizeHistory(messages);
            expect(result).toHaveLength(1);
            expect(result[0].parts[0].text).toBe('First user message\\n\\nSecond user message');
        });

        it('should not merge messages from alternating roles', () => {
            const messages = [
                { role: 'user', parts: [{ text: 'Hello AI' }] },
                { role: 'model', parts: [{ text: '{"action":"done"}' }] }
            ];
            const result = sandbox.sanitizeHistory(messages);
            expect(result).toHaveLength(2);
            expect(result[1].role).toBe('model');
        });
    });
});