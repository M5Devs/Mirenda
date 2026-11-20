/**
 * Cookie-manager panel.
 *
 * Runs inside the proxied document (the sandboxed viewport) and reaches the
 * Virtual Cookie Jar through `mirenda.cookies`, which the shell brokers over the
 * RPC bridge. The panel therefore never sees Mirenda's session or the master
 * key, and HttpOnly cookies never arrive here at all — the worker filters them
 * out before the bridge answers.
 */
import type { MirendaApi, MirendaCookie } from '@mirenda/sdk';
import {
  buildExport,
  describeExpiry,
  maskValue,
  parseExport,
  sortForDisplay,
  validateCookieInput,
} from './logic.js';

const STYLE_ID = 'mirenda-cookie-manager-style';

/** The target domain of the document this panel is injected into. */
function targetDomain(): string {
  return window.location.hostname.toLowerCase();
}

/**
 * Build the panel DOM. Kept as plain elements so it inherits nothing from the
 * proxied page's own CSS: every rule is scoped under `.mcm-`.
 */
function createPanel(api: MirendaApi): HTMLElement {
  const domain = targetDomain();

  const root = document.createElement('div');
  root.className = 'mcm-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Cookie manager');

  const header = document.createElement('div');
  header.className = 'mcm-header';

  const title = document.createElement('div');
  title.className = 'mcm-title';
  title.textContent = `Cookies — ${domain}`;

  const closeButton = document.createElement('button');
  closeButton.className = 'mcm-icon';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '✕';
  header.append(title, closeButton);

  const list = document.createElement('div');
  list.className = 'mcm-list';

  const status = document.createElement('div');
  status.className = 'mcm-status';
  status.setAttribute('role', 'status');

  // ---- add / edit form ---------------------------------------------------
  const form = document.createElement('div');
  form.className = 'mcm-form';

  const nameInput = document.createElement('input');
  nameInput.className = 'mcm-input';
  nameInput.placeholder = 'name';
  nameInput.setAttribute('aria-label', 'Cookie name');
  nameInput.autocapitalize = 'off';
  nameInput.spellcheck = false;

  const valueInput = document.createElement('input');
  valueInput.className = 'mcm-input';
  valueInput.placeholder = 'value';
  valueInput.setAttribute('aria-label', 'Cookie value');
  valueInput.autocapitalize = 'off';
  valueInput.spellcheck = false;

  const pathInput = document.createElement('input');
  pathInput.className = 'mcm-input mcm-input--path';
  pathInput.placeholder = '/';
  pathInput.value = '/';
  pathInput.setAttribute('aria-label', 'Cookie path');

  const saveButton = document.createElement('button');
  saveButton.className = 'mcm-btn mcm-btn--primary';
  saveButton.type = 'button';
  saveButton.textContent = 'Save';

  form.append(nameInput, valueInput, pathInput, saveButton);

  // ---- export / import ---------------------------------------------------
  const actions = document.createElement('div');
  actions.className = 'mcm-actions';

  const exportButton = document.createElement('button');
  exportButton.className = 'mcm-btn';
  exportButton.type = 'button';
  exportButton.textContent = 'Export JSON';

  const importButton = document.createElement('button');
  importButton.className = 'mcm-btn';
  importButton.type = 'button';
  importButton.textContent = 'Import JSON';

  const importArea = document.createElement('textarea');
  importArea.className = 'mcm-textarea';
  importArea.placeholder = 'Paste a cookie export here, then tap Import';
  importArea.setAttribute('aria-label', 'Cookie import payload');
  importArea.hidden = true;

  const confirmImport = document.createElement('button');
  confirmImport.className = 'mcm-btn mcm-btn--primary';
  confirmImport.type = 'button';
  confirmImport.textContent = 'Import';
  confirmImport.hidden = true;

  actions.append(exportButton, importButton);
  form.append(actions, importArea, confirmImport);

  root.append(header, status, list, form);

  // ---- behaviour ---------------------------------------------------------

  const setStatus = (message: string, kind: 'ok' | 'error' = 'ok'): void => {
    status.textContent = message;
    status.className = `mcm-status mcm-status--${kind}`;
    if (message !== '') {
      window.setTimeout(() => {
        if (status.textContent === message) status.textContent = '';
      }, 4000);
    }
  };

  const render = (cookies: readonly MirendaCookie[]): void => {
    list.replaceChildren();
    if (cookies.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mcm-empty';
      empty.textContent = 'No cookies for this domain in this profile.';
      list.append(empty);
      return;
    }

    for (const cookie of sortForDisplay(cookies)) {
      const row = document.createElement('div');
      row.className = 'mcm-row';

      const main = document.createElement('div');
      main.className = 'mcm-row__main';

      const name = document.createElement('div');
      name.className = 'mcm-row__name';
      name.textContent = cookie.name;

      const meta = document.createElement('div');
      meta.className = 'mcm-row__meta';
      meta.textContent = `${maskValue(cookie.value)} · ${describeExpiry(cookie)}${
        cookie.secure ? ' · Secure' : ''
      }${cookie.sameSite ? ` · ${cookie.sameSite}` : ''}`;

      main.append(name, meta);

      const editButton = document.createElement('button');
      editButton.className = 'mcm-icon';
      editButton.type = 'button';
      editButton.setAttribute('aria-label', `Edit ${cookie.name}`);
      editButton.textContent = '✎';
      editButton.addEventListener('click', () => {
        nameInput.value = cookie.name;
        valueInput.value = cookie.value;
        pathInput.value = cookie.path;
        nameInput.focus();
      });

      const deleteButton = document.createElement('button');
      deleteButton.className = 'mcm-icon mcm-icon--danger';
      deleteButton.type = 'button';
      deleteButton.setAttribute('aria-label', `Delete ${cookie.name}`);
      deleteButton.textContent = '🗑';
      deleteButton.addEventListener('click', () => {
        void (async () => {
          try {
            await api.cookies.remove(domain, cookie.name);
            setStatus(`Deleted ${cookie.name}.`);
            await refresh();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'Delete failed.', 'error');
          }
        })();
      });

      row.append(main, editButton, deleteButton);
      list.append(row);
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      render(await api.cookies.list(domain));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not read cookies.', 'error');
    }
  };

  saveButton.addEventListener('click', () => {
    void (async () => {
      const problems = validateCookieInput({
        name: nameInput.value,
        value: valueInput.value,
        path: pathInput.value,
      });
      if (problems.length > 0) {
        setStatus(problems[0] ?? 'Invalid cookie.', 'error');
        return;
      }
      try {
        await api.cookies.set(domain, {
          name: nameInput.value.trim(),
          value: valueInput.value,
          path: pathInput.value.trim() === '' ? '/' : pathInput.value.trim(),
          secure: true,
        });
        nameInput.value = '';
        valueInput.value = '';
        setStatus('Cookie saved. It is sent on the next request.');
        await refresh();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Save failed.', 'error');
      }
    })();
  });

  exportButton.addEventListener('click', () => {
    void (async () => {
      try {
        const cookies = await api.cookies.list(domain);
        const payload = JSON.stringify(buildExport(domain, cookies), null, 2);
        // Clipboard access is often blocked in a sandboxed frame, so show the
        // JSON in the textarea as the reliable path and try to copy as a bonus.
        importArea.hidden = false;
        importArea.value = payload;
        importArea.select();
        try {
          await navigator.clipboard.writeText(payload);
          setStatus('Exported — copied to clipboard.');
        } catch {
          setStatus('Exported — copy the JSON below.');
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Export failed.', 'error');
      }
    })();
  });

  importButton.addEventListener('click', () => {
    importArea.hidden = false;
    confirmImport.hidden = false;
    importArea.focus();
  });

  confirmImport.addEventListener('click', () => {
    void (async () => {
      const parsed = parseExport(importArea.value);
      if (!parsed.ok) {
        setStatus(parsed.error, 'error');
        return;
      }
      try {
        // Import through the API one cookie at a time: the bridge exposes
        // per-cookie writes, and a partial failure is then reported per cookie.
        for (const cookie of parsed.export.cookies) {
          await api.cookies.set(domain, cookie);
        }
        setStatus(`Imported ${parsed.export.cookies.length} cookie(s).`);
        importArea.value = '';
        importArea.hidden = true;
        confirmImport.hidden = true;
        await refresh();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Import failed.', 'error');
      }
    })();
  });

  closeButton.addEventListener('click', () => {
    root.remove();
    document.getElementById(STYLE_ID)?.remove();
  });

  void refresh();
  return root;
}

