import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// The extension lives in public/scripts/extensions/third-party/ST-ConnexHub.
// Resolve imports against a virtual SillyTavern root instead of requiring a local checkout.
const ROOT = '/st/public';
const EXT = `${ROOT}/scripts/extensions/third-party/ST-ConnexHub`;
const files = ['index.js', 'diagnostics.js', 'diagnostics-panel.js', 'rewrite/controller.js',
    'rewrite/ui.js', 'rewrite/inplace-rewrite.js', 'rewrite/revisions.js',
    'rewrite/mvu-compat.js', 'rewrite/background-scheduler.js'];

test('relative imports resolve inside the SillyTavern public tree', () => {
    const problems = [];
    for (const file of files) {
        const source = readFileSync(file, 'utf8');
        const dir = posix.dirname(posix.join(EXT, file));
        for (const match of source.matchAll(/(?:from\s+|import\()'(\.[^']+)'/g)) {
            const target = posix.resolve(dir, match[1]);
            if (!target.startsWith(`${ROOT}/`)) problems.push(`${file} -> ${match[1]} escapes public/`);
        }
    }
    assert.deepEqual(problems, []);
});

test('extension files reach SillyTavern core at the documented depth', () => {
    const expectations = [
        ['index.js', '../../../extensions.js', `${ROOT}/scripts/extensions.js`],
        ['index.js', '../../../../script.js', `${ROOT}/script.js`],
        ['rewrite/controller.js', '../../../../extensions.js', `${ROOT}/scripts/extensions.js`],
        ['rewrite/controller.js', '../../../../../script.js', `${ROOT}/script.js`],
        ['rewrite/controller.js', '../../../regex/engine.js', `${ROOT}/scripts/extensions/regex/engine.js`],
        ['rewrite/inplace-rewrite.js', '../../../../constants.js', `${ROOT}/scripts/constants.js`],
        ['rewrite/mvu-compat.js', '../../../../extensions.js', `${ROOT}/scripts/extensions.js`],
        ['rewrite/revisions.js', '../../../../../script.js', `${ROOT}/script.js`],
    ];
    for (const [file, spec, expected] of expectations) {
        const actual = posix.resolve(posix.dirname(posix.join(EXT, file)), spec);
        assert.equal(actual, expected, `${file} -> ${spec}`);
    }
});

test('no legacy model routing or feedback library references remain', () => {
    const offenders = [];
    for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const token of ['model-routing.js', 'feedback-library', 'jQuery(enable)']) {
            if (source.includes(token)) offenders.push(`${file}: ${token}`);
        }
    }
    assert.deepEqual(offenders, []);
});
