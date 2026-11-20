import pw from 'file:///C:/Users/MSI/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { webkit, devices } = pw;

const BASE = 'http://127.0.0.1:8000';
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
    userAgent: devices['iPhone 13'].userAgent,
    viewport: { width: 390, height: 780 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    httpCredentials: { username: 'dade', password: '7954513.' },
});
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const result = await page.evaluate(() => {
    const chat = document.querySelector('#chat');
    const sample = document.querySelector('#chat > .mes');
    if (!chat || !sample) return { error: 'no chat/mes', chat: !!chat, mes: !!sample };

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

    const cs = getComputedStyle(bar);
    const bcs = getComputedStyle(block);
    const r = bar.getBoundingClientRect();
    const pr = block.getBoundingClientRect();
    const out = {
        viewport: innerWidth,
        block: { display: bcs.display, flexDir: bcs.flexDirection, width: Math.round(pr.width) },
        bar: {
            display: cs.display, flex: cs.flex, alignSelf: cs.alignSelf,
            width: cs.width, minWidth: cs.minWidth, maxWidth: cs.maxWidth,
            justify: cs.justifyContent, margin: cs.margin,
        },
        rect: { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) },
        parentW: Math.round(pr.width),
        fillRatio: +(r.width / pr.width).toFixed(3),
        leftGap: Math.round(r.left - pr.left),
        rightGap: Math.round(pr.right - r.right),
        mediaMatches: {
            coarse: matchMedia('(pointer: coarse)').matches,
            hoverNone: matchMedia('(hover: none)').matches,
            max600: matchMedia('(max-width: 600px)').matches,
        },
    };
    probe.remove();
    return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
