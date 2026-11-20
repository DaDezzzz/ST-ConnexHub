import pw from 'file:///C:/Users/MSI/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { webkit, devices } = pw;

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
    userAgent: devices['iPhone 13'].userAgent,
    viewport: { width: 390, height: 780 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    httpCredentials: { username: 'dade', password: '7954513.' },
});
const page = await context.newPage();
await page.goto('http://127.0.0.1:8000', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const out = await page.evaluate(() => {
    const block = document.querySelector('#chat > .mes > .mes_block') || document.querySelector('.mes_block');
    if (!block) return { error: 'no mes_block' };
    const mes = block.closest('.mes');
    const rules = [];
    const walk = (items, media) => {
        for (const r of items) {
            if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules, r.conditionText); continue; }
            if (!r.selectorText) continue;
            let hit = false;
            try { hit = block.matches(r.selectorText); } catch (e) { hit = false; }
            if (hit) rules.push({ sheet: (r.parentStyleSheetHref || ''), media: media, sel: r.selectorText, style: r.style.cssText.slice(0, 200) });
        }
    };
    for (const sheet of document.styleSheets) {
        let list;
        try { list = sheet.cssRules; } catch (e) { continue; }
        const href = (sheet.href || 'inline').split('/').slice(-2).join('/');
        for (const r of list) {
            if (r.cssRules && r.conditionText !== undefined) {
                for (const inner of r.cssRules) {
                    if (!inner.selectorText) continue;
                    let hit = false;
                    try { hit = block.matches(inner.selectorText); } catch (e) { hit = false; }
                    if (hit) rules.push({ sheet: href, media: r.conditionText, sel: inner.selectorText, style: inner.style.cssText.slice(0, 200) });
                }
            } else if (r.selectorText) {
                let hit = false;
                try { hit = block.matches(r.selectorText); } catch (e) { hit = false; }
                if (hit) rules.push({ sheet: href, media: '', sel: r.selectorText, style: r.style.cssText.slice(0, 200) });
            }
        }
    }
    const bcs = getComputedStyle(block);
    const mcs = getComputedStyle(mes);
    return {
        blockDisplay: bcs.display,
        blockWidth: Math.round(block.getBoundingClientRect().width),
        mesDisplay: mcs.display,
        mesFlexWrap: mcs.flexWrap,
        mesWidth: Math.round(mes.getBoundingClientRect().width),
        matched: rules.length,
        displayRules: rules.filter(r => /display/.test(r.style)),
        wrapRules: rules.filter(r => /flex-wrap/.test(r.style)),
    };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