/** Inject the stylesheet once. */
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.mcm-root{position:fixed;inset:auto 0 0 0;z-index:2147483000;max-height:78vh;display:flex;flex-direction:column;
  background:#11151c;color:#e8ecf3;border-radius:16px 16px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.55);
  font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:12px 14px 18px;overflow:auto}
.mcm-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.mcm-title{font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcm-icon{background:transparent;border:0;color:#9aa7bd;font-size:17px;padding:8px;border-radius:8px;cursor:pointer;min-width:40px;min-height:40px}
.mcm-icon--danger{color:#ff5c6c}
.mcm-list{display:flex;flex-direction:column;gap:6px;margin:6px 0 10px}
.mcm-row{display:flex;align-items:center;gap:4px;padding:8px 10px;background:#171d27;border-radius:10px}
.mcm-row__main{flex:1;min-width:0}
.mcm-row__name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcm-row__meta{color:#8494ad;font-size:11px;margin-top:2px}
.mcm-empty{color:#8494ad;font-size:13px;padding:12px 2px}
.mcm-form{display:flex;flex-direction:column;gap:8px;border-top:1px solid #232b38;padding-top:10px}
.mcm-input{background:#0c1016;border:1px solid #232b38;border-radius:9px;color:#e8ecf3;padding:10px 12px;font:inherit;min-height:42px}
.mcm-input--path{max-width:120px}
.mcm-textarea{background:#0c1016;border:1px solid #232b38;border-radius:9px;color:#e8ecf3;padding:10px;font:12px/1.4 ui-monospace,Menlo,monospace;min-height:120px;resize:vertical}
.mcm-actions{display:flex;gap:8px;flex-wrap:wrap}
.mcm-btn{flex:1;min-height:42px;border-radius:10px;border:1px solid #232b38;background:#1b2330;color:#e8ecf3;font:600 13px/1 inherit;cursor:pointer}
.mcm-btn--primary{background:#4f8cff;border-color:#4f8cff;color:#fff}
.mcm-status{font-size:12px;color:#35d399;min-height:16px}
.mcm-status--error{color:#ff5c6c}
`;
  document.head.append(style);
}

/** Open (or toggle) the panel. */
export function openCookieManager(api: MirendaApi): void {
  if (document.querySelector('.mcm-root')) {
    document.querySelector('.mcm-root')?.remove();
    document.getElementById(STYLE_ID)?.remove();
    return;
  }
  injectStyles();
  document.body.append(createPanel(api));
}
