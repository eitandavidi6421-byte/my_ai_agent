window.chrome = {
    runtime: {
        lastError: null,
        sendMessage: function(msg, cb) {
            console.log("Mock sendMessage", msg);
            if (msg.action === 'list_conversations') {
                if (cb) cb({ conversations: [{ id: 'test_conv_1', title: 'שיחה לדוגמה' }] });
            } else if (msg.action === 'load_conversation_history') {
                if (cb) cb({
                    messages: [
                        { role: 'user', parts: [{ text: 'היי, תוכל לבדוק משהו?' }] },
                        { role: 'model', parts: [{ text: 'בטח, אני כאן לעזור!' }] }
                    ]
                });
            } else if (msg.action === 'new_conversation') {
                if (cb) cb({ id: 'new_test_conv' });
            } else if (msg.action === 'manager_prompt') {
                if (cb) setTimeout(() => cb({ text: 'קיבלתי את המשימה.', spawnedIds: ['worker_1'] }), 1000);
            }
        },
        onMessage: { addListener: function(cb) { window._mockOnMessage = cb; } }
    },
    storage: {
        local: {
            get: function(keys, cb) {
                console.log("Mock storage get", keys);
                setTimeout(() => {
                    if (cb) cb({
                        theme: 'light',
                        aiModel: 'gemini-1.5-pro',
                        activeWorkers: {
                            'worker_1': {
                                status: 'running',
                                task: 'מנתח את הבקשה...',
                                url: 'https://example.com',
                                logs: [{ action: 'open_url', message: 'Opening page', thought: 'I need to check the web' }]
                            }
                        }
                    });
                }, 100);
            },
            set: function(obj, cb) {
                console.log("Mock storage set", obj);
                if (cb) cb();
            }
        },
        onChanged: { addListener: function() {} }
    }
};
