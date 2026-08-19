// ==UserScript==
// @name         Shadertoy Custom Textures
// @namespace    https://studiogusto.com
// @version      1.3.0
// @description  Adds a "Custom" tab to the Shadertoy input picker: load any image URL into the clicked iChannel, record it as a comment plus a #define with the texture size and a fitAspect() helper, restore everything on reload, and keep the custom input out of the save payload so Cloudflare does not block it.
// @author       Fabio
// @match        https://www.shadertoy.com/*
// @match        https://shadertoy.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* global gShaderToy, overlay */

(function () {
    'use strict';

    const LS_SAMPLER = 'sgCustomTextureSampler';
    const LS_RECENT  = 'sgCustomTextureRecent';

    // // Custom texture iChannel0 url: https://...
    const COMMENT_RE = /^[ \t]*\/\/[ \t]*Custom texture iChannel([0-3])[ \t]+url:[ \t]*(\S+)[ \t]*$/;
    // #define ICHANNEL0_SIZE vec2(1024.0, 512.0)
    const DEFINE_RE  = /^[ \t]*#define[ \t]+ICHANNEL([0-3])_SIZE[ \t]+vec2\([ \t]*([0-9.]+)[ \t]*,[ \t]*([0-9.]+)[ \t]*\)[ \t]*$/;

    // The helper is emitted as one managed block delimited by these markers. The
    // #ifndef guard keeps it harmless if the same block also lives in Common,
    // which Shadertoy concatenates into every pass.
    const HELPER_START = '// --- Custom texture helper (managed by userscript) ---';
    const HELPER_END   = '// --- end Custom texture helper ---';
    const HELPER_BLOCK = [
        HELPER_START,
        '#ifndef FIT_ASPECT',
        '#define FIT_ASPECT',
        '// cover = true  -> riempie lo schermo, croppa (come background-size: cover)',
        '// cover = false -> ci sta tutta, letterbox (contain)',
        'vec2 fitAspect(vec2 uv, float texAspect, float viewAspect, bool cover) {',
        '    float a = viewAspect / texAspect;',
        '    vec2 s = cover ? vec2(min(a, 1.0), min(1.0 / a, 1.0))',
        '                   : vec2(max(a, 1.0), max(1.0 / a, 1.0));',
        '    return (uv - 0.5) * s + 0.5;',
        '}',
        '#endif',
        HELPER_END
    ];

    const DEFAULT_SAMPLER = {
        filter: 'mipmap',
        wrap: 'repeat',
        vflip: 'true',
        srgb: 'false',
        internal: 'byte',
        define: true,
        helper: true
    };

    function loadSampler() {
        try {
            return Object.assign({}, DEFAULT_SAMPLER, JSON.parse(localStorage.getItem(LS_SAMPLER) || '{}'));
        } catch (e) {
            return Object.assign({}, DEFAULT_SAMPLER);
        }
    }

    function saveSampler(s) {
        try { localStorage.setItem(LS_SAMPLER, JSON.stringify(s)); } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------- styles

    const css = `
    #divCustom .stcRow { margin: 6px 0; color: #c0c0c0; font-size: 13px; }
    #divCustom .stcRow label { display: inline-block; min-width: 70px; }
    #divCustom input.stcUrl {
        width: 70%; padding: 4px 6px; background: #202020; color: #e0e0e0;
        border: 1px solid #404040; font-family: inherit; font-size: 13px;
    }
    #divCustom select {
        background: #202020; color: #e0e0e0; border: 1px solid #404040;
        padding: 2px 4px; font-size: 12px; margin-right: 12px;
    }
    #divCustom label.stcCheck { min-width: 0; cursor: pointer; display: block; margin: 3px 0; }
    #divCustom button.stcBtn {
        margin-top: 10px; padding: 5px 14px; background: #303030; color: #e0e0e0;
        border: 1px solid #505050; cursor: pointer; font-size: 13px;
    }
    #divCustom button.stcBtn:hover { background: #404040; }
    #divCustom .stcHint { color: #808080; font-size: 11px; margin-top: 10px; line-height: 1.6; }
    #divCustom .stcHint code { color: #a0a0a0; }
    #divCustom .stcMsg { margin-top: 8px; font-size: 12px; min-height: 16px; }
    #divCustom .stcMsg.err  { color: #ff7070; }
    #divCustom .stcMsg.ok   { color: #70d070; }
    #divCustom .stcMsg.wait { color: #c0c0c0; }
    #divCustom .stcRecent a { color: #8ab4f8; cursor: pointer; display: block; font-size: 11px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    `;

    function injectStyles() {
        if (document.getElementById('stcStyles')) return;
        const el = document.createElement('style');
        el.id = 'stcStyles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // ------------------------------------------------------------ shader code

    function getEditor() {
        const st = window.gShaderToy;
        return st ? (st.mCodeEditor || null) : null;
    }

    function getCode() {
        const ed = getEditor();
        if (!ed) return null;
        if (typeof ed.getValue === 'function') return ed.getValue();             // CodeMirror
        if (ed.getSession && ed.getSession()) return ed.getSession().getValue(); // Ace
        return null;
    }

    function setCode(text) {
        const ed = getEditor();
        if (!ed) return false;
        if (typeof ed.setValue === 'function') {                                 // CodeMirror
            const cursor = typeof ed.getCursor === 'function' ? ed.getCursor() : null;
            const scroll = typeof ed.getScrollInfo === 'function' ? ed.getScrollInfo() : null;
            ed.setValue(text);
            if (cursor && typeof ed.setCursor === 'function') ed.setCursor(cursor);
            if (scroll && typeof ed.scrollTo === 'function') ed.scrollTo(scroll.left, scroll.top);
            return true;
        }
        if (ed.getSession && ed.getSession()) {                                  // Ace
            ed.getSession().setValue(text);
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------ header block

    // Read the managed header of the current pass: { 0: {url, w, h}, ... }
    function parseHeader(text) {
        const out = {};
        if (!text) return out;
        text.split('\n').forEach(function (line) {
            let m = line.match(COMMENT_RE);
            if (m) {
                const ch = parseInt(m[1], 10);
                out[ch] = out[ch] || {};
                out[ch].url = m[2];
                return;
            }
            m = line.match(DEFINE_RE);
            if (m) {
                const ch = parseInt(m[1], 10);
                out[ch] = out[ch] || {};
                out[ch].w = parseFloat(m[2]);
                out[ch].h = parseFloat(m[3]);
            }
        });
        return out;
    }

    function isManagedLine(line) {
        return COMMENT_RE.test(line) || DEFINE_RE.test(line);
    }

    // Pull the managed lines and the helper block out of the code. The helper is
    // returned verbatim so local edits to it survive a rewrite.
    function splitCode(text) {
        const lines = text.split('\n');
        let helper = null;
        const body = [];

        for (let i = 0; i < lines.length; i++) {
            if (!helper && lines[i].trim() === HELPER_START) {
                let end = -1;
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].trim() === HELPER_END) { end = j; break; }
                }
                if (end !== -1) {
                    helper = lines.slice(i, end + 1);
                    i = end;
                    continue;
                }
            }
            if (!isManagedLine(lines[i])) body.push(lines[i]);
        }

        while (body.length && body[0].trim() === '') body.shift();
        while (body.length && body[body.length - 1].trim() === '') body.pop();

        return { helper: helper, body: body };
    }

    function fmt(n) {
        return Number(n).toFixed(1);
    }

    // Rebuild the whole managed header from `entries`. `wantHelper` only decides
    // whether to *add* the helper; an existing one is always preserved.
    function writeHeader(entries, wantHelper) {
        const text = getCode();
        if (text === null) return false;

        const split = splitCode(text);

        const header = [];
        Object.keys(entries).map(Number).sort(function (a, b) { return a - b; }).forEach(function (ch) {
            const e = entries[ch];
            if (!e || !e.url) return;
            header.push('// Custom texture iChannel' + ch + ' url: ' + e.url);
            if (e.w && e.h) {
                header.push('#define ICHANNEL' + ch + '_SIZE vec2(' + fmt(e.w) + ', ' + fmt(e.h) + ')');
            }
        });
        if (!header.length) return false;

        const helper = split.helper || (wantHelper ? HELPER_BLOCK : null);

        const parts = [header.join('\n')];
        if (helper) parts.push(helper.join('\n'));
        if (split.body.length) parts.push(split.body.join('\n'));

        const next = parts.join('\n\n') + '\n';
        if (next === text) return true;      // already up to date
        return setCode(next);
    }

    function upsertEntry(channel, entry, wantHelper) {
        const entries = parseHeader(getCode());
        entries[channel] = Object.assign({}, entries[channel], entry);
        return writeHeader(entries, wantHelper);
    }

    // -------------------------------------------------------------- texture io

    function setTexture(channel, url, sampler) {
        window.gShaderToy.SetTexture(channel, {
            mSrc: url,
            mType: 'texture',
            mID: 1,
            mSampler: {
                filter: sampler.filter,
                wrap: sampler.wrap,
                vflip: sampler.vflip,
                srgb: sampler.srgb,
                internal: sampler.internal
            }
        });
    }

    // Measure the image off-screen. Tries CORS first (the same request the shader
    // needs), then falls back to a plain load, enough to read the dimensions.
    function measure(url) {
        function attempt(useCors) {
            return new Promise(function (resolve, reject) {
                const img = new Image();
                if (useCors) img.crossOrigin = 'anonymous';
                img.onload = function () {
                    if (img.naturalWidth && img.naturalHeight) {
                        resolve({ w: img.naturalWidth, h: img.naturalHeight });
                    } else {
                        reject(new Error('zero-sized image'));
                    }
                };
                img.onerror = function () { reject(new Error('could not load image')); };
                img.src = url;
            });
        }
        return attempt(true).catch(function () { return attempt(false); });
    }

    function recent() {
        try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); }
        catch (e) { return []; }
    }

    function pushRecent(url) {
        const list = recent().filter(function (u) { return u !== url; });
        list.unshift(url);
        try { localStorage.setItem(LS_RECENT, JSON.stringify(list.slice(0, 8))); }
        catch (e) { /* ignore */ }
    }

    // -------------------------------------------------------------- save guard

    // Saving with a custom texture bound makes Shadertoy POST an input whose
    // "filepath" is an absolute external URL:
    //
    //   "inputs":[{"channel":0,"type":"texture","id":1,
    //              "filepath":"https://example.com/tex.png", ...}]
    //
    // Cloudflare answers that POST with an interactive challenge page instead of
    // letting it through, so the save fails. The same URL inside the shader code
    // (our comment) goes through fine — it is that field that trips the WAF.
    //
    // We strip those inputs from the outgoing payload only. The page keeps the
    // texture bound, and reopening the shader restores it from the comment.

    function isExternalInput(input) {
        return input
            && typeof input.filepath === 'string'
            && /^https?:\/\//i.test(input.filepath)
            && !/^https?:\/\/([a-z0-9-]+\.)*shadertoy\.com\//i.test(input.filepath);
    }

    // Returns the rewritten JSON string, or null when nothing had to change.
    function stripExternalInputs(json) {
        let data;
        try { data = JSON.parse(json); } catch (e) { return null; }
        if (!data || !Array.isArray(data.renderpass)) return null;

        let removed = 0;
        data.renderpass.forEach(function (pass) {
            if (!Array.isArray(pass.inputs)) return;
            const kept = pass.inputs.filter(function (i) { return !isExternalInput(i); });
            removed += pass.inputs.length - kept.length;
            pass.inputs = kept;
        });
        if (!removed) return null;

        console.log('[Custom Textures] removed ' + removed +
                    ' custom input(s) from the save payload (Cloudflare blocks external filepaths).');
        return JSON.stringify(data);
    }

    // Shadertoy posts the shader as the "u" field. Handles FormData,
    // URLSearchParams and raw urlencoded strings.
    function scrubBody(body) {
        if (body instanceof FormData || body instanceof URLSearchParams) {
            const u = body.get('u');
            if (typeof u === 'string') {
                const next = stripExternalInputs(u);
                if (next) body.set('u', next);
            }
            return body;
        }
        if (typeof body === 'string' && body.indexOf('u=') !== -1) {
            const params = new URLSearchParams(body);
            const u = params.get('u');
            if (typeof u === 'string') {
                const next = stripExternalInputs(u);
                if (next) {
                    params.set('u', next);
                    return params.toString();
                }
            }
        }
        return body;
    }

    function isSaveUrl(url) {
        return typeof url === 'string' && /(^|\/)shadertoy(\?|$)/.test(url.split('#')[0]);
    }

    function patchSave() {
        const openOrig = XMLHttpRequest.prototype.open;
        const sendOrig = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            this.__stcUrl = url;
            return openOrig.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function (body) {
            if (isSaveUrl(this.__stcUrl)) {
                try { body = scrubBody(body); }
                catch (e) { console.warn('[Custom Textures] could not scrub the save payload:', e); }
            }
            return sendOrig.call(this, body);
        };

        const fetchOrig = window.fetch;
        if (typeof fetchOrig === 'function') {
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : (input && input.url);
                if (isSaveUrl(url) && init && init.body) {
                    try { init = Object.assign({}, init, { body: scrubBody(init.body) }); }
                    catch (e) { console.warn('[Custom Textures] could not scrub the save payload:', e); }
                }
                return fetchOrig.call(this, input, init);
            };
        }
    }

    // --------------------------------------------------------------- dialog ui

    // "Select input for iChannel0" -> 0
    function channelOf(dialog) {
        const title = dialog.querySelector('.dialogTitle');
        const m = title && title.textContent.match(/iChannel\s*([0-3])/i);
        return m ? parseInt(m[1], 10) : null;
    }

    // "pickTexture_image" -> "image" (the pass id overlay() expects)
    function passOf(dialog) {
        return dialog.id.replace(/^pickTexture_/, '');
    }

    function showCustomTab(dialog) {
        dialog.querySelectorAll('.tabcontent').forEach(function (el) { el.style.display = 'none'; });
        dialog.querySelectorAll('.tab_container li').forEach(function (li) { li.classList.remove('active'); });
        dialog.querySelector('#divCustom').style.display = 'block';
        dialog.querySelector('#liCustom').classList.add('active');
        const input = dialog.querySelector('.stcUrl');
        input.focus();
        input.select();
    }

    function buildPanel(dialog) {
        const sampler = loadSampler();

        const panel = document.createElement('div');
        panel.className = 'tabcontent';
        panel.id = 'divCustom';
        panel.style.display = 'none';
        panel.innerHTML = `
            <div class="stcRow">
                <label for="stcUrlInput">Image URL</label>
                <input type="text" id="stcUrlInput" class="stcUrl" placeholder="https://example.com/texture.jpg" spellcheck="false">
            </div>
            <div class="stcRow">
                <label>Filter</label>
                <select class="stcFilter">
                    <option value="mipmap">mipmap</option>
                    <option value="linear">linear</option>
                    <option value="nearest">nearest</option>
                </select>
                <label>Wrap</label>
                <select class="stcWrap">
                    <option value="repeat">repeat</option>
                    <option value="clamp">clamp</option>
                </select>
                <label>VFlip</label>
                <select class="stcVflip">
                    <option value="true">true</option>
                    <option value="false">false</option>
                </select>
                <label>sRGB</label>
                <select class="stcSrgb">
                    <option value="false">false</option>
                    <option value="true">true</option>
                </select>
            </div>
            <div class="stcRow">
                <label class="stcCheck"><input type="checkbox" class="stcDefine"> add <code>#define ICHANNELn_SIZE</code> with the measured resolution</label>
                <label class="stcCheck"><input type="checkbox" class="stcHelper"> add the <code>fitAspect()</code> helper</label>
            </div>
            <div class="stcRow">
                <button class="stcBtn" type="button">Set texture</button>
            </div>
            <div class="stcMsg"></div>
            <div class="stcRow stcRecent"></div>
            <div class="stcHint">
                The URL must be served with CORS enabled, otherwise WebGL refuses the image.<br>
                A comment <code>// Custom texture iChannelN url: ...</code> is written at the top of the
                current pass and re-applied automatically when the shader is opened again.<br>
                The size is emitted as <code>#define ICHANNEL0_SIZE vec2(w, h)</code> — a compile-time constant,
                unlike the built-in <code>iChannelResolution[0]</code>.<br>
                <code>fitAspect(uv, ICHANNEL0_SIZE.x / ICHANNEL0_SIZE.y, iResolution.x / iResolution.y, true)</code>
                maps the texture cover/contain without stretching. The helper is added once per pass, guarded by
                <code>#ifndef FIT_ASPECT</code>, and your edits inside its markers are preserved.<br>
                Recompile (Alt+Enter) after the header is inserted.
            </div>
        `;

        panel.querySelector('.stcFilter').value = sampler.filter;
        panel.querySelector('.stcWrap').value = sampler.wrap;
        panel.querySelector('.stcVflip').value = sampler.vflip;
        panel.querySelector('.stcSrgb').value = sampler.srgb;
        panel.querySelector('.stcDefine').checked = sampler.define !== false;
        panel.querySelector('.stcHelper').checked = sampler.helper !== false;

        const msg = panel.querySelector('.stcMsg');
        const input = panel.querySelector('.stcUrl');
        const button = panel.querySelector('.stcBtn');

        function say(text, kind) {
            msg.textContent = text;
            msg.className = 'stcMsg' + (kind ? ' ' + kind : '');
        }

        function apply() {
            const url = input.value.trim();
            if (!/^https?:\/\//i.test(url)) {
                say('Enter an absolute http(s) URL.', 'err');
                return;
            }
            const channel = channelOf(dialog);
            if (channel === null) {
                say('Could not tell which iChannel this dialog belongs to.', 'err');
                return;
            }

            const s = {
                filter: panel.querySelector('.stcFilter').value,
                wrap: panel.querySelector('.stcWrap').value,
                vflip: panel.querySelector('.stcVflip').value,
                srgb: panel.querySelector('.stcSrgb').value,
                internal: 'byte',
                define: panel.querySelector('.stcDefine').checked,
                helper: panel.querySelector('.stcHelper').checked
            };
            saveSampler(s);

            try {
                setTexture(channel, url, s);
            } catch (e) {
                say('SetTexture failed: ' + e.message, 'err');
                return;
            }

            pushRecent(url);

            if (!s.define) {
                if (!upsertEntry(channel, { url: url, w: null, h: null }, s.helper)) {
                    say('Texture set, but the editor header could not be written.', 'err');
                    return;
                }
                say('iChannel' + channel + ' set.', 'ok');
                close();
                return;
            }

            // Keep the dialog open until the size is known, so a failure stays visible.
            button.disabled = true;
            say('Measuring texture…', 'wait');
            measure(url).then(function (size) {
                const ok = upsertEntry(channel, { url: url, w: size.w, h: size.h }, s.helper);
                button.disabled = false;
                if (!ok) {
                    say('Texture set, but the editor header could not be written.', 'err');
                    return;
                }
                say('iChannel' + channel + ' set — ' + size.w + '×' + size.h + '.', 'ok');
                close();
            }).catch(function (e) {
                button.disabled = false;
                upsertEntry(channel, { url: url }, s.helper);
                say('Texture set, but the size could not be measured (' + e.message + '). ' +
                    'The comment was written without a #define.', 'err');
            });
        }

        function close() {
            if (typeof window.overlay === 'function') {
                try { window.overlay(null, passOf(dialog)); } catch (e) { /* ignore */ }
            }
        }

        button.addEventListener('click', apply);
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
            ev.stopPropagation();   // keep Shadertoy's global shortcuts out of the field
        });
        input.addEventListener('keypress', function (ev) { ev.stopPropagation(); });
        input.addEventListener('keyup', function (ev) { ev.stopPropagation(); });

        return panel;
    }

    function refreshRecent(dialog) {
        const box = dialog.querySelector('.stcRecent');
        const list = recent();
        box.innerHTML = '';
        if (!list.length) return;
        const title = document.createElement('div');
        title.textContent = 'Recent:';
        box.appendChild(title);
        list.forEach(function (url) {
            const a = document.createElement('a');
            a.textContent = url;
            a.title = url;
            a.addEventListener('click', function () { dialog.querySelector('.stcUrl').value = url; });
            box.appendChild(a);
        });
    }

    function enhance(dialog) {
        const tabs = dialog.querySelector('.tab_container');
        const body = dialog.querySelector('.dialogContentBody');
        if (!tabs || !body || dialog.querySelector('#liCustom')) return;

        const li = document.createElement('li');
        li.id = 'liCustom';
        li.style.display = 'inherit';
        li.innerHTML = '<a href="javascript:void(0)">Custom</a>';
        li.addEventListener('click', function (ev) {
            ev.preventDefault();
            showCustomTab(dialog);
        });
        tabs.appendChild(li);

        // Any built-in tab hides our panel again (openTab only knows its own divs).
        tabs.querySelectorAll('li').forEach(function (other) {
            if (other === li) return;
            other.addEventListener('click', function () {
                const panel = dialog.querySelector('#divCustom');
                if (panel) panel.style.display = 'none';
                li.classList.remove('active');
            });
        });

        body.appendChild(buildPanel(dialog));
    }

    function onDialogVisible(dialog) {
        enhance(dialog);
        refreshRecent(dialog);
        const input = dialog.querySelector('.stcUrl');
        const channel = channelOf(dialog);
        if (input && channel !== null) {
            const existing = parseHeader(getCode())[channel];
            if (existing && existing.url) input.value = existing.url;
        }
        const msg = dialog.querySelector('.stcMsg');
        if (msg) { msg.textContent = ''; msg.className = 'stcMsg'; }
    }

    function isVisible(el) {
        return el.style.display !== 'none' && el.style.visibility !== 'hidden';
    }

    function watchDialogs() {
        const seen = new WeakSet();

        function scan() {
            document.querySelectorAll('div[id^="pickTexture_"]').forEach(function (dialog) {
                if (!isVisible(dialog)) { seen.delete(dialog); return; }
                if (seen.has(dialog)) return;
                seen.add(dialog);
                onDialogVisible(dialog);
            });
        }

        new MutationObserver(scan).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });
        scan();
    }

    // ---------------------------------------------------- restore on page load

    function restoreFromHeader() {
        const entries = parseHeader(getCode());
        const channels = Object.keys(entries).filter(function (ch) { return entries[ch].url; });
        if (!channels.length) return;

        const sampler = loadSampler();
        channels.forEach(function (ch) {
            try { setTexture(parseInt(ch, 10), entries[ch].url, sampler); }
            catch (e) { console.warn('[Custom Textures] iChannel' + ch + ':', e); }
        });
        console.log('[Custom Textures] restored ' + channels.length + ' texture(s) from the shader header.');

        if (sampler.define === false) return;

        // Refresh the #define block only if a size is missing or stale, so opening a
        // shader does not mark it as edited for nothing. Never injects the helper here.
        Promise.all(channels.map(function (ch) {
            return measure(entries[ch].url)
                .then(function (size) { return { ch: ch, size: size }; })
                .catch(function () { return null; });
        })).then(function (results) {
            let changed = false;
            results.filter(Boolean).forEach(function (r) {
                const e = entries[r.ch];
                if (e.w !== r.size.w || e.h !== r.size.h) {
                    e.w = r.size.w;
                    e.h = r.size.h;
                    changed = true;
                }
            });
            if (changed) {
                writeHeader(entries, false);
                console.log('[Custom Textures] ICHANNELn_SIZE defines updated — recompile with Alt+Enter.');
            }
        });
    }

    function whenReady(cb) {
        let tries = 0;
        const t = setInterval(function () {
            if (window.gShaderToy && typeof window.gShaderToy.SetTexture === 'function' && getCode()) {
                clearInterval(t);
                cb();
            } else if (++tries > 100) {
                clearInterval(t);
            }
        }, 200);
    }

    injectStyles();
    patchSave();
    whenReady(function () {
        watchDialogs();
        restoreFromHeader();
    });
})();
