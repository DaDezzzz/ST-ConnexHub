import pw from 'file:///C:/Users/MSI/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { webkit, devices } = pw;

const BASE = 'http://127.0.0.1:8000';
const creds = { username: 'dade', password: '7954513.' };

// 以真实插件渲染的按钮条为准：截图里按钮条由插件自己插入。
// 这里不依赖插件状态（最后一条是否是 AI 回复），而是用真实 DOM 结构中
// 克隆出的 .mes，把「线上实际 CSS」下的按钮条几何量出来。
async function measure(label, options) {
    const browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({ httpCredentials: creds, ...options });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const out = await page.evaluate(() => {
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

        const r = bar.getBoundingClientRect();
        const mesR = probe.getBoundingClientRect();
        const buttons = [...bar.querySelectorAll('button')].map(b => b.getBoundingClientRect());
        const cs = getComputedStyle(bar);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        const res = {
            viewport: innerWidth,
            mode: getComputedStyle(probe).display,
            barW: Math.round(r.width),
            mesW: Math.round(mesR.width),
            fill: +(r.width / mesR.width).toFixed(3),
            leftGap: Math.round(r.left - mesR.left),
            rightGap: Math.round(mesR.right - r.right),
            // 判断按钮组是否居中：左右空隙差
            btnCenterSkew: Math.round(Math.abs((first.left - r.left) - (r.right - last.right))),
            justify: cs.justifyContent,
            btnSize: Math.round(first.height) + 'x' + Math.round(first.width),
            overflow: r.left < mesR.left - 1 || r.right > mesR.right + 1,
            inViewport: r.right <= innerWidth + 1,
        };
        probe.remove();
        return res;
    });

    await browser.close();
    return { label, ...out };
}

const results = [];
const ua = devices['iPhone 13'].userAgent;

results.push(await measure('desktop-1440', {
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
}));
results.push(await measure('iphone13-390', {
    userAgent: ua, viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
}));
results.push(await measure('iphoneSE-375', {
    userAgent: devices['iPhone SE'].userAgent, viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
}));
results.push(await measure('narrow-320', {
    userAgent: ua, viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
}));
results.push(await measure('iphone13-landscape-844', {
    userAgent: ua, viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
}));

console.log(JSON.stringify(results, null, 2));
