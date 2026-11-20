import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 移动端主题（黑夜与金等）会在 max-width:768px 把 .mes_block 改为 display:contents，
// 使它不再产生盒子。此时 .cxh-rewrite-bar 成为 .mes 网格的 item，
// 若缺少 grid-column / justify-self，会缩成单列宽并靠左（真机 Safari 复现）。
// 这里锁住这两条约束，防止以后被清理掉。
const css = readFileSync(new URL('../rewrite/ui.css', import.meta.url), 'utf8');

function ruleFor(selector) {
    const index = css.indexOf(selector + ' {');
    assert.notEqual(index, -1, `缺少规则：${selector}`);
    return css.slice(index, css.indexOf('}', index));
}

test('rewrite bar spans the full grid row when parent becomes display:contents', () => {
    const rule = ruleFor('.cxh-rewrite-bar');
    assert.match(rule, /grid-column:\s*1\s*\/\s*-1/, '需要 grid-column: 1 / -1 才能跨满 .mes 网格');
    assert.match(rule, /justify-self:\s*stretch/, '需要 justify-self: stretch 才能在网格项里撑满');
});

test('rewrite bar keeps a low-specificity base rule for flex parents', () => {
    const rule = ruleFor('.cxh-rewrite-bar');
    assert.match(rule, /display:\s*flex/, '桌面端 .mes_block 是 flex 容器，仍需 display: flex');
    assert.match(rule, /justify-content:\s*flex-end/, '桌面端按钮应右对齐');
});

test('touch media query centers the bar without overriding stretch', () => {
    const mobile = css.slice(css.indexOf('@media (pointer: coarse)'));
    const body = mobile.slice(mobile.indexOf('.cxh-rewrite-bar'), mobile.indexOf('}', mobile.indexOf('.cxh-rewrite-bar')));
    assert.match(body, /justify-content:\s*center/);
    assert.doesNotMatch(body, /width:\s*100%/, '避免再次引入在 flex/grid item 上不可靠的百分比宽度');
});
