// OPDS client UI — injects a "Connect a reader app" card into the core Profile
// page (the user's catalog URL) and a settings block with the progress-sync
// toggle. Reuses core CSS classes.
(function () {
  window.BackIssue.registerClient((api) => {
    // Translations: api.t when the host has it (BackIssue > 0.9.0), the inline
    // English otherwise. Catalog keys live under locales/<lang>.json.
    const NS = 'opds.';
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k]))) : String(s));
    const tr = (key, en, params) => { if (typeof api.t !== 'function') return fill(en, params); const v = api.t(NS + key, params); return v === NS + key ? fill(en, params) : v; };
    // innerHTML variant: params escaped, only simple inline tags pass through.
    const trh = (key, en, params) => {
      if (typeof api.th === 'function' && api.t(NS + key) !== NS + key) return api.th(NS + key, params);
      const tokens = params ? Object.fromEntries(Object.keys(params).map((k) => [k, '\u0000' + k + '\u0000'])) : undefined;
      let html = esc(fill(en, tokens)).replace(/&lt;(\/?)(b|i|em|strong|code|br|kbd)&gt;/g, '<$1$2>');
      if (params) for (const [k, v] of Object.entries(params)) html = html.split('\u0000' + k + '\u0000').join(esc(v ?? ''));
      return html;
    };
    const te = (key, en, params) => esc(tr(key, en, params));

    // Settings — the dedicated Plugins tab when the core has it, falling back
    // to the Sources slot on older cores.
    const setSlot = api.slot('settings-plugin-panels') || api.slot('settings-plugin-sources');
    if (setSlot && !document.getElementById('set-opdsSaveProgress')) {
      const block = document.createElement('div');
      block.className = 'src-block';
      block.innerHTML =
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-opdsSaveProgress" type="checkbox" checked><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>' + te('progressSyncTitle', 'OPDS progress sync') + '</b><span class="modal__note src-toggle__note">' + te('progressSyncIntro', 'Page streaming updates reading progress, so OPDS apps resume across devices and count as real reading.') + '</span></div>' +
        '</div>' +
        '<div id="opds-config" class="src-config">' +
          '<p class="modal__note">' + trh('progressSyncNote', 'Streaming a page from an OPDS app advances your resume point (never backwards); fetching the last page marks the issue read — the same record the built-in reader keeps. Whole-file downloads are unaffected (no progress channel exists for them). A client can opt out per-request with <code>?progress=0</code> on the stream URL.') + '</p>' +
        '</div>';
      setSlot.appendChild(block);
    }

    const slot = api.slot('profile-plugin-slot');
    if (!slot || slot.querySelector('#opds-profile')) return;
    const url = location.origin + '/api/opds';
    const card = document.createElement('section');
    card.className = 'settings-section';
    card.id = 'opds-profile';
    card.innerHTML =
      '<p class="modal__subhead">' + te('connectTitle', 'Connect a reader app (OPDS)') + '</p>' +
      '<p class="modal__note">' + te('connectNote', 'Add this catalog to an OPDS-capable reader app to browse and stream your library there. Sign in with your BackIssue username and password.') + '</p>' +
      '<div class="opds-url"><input id="opds-url" type="text" readonly spellcheck="false" value="' + api.escapeHtml(url) + '">' +
      '<button id="opds-copy" class="btn btn--ghost btn--sm" type="button">' + te('copy', 'Copy') + '</button></div>';
    slot.appendChild(card);
    const input = card.querySelector('#opds-url');
    input.onclick = () => input.select();
    // With password sign-in off, a reader app gets in with a personal API
    // key as the password instead. Only cores that accept that (0.9.2+)
    // advertise apiKeyBasic, so older ones keep the plain note.
    Promise.resolve(api.get?.('/api/auth/providers')).then((p) => {
      if (!p || p.passwordLogin !== false || !p.apiKeyBasic) return;
      card.querySelector('.modal__note').innerHTML = trh('connectNoteApiKey', 'Add this catalog to an OPDS-capable reader app to browse and stream your library there. Password sign-in is off on this server: sign in with your username and, as the password, a personal key from <b>API key</b> on this page.');
    }).catch(() => { /* keep the plain note */ });
    card.querySelector('#opds-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(url); if (api.toast) api.toast(tr('copied', 'OPDS URL copied.'), 'ok'); }
      catch { input.select(); try { document.execCommand('copy'); } catch { /* manual copy */ } }
    };
  });
})();
