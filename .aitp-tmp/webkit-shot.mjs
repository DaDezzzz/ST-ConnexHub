import pw from 'file:///C:/Users/MSI/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { webkit, devices } = pw;

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
    httpCredentials: { username: 'dade', password: '7954513.' },
    viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true,
    hasTouch: true, userAgent: devices['iPhone 13'].userAgent,
});
const page = await context.newPage();
await page.goto('http://127.0.0.1:8000', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
    const chat = document.querySelector('#chat');
    const sample = document.querySelector('#chat > .mes');
    if (!chat || !sample) return { error: 'no chat' };
    const probe = sample.cloneNode(true);
    probe.setAttribute('mesid', '99999');
    probe.querySelectorAll('.cxh-rewrite-bar').forEach(n => n.remove());
    const block = probe.querySelector('.mes_block') || probe;
    const bar = document.createElement('div');
    bar.className = 'cxh-rewrite-bar';
    bar.innerHTML = '<button type="button" class="menu_button menu_button_icon"><i class="fa-solid fa-pen-nib"></i></button>'
        + '<button type="button" class="menu_button menu_button_icon"><i class="fa-solid fa-clock-rotate-left"></i></button>'
        + '<span class="cxh-rewrite-sr-only"></span>';
    block.append(bar);
    chat.append(probe);
    probe.scrollIntoView({ block: 'center' });
    const r = probe.getBoundingClientRect();
    return { mesTop: Math.round(r.top), mesH: Math.round(r.height), mesW: Math.round(r.width) };
});

// 截取该消息区域
await page.screenshot({ path: '.aitp-tmp/iphone-bar.png', clip: { x: 0, y: Math.max(0, info.mesTop - 10), width: 390, height: Math.min(500, info.mesH + 40) } });
console.log(JSON.stringify(info));
await browser.close();
