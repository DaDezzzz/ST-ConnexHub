export function createRewriteUI({ getSettings, getView, getConnections, getActiveConnection,
    defaultFeedback, onSettings, onAuto, onRewrite, onJump, onVersions, onMutation }) {
    let bar, observer, frame, clock, shown;
    let disposed = false;
    const refresh = () => {
        if (disposed || frame || document.hidden) return;
        frame = requestAnimationFrame(() => { frame = null; render(); });
    };
    const sync = () => {
        const settings = getSettings();
        const select = document.getElementById('cxh_rewrite_connection');
        if (select) {
            const current = select.value;
            select.replaceChildren(new Option('与首轮相同', ''),
                ...getConnections().map(conn => new Option(conn.name || '(未命名)', conn.id)));
            const saved = getConnections().some(conn => conn.id === settings.connectionId);
            select.value = saved ? settings.connectionId : '';
            if (!select.value && current && !settings.connectionId
                && getConnections().some(conn => conn.id === current)) select.value = current;
        }
        const model = document.getElementById('cxh_rewrite_model');
        if (model && document.activeElement !== model) model.value = settings.model;
        for (const [id, value] of [['cxh_rewrite_auto', settings.auto], ['cxh_rewrite_mvu', settings.mvu]]) {
            const input = document.getElementById(id);
            if (input) input.checked = value;
        }
        for (const [id, value, fallback] of [['cxh_rewrite_base', settings.baseFeedback, defaultFeedback],
            ['cxh_rewrite_feedback', settings.feedback, '']]) {
            const input = document.getElementById(id);
            if (input && document.activeElement !== input) input.value = value || fallback;
        }
        const status = document.getElementById('cxh_rewrite_status');
        if (status) status.textContent = getView().status;
        const hint = document.getElementById('cxh_rewrite_route_hint');
        if (hint) {
            const active = getActiveConnection();
            hint.textContent = active
                ? `首轮当前连接：${active.name || '(未命名)'} · ${settings.connectionId ? '重写使用独立连接' : '重写沿用首轮'}`
                : '首轮尚未选择连接，请先在上方选择并保存';
        }
    };
    function makeBar() {
        const root = document.createElement('div');
        root.className = 'cxh-rewrite-bar';
        root.innerHTML = `<button type="button" class="menu_button" data-rewrite><i class="fa-solid fa-pen-nib"></i> 重写正文</button>
            <button type="button" class="menu_button" data-jump><i class="fa-solid fa-clock-rotate-left"></i> <span>查看原稿</span></button>
            <label title="首轮完成后自动重写一次"><input type="checkbox" data-auto> 自动</label><span data-caption role="status"></span>`;
        root.querySelector('[data-rewrite]').addEventListener('click', () => onRewrite(shown?.reply));
        root.querySelector('[data-jump]').addEventListener('click', () => shown?.busy
            ? void onVersions() : onJump(shown?.reply, shown?.link?.target));
        root.querySelector('[data-auto]').addEventListener('change', event => onAuto(event.target.checked));
        return root;
    }
    function render() {
        if (disposed) return;
        const view = shown = getView();
        sync();
        const host = view.reply && document.querySelector(`#chat > .mes[mesid="${view.reply.index}"]`);
        if (bar?.parentElement && bar.parentElement !== host) bar.remove();
        if (!host) { clearInterval(clock); clock = null; return; }
        if (!bar) bar = makeBar();
        if (bar.parentElement !== host) host.append(bar);
        const rewrite = bar.querySelector('[data-rewrite]');
        rewrite.hidden = view.busy;
        rewrite.disabled = !view.idle || view.composerBusy;
        rewrite.title = view.blocker
            || (view.composerBusy ? '请先发送或清空输入框草稿与附件' : '按当前重写设置生成一个新版本');
        const jump = bar.querySelector('[data-jump]');
        jump.hidden = view.busy ? !view.canBrowse : !view.link;
        jump.disabled = !view.busy && !view.idle;
        jump.querySelector('span').textContent = view.busy ? '版本' : view.link?.label || '查看原稿';
        bar.querySelector('[data-auto]').checked = getSettings().auto;
        const caption = view.busy ? view.status
            : view.blocker || (view.link?.original ? '原稿' : view.link ? '重写稿' : '');
        bar.querySelector('[data-caption]').textContent = caption;
        if (view.busy && !clock) clock = setInterval(refresh, 1000);
        if (!view.busy && clock) { clearInterval(clock); clock = null; }
    }
    function install() {
        const chat = document.getElementById('chat');
        if (!observer && chat) {
            observer = new MutationObserver(() => { onMutation(); refresh(); });
            observer.observe(chat, { childList: true });
        }
        sync();
        refresh();
    }
    return {
        install, refresh, sync,
        dispose() {
            disposed = true;
            observer?.disconnect();
            if (frame) cancelAnimationFrame(frame);
            clearInterval(clock);
            bar?.remove();
        },
    };
}
