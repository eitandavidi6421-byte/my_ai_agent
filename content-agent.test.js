/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

// קריאת הקובץ המקורי
const codePath = path.join(__dirname, './content-agent.js');
const rawCode = fs.readFileSync(codePath, 'utf8');

// הגדרת משתני כרום מזויפים שהקוד מצפה למצוא בדפדפן
window.chrome = {
    runtime: {
        onMessage: { addListener: () => { } }
    }
};

// הרצת הקוד ישירות בתוך סביבת הדפדפן המדומה!
// בנוסף, אנחנו חושפים את פונקציות ה-DOMUtils החוצה כדי שנוכל לבדוק אותן.
eval(rawCode + '\nwindow.DOMUtils = typeof DOMUtils !== "undefined" ? DOMUtils : {};');

describe('Content Agent - DOMUtils', () => {

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    describe('isVisible', () => {
        it('should return false for elements with display: none', () => {
            const el = document.createElement('div');
            el.style.display = 'none';
            // דימוי של פונקציית המידות של הדפדפן
            el.getBoundingClientRect = () => ({ width: 0, height: 0 });
            document.body.appendChild(el);

            expect(window.DOMUtils.isVisible(el)).toBe(false);
        });

        it('should return false for elements with zero dimensions', () => {
            const el = document.createElement('button');
            el.getBoundingClientRect = () => ({ width: 0, height: 0 });
            document.body.appendChild(el);

            expect(window.DOMUtils.isVisible(el)).toBe(false);
        });

        it('should return true for visible elements', () => {
            const el = document.createElement('input');
            el.getBoundingClientRect = () => ({ width: 100, height: 20 });
            document.body.appendChild(el);

            expect(window.DOMUtils.isVisible(el)).toBe(true);
        });
    });
});