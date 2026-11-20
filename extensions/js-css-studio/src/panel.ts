/**
 * js-css-studio panel: a touch-friendly bottom sheet with a CodeMirror editor.
 *
 * CodeMirror 6 is MIT licensed. The editor is created lazily the first time the
 * sheet opens so its ~200 kB cost is not paid on every page load, and the sheet
 * is capped at 82vh so the proxied page stays partly visible — this is a
 * phone-first UI, and a full-screen editor would hide what you are editing.
 */
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { css as cssLang } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import type { MirendaApi } from '@mirenda/sdk';
import {
  BUILTIN_SNIPPETS,
  DEFAULT_SETTINGS,
  STORAGE_KEY_RULES,
  createRule,
  generateRuleId,
  parseRules,
  removeRule,
  upsertRule,
  validateRule,
  type StudioRule,
  type StudioSettings,
} from './rules.js';
import { applyRule, clearRuleStyles } from './executor.js';

const STYLE_ID = 'mirenda-studio-style';

/** DOM built once per open; CodeMirror views are disposed on close. */
export function openStudio(api: MirendaApi, currentUrl: string): void {
  const existing = document.querySelector('.mst-root');
  if (existing) {
    existing.remove();
    document.getElementById(STYLE_ID)?.remove();
    return;
  }

  injectStyles();

  const host = document.createElement('div');
  host.className = 'mst-root';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', 'JS & CSS Studio');

  const domain = safeHost(currentUrl);

  // ---- state -------------------------------------------------------------
  let rules: StudioRule[] = [];
  let settings: StudioSettings = { ...DEFAULT_SETTINGS };
  let editing: StudioRule | null = null;
  let view: EditorView | null = null;
  const languageCompartment = new Compartment();

  // ---- chrome ------------------------------------------------------------
  const header = document.createElement('div');
  header.className = 'mst-header';
  const title = document.createElement('div');
  title.className = 'mst-title';
  title.textContent = 'JS & CSS Studio';
  const closeButton = document.createElement('button');
  closeButton.className = 'mst-icon';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '✕';
  header.append(title, closeButton);

  const status = document.createElement('div');
  status.className = 'mst-status';
  status.setAttribute('role', 'status');

  const list = document.createElement('div');
  list.className = 'mst-list';

  // ---- editor form -------------------------------------------------------
  const form = document.createElement('div');
  form.className = 'mst-form';

  const nameInput = document.createElement('input');
  nameInput.className = 'mst-input';
  nameInput.placeholder = 'Snippet name';
  nameInput.setAttribute('aria-label', 'Snippet name');
  nameInput.autocapitalize = 'off';

  const kindSelect = document.createElement('select');
  kindSelect.className = 'mst-select';
  kindSelect.setAttribute('aria-label', 'Snippet type');
  for (const [value, label] of [
    ['js', 'JavaScript'],
    ['css', 'CSS'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    kindSelect.append(option);
  }

  const scopeSelect = document.createElement('select');
  scopeSelect.className = 'mst-select';
  scopeSelect.setAttribute('aria-label', 'Snippet scope');
  for (const [value, label] of [
    ['domain', `This site (${domain})`],
    ['global', 'All sites'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    scopeSelect.append(option);
  }

  const autoRunLabel = document.createElement('label');
  autoRunLabel.className = 'mst-check';
  const autoRunInput = document.createElement('input');
  autoRunInput.type = 'checkbox';
  autoRunLabel.append(autoRunInput, document.createTextNode(' Run on page load'));

  const editorHost = document.createElement('div');
  editorHost.className = 'mst-editor';

  const saveButton = document.createElement('button');
  saveButton.className = 'mst-btn mst-btn--primary';
  saveButton.type = 'button';
  saveButton.textContent = 'Save snippet';

  const cancelButton = document.createElement('button');
  cancelButton.className = 'mst-btn';
  cancelButton.type = 'button';
  cancelButton.textContent = 'New';

  const formRow = document.createElement('div');
  formRow.className = 'mst-row';
  formRow.append(kindSelect, scopeSelect);

  form.append(nameInput, formRow, autoRunLabel, editorHost, saveButton, cancelButton);

  // ---- built-in snippets -------------------------------------------------
  const builtinsTitle = document.createElement('div');
  builtinsTitle.className = 'mst-section-title';
  builtinsTitle.textContent = 'One-tap utilities';
  const builtins = document.createElement('div');
  builtins.className = 'mst-builtins';
  for (const snippet of BUILTIN_SNIPPETS) {
    const button = document.createElement('button');
    button.className = 'mst-builtin';
    button.type = 'button';
    button.textContent = snippet.label;
    button.title = snippet.description;
    button.addEventListener('click', () => {
      // Run immediately, then offer it as an editable draft. The user asked for
      // "1-tap", so the effect must be visible before any saving happens.
      const result = applyRule({
        id: snippet.id,
        name: snippet.label,
        kind: snippet.kind,
        code: snippet.code,
        scope: 'domain',
        domain,
        autoRun: false,
        enabled: true,
        updatedAt: new Date().toISOString(),
      });
      setStatus(result.ok ? `Applied "${snippet.label}".` : result.error ?? 'Failed.', result.ok ? 'ok' : 'error');
      loadIntoEditor({
        id: generateRuleId(),
        name: snippet.label,
        kind: snippet.kind,
        code: snippet.code,
        scope: 'domain',
        domain,
        autoRun: false,
        enabled: true,
        updatedAt: new Date().toISOString(),
      });
    });
    builtins.append(button);
  }

  host.append(header, status, builtinsTitle, builtins, list, form);
  document.body.append(host);

  // ---- helpers -----------------------------------------------------------
  function setStatus(message: string, kind: 'ok' | 'error' = 'ok'): void {
    status.textContent = message;
    status.className = `mst-status mst-status--${kind}`;
    if (message !== '') {
      window.setTimeout(() => {
        if (status.textContent === message) status.textContent = '';
      }, 4000);
    }
  }

  function loadIntoEditor(rule: StudioRule): void {
    editing = rule;
    nameInput.value = rule.name;
    kindSelect.value = rule.kind;
    scopeSelect.value = rule.scope;
    autoRunInput.checked = rule.autoRun;
    setEditorContent(rule.code, rule.kind);
    nameInput.focus();
  }

  function setEditorContent(code: string, kind: 'js' | 'css'): void {
    if (view) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        effects: languageCompartment.reconfigure(kind === 'css' ? cssLang() : javascript()),
      });
      return;
    }
    view = new EditorView({
      state: EditorState.create({
        doc: code,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          languageCompartment.of(kind === 'css' ? cssLang() : javascript()),
          oneDark,
          EditorView.lineWrapping,
        ],
      }),
      parent: editorHost,
    });
  }

  async function persist(): Promise<void> {
    await api.storage.set(STORAGE_KEY_RULES, rules);
  }

  function renderList(): void {
    list.replaceChildren();
    if (rules.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mst-empty';
      empty.textContent = 'No saved snippets yet.';
      list.append(empty);
      return;
    }

    for (const rule of rules) {
      const row = document.createElement('div');
      row.className = 'mst-row-item';

      const main = document.createElement('button');
      main.className = 'mst-row-main';
      main.type = 'button';
      main.append(
        Object.assign(document.createElement('span'), {
          className: 'mst-row-name',
          textContent: rule.name || '(unnamed)',
        }),
        Object.assign(document.createElement('span'), {
          className: 'mst-row-meta',
          textContent: `${rule.kind.toUpperCase()} · ${rule.scope === 'global' ? 'all sites' : rule.domain}${
            rule.autoRun ? ' · auto' : ''
          }`,
        }),
      );
      main.addEventListener('click', () => loadIntoEditor(rule));

      const runButton = document.createElement('button');
      runButton.className = 'mst-icon';
      runButton.type = 'button';
      runButton.setAttribute('aria-label', `Run ${rule.name}`);
      runButton.textContent = '▶';
      runButton.addEventListener('click', () => {
        // Re-running replaces the previous style for this rule.
        clearRuleStyles(rule.id);
        const result = applyRule(rule);
        setStatus(result.ok ? `Ran "${rule.name}".` : result.error ?? 'Failed.', result.ok ? 'ok' : 'error');
      });

      const deleteButton = document.createElement('button');
      deleteButton.className = 'mst-icon mst-icon--danger';
      deleteButton.type = 'button';
      deleteButton.setAttribute('aria-label', `Delete ${rule.name}`);
      deleteButton.textContent = '🗑';
      deleteButton.addEventListener('click', () => {
        void (async () => {
          rules = removeRule(rules, rule.id);
          clearRuleStyles(rule.id);
          await persist();
          renderList();
          setStatus(`Deleted "${rule.name}".`);
        })();
      });

      row.append(main, runButton, deleteButton);
      list.append(row);
    }
  }

  // ---- actions -----------------------------------------------------------
  saveButton.addEventListener('click', () => {
    void (async () => {
      const code = view?.state.doc.toString() ?? '';
      const draft = {
        name: nameInput.value,
        kind: kindSelect.value === 'css' ? ('css' as const) : ('js' as const),
        code,
        scope: scopeSelect.value === 'global' ? ('global' as const) : ('domain' as const),
        domain: scopeSelect.value === 'global' ? '' : domain,
      };
      const problems = validateRule(draft);
      if (problems.length > 0) {
        setStatus(problems[0] ?? 'Invalid snippet.', 'error');
        return;
      }
      const saved = createRule({
        id: editing?.id ?? generateRuleId(),
        name: draft.name,
        kind: draft.kind,
        code: draft.code,
        scope: draft.scope,
        domain: draft.domain,
      });
      saved.autoRun = autoRunInput.checked;
      saved.enabled = true;
      rules = upsertRule(rules, saved);
      editing = saved;
      try {
        await persist();
        renderList();
        setStatus(`Saved "${saved.name}".`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not save.', 'error');
      }
    })();
  });

  cancelButton.addEventListener('click', () => {
    loadIntoEditor({
      id: generateRuleId(),
      name: '',
      kind: 'js',
      code: '',
      scope: 'domain',
      domain,
      autoRun: false,
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    setStatus('');
  });

  closeButton.addEventListener('click', () => {
    view?.destroy();
    view = null;
    host.remove();
    document.getElementById(STYLE_ID)?.remove();
  });

  // ---- boot --------------------------------------------------------------
  void (async () => {
    try {
      rules = parseRules(await api.storage.get(STORAGE_KEY_RULES));
      const stored = await api.storage.get<StudioSettings>('settings');
      if (stored && typeof stored === 'object') settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch {
      // Storage is best-effort; the panel still works in-memory.
    }
    renderList();
    loadIntoEditor({
      id: generateRuleId(),
      name: '',
      kind: 'js',
      code: '',
      scope: 'domain',
      domain,
      autoRun: false,
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    void settings;
  })();
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return location.hostname.toLowerCase();
  }
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.mst-root{position:fixed;inset:auto 0 0 0;z-index:2147483000;max-height:82vh;display:flex;flex-direction:column;
  background:#0e1218;color:#e8ecf3;border-radius:16px 16px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.6);
  font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:12px 14px 18px;overflow:auto}
.mst-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.mst-title{font-weight:700;font-size:15px}
.mst-icon{background:transparent;border:0;color:#9aa7bd;font-size:17px;padding:8px;border-radius:8px;cursor:pointer;min-width:40px;min-height:40px}
.mst-icon--danger{color:#ff5c6c}
.mst-status{font-size:12px;color:#35d399;min-height:16px;margin-bottom:4px}
.mst-status--error{color:#ff5c6c}
.mst-section-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8494ad;margin:8px 0 6px}
.mst-builtins{display:grid;gap:6px;margin-bottom:10px}
.mst-builtin{min-height:42px;border-radius:10px;border:1px solid #232b38;background:#1b2330;color:#e8ecf3;font:600 13px/1.2 inherit;padding:8px 12px;text-align:left;cursor:pointer}
.mst-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.mst-row-item{display:flex;align-items:center;gap:2px;background:#171d27;border-radius:10px;padding:2px 4px}
.mst-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;background:transparent;border:0;color:inherit;text-align:left;padding:8px;cursor:pointer}
.mst-row-name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mst-row-meta{color:#8494ad;font-size:11px}
.mst-empty{color:#8494ad;font-size:13px;padding:8px 2px}
.mst-form{display:flex;flex-direction:column;gap:8px;border-top:1px solid #232b38;padding-top:10px}
.mst-input,.mst-select{background:#0a0e14;border:1px solid #232b38;border-radius:9px;color:#e8ecf3;padding:10px 12px;font:inherit;min-height:42px}
.mst-row{display:flex;gap:8px}
.mst-row>*{flex:1}
.mst-check{display:flex;align-items:center;gap:8px;font-size:13px;color:#b9c4d6;min-height:32px}
.mst-editor{border:1px solid #232b38;border-radius:10px;overflow:hidden;max-height:38vh}
.mst-editor .cm-editor{max-height:38vh;font-size:13px}
.mst-editor .cm-scroller{overflow:auto}
.mst-btn{min-height:44px;border-radius:10px;border:1px solid #232b38;background:#1b2330;color:#e8ecf3;font:600 13px/1 inherit;cursor:pointer}
.mst-btn--primary{background:#4f8cff;border-color:#4f8cff;color:#fff}
`;
  document.head.append(style);
}
