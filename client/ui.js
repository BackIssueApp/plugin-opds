// OPDS client UI — injects a "Connect a reader app" card into the core Profile
// page, showing the user their OPDS catalog URL. Reuses core CSS classes.
(function () {
  window.BackIssue.registerClient((api) => {
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
