import pw from 'file:///C:/Users/MSI/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { webkit, devices } = pw;

const BASE = 'http://127.0.0.1:8000';
const UA = devices['iPhone 13'].userAgent;

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 390, height: 780 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    httpCredentials: { username: 'dade', password: '7954513.' },
});
const page = await context.newPage();
page.on('console', msg => { if (/ConnexHub/.test(msg.text())) console.log('[page]', msg.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.cxh-rewrite-bar')];
    return {
        url: location.href,
        viewport: innerWidth,
        ua: navigator.userAgent.slice(0, 70),
        chatExists: !!document.querySelector('#chat'),
        mesCount: document.querySelectorAll('#chat > .mes').length,
        cssLoaded: [...document.querySelectorAll('link[rel=stylesheet]')]
            .filter(l => /ConnexHub/.test(l.href))
            .map(l => {
                let rules = -1;
                try { rules = l.sheet?.cssRules?.length ?? -1; } catch (e) { rules = 'err:' + e.name; }
                return { href: l.href.split('/').slice(-2).join('/'), rules };
            }),
        barCount: bars.length,
    };
});
console.log('BASIC', JSON.stringify(info, null, 2));

await page.screenshot({ path: '.aitp-tmp/webkit-iphone.png' }).catch(() => {});
await browser.close();


