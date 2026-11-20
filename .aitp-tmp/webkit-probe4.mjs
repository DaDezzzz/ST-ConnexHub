import pw from 'file:///C:/Users/MSI/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { webkit, devices } = pw;

const BASE = 'http://127.0.0.1:8000';
const creds = { username: 'dade', password: '7954513.' };

async function run(kind, options) {
    const browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({ httpCredentials: creds, ...options });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5500);

    const out = await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        const sample = document.querySelector('#chat > .mes');
        if (!chat || !sample) return { error: 'no chat' };

        // 找出注入 display:contents 的 style 元素，看它的归属特征
        const owners = [];
        for (const s of document.querySelectorAll('style')) {
            const txt = s.textContent || '';
            if (txt.includes('display: contents !important') && txt.includes('.mes_block')) {
                owners.push({
                    id: s.id || null,
                    cls: s.className || null,
                    attrs: [...s.attributes].map(a => a.name + '=' + a.value).slice(0, 4),
                    head: txt.trim().slice(0, 160).replace(/\s+/g, ' '),
                });
            }
        }

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

        const measure = (label) => {
            const r = bar.getBoundingClientRect();
            const mesR = probe.getBoundingClientRect();
            const btn = bar.querySelector('button').getBoundingClientRect();
            return {
                label,
                barW: Math.round(r.width),
                mesW: Math.round(mesR.width),
                fill: +(r.width / mesR.width).toFixed(3),
                leftGap: Math.round(r.left - mesR.left),
                rightGap: Math.round(mesR.right - r.right),
                firstBtnCenterOffset: Math.round((btn.left + btn.right) / 2 - (r.left + r.right) / 2),
                overflow: r.right > mesR.right + 1 || r.left < mesR.left - 1,
            };
        };

        const before = measure('current');

        // 候选修复：grid item 全列跨越 + 拉伸；flex 容器下这两条无效但无害
        const st = document.createElement('style');
        st.textContent = '.cxh-rewrite-bar{grid-column:1/-1;justify-self:stretch;width:auto;}';
        document.head.append(st);
        const after = measure('grid-column-fix');
        st.remove();

        const mesCS = getComputedStyle(probe);
        const grid = {
            display: mesCS.display,
            cols: mesCS.gridTemplateColumns,
            rows: mesCS.gridTemplateRows,
        };
        const blockCS = getComputedStyle(block);
        const result = {
            viewport: innerWidth,
            mesGrid: grid,
            blockDisplay: blockCS.display,
            blockWidth: Math.round(block.getBoundingClientRect().width),
            owners,
            before,
            after,
        };
        probe.remove();
        return result;
    });

    await browser.close();
    return { kind, out };
}

const mobileUA = devices['iPhone 13'].userAgent;
const phone = await run('iphone13-390', {
    userAgent: mobileUA, viewport: { width: 390, height: 780 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
});
console.log(JSON.stringify(phone, null, 2));
