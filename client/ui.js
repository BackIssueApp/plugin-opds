// OPDS client UI — injects a "Connect a reader app" card into the core Profile
// page (the user's catalog URL) and a settings block with the progress-sync
// toggle. Reuses core CSS classes.
(function () {
  window.BackIssue.registerClient((api) => {
    // Settings — the dedicated Plugins tab when the core has it, falling back
    // to the Sources slot on older cores.
    const setSlot = api.slot('settings-plugin-panels') || api.slot('settings-plugin-sources');
    if (setSlot && !document.getElementById('set-opdsSaveProgress')) {
      const block = document.createElement('div');
      block.className = 'src-block';
      block.innerHTML =
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-opdsSaveProgress" type="checkbox" checked><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>OPDS progress sync</b><span class="modal__note src-toggle__note">Page streaming updates reading progress, so OPDS apps resume across devices and count as real reading.</span></div>' +
        '</div>' +
        '<div id="opds-config" class="src-config">' +
          '<p class="modal__note">Streaming a page from an OPDS app advances your resume point (never backwards); fetching the last page marks the issue read — the same record the built-in reader keeps. Whole-file downloads are unaffected (no progress channel exists for them). A client can opt out per-request with <code>?progress=0</code> on the stream URL.</p>' +
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
      '<p class="modal__subhead">Connect a reader app (OPDS)</p>' +
      '<p class="modal__note">Add this catalog to an OPDS-capable reader app to browse and stream your library there. Sign in with your BackIssue username and password.</p>' +
      '<div class="opds-url"><input id="opds-url" type="text" readonly spellcheck="false" value="' + api.escapeHtml(url) + '">' +
      '<button id="opds-copy" class="btn btn--ghost btn--sm" type="button">Copy</button></div>';
    slot.appendChild(card);
    const input = card.querySelector('#opds-url');
    input.onclick = () => input.select();
    card.querySelector('#opds-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(url); if (api.toast) api.toast('OPDS URL copied.', 'ok'); }
      catch { input.select(); try { document.execCommand('copy'); } catch { /* manual copy */ } }
    };
  });
})();
