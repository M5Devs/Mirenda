/**
 * Login / Register / Unlock.
 *
 * The vault key is derived locally from the master password and the account's
 * public vault salt. The password itself is never stored, logged, or sent
 * anywhere except the auth endpoint that verifies it server-side.
 */
import { api, ApiError } from '../lib/api.js';
import { deriveMasterKey } from '../lib/crypto.js';
import type { Store } from '../lib/store.js';
import { alertBox, openSheet, textField } from './sheet.js';
import { el } from './dom.js';

/**
 * `unlock` re-derives the vault key for an existing session after a reload. It
 * never touches the network except to read the public salt.
 */
export type AuthMode = 'login' | 'register' | 'unlock';

export interface AuthResult {
  /** Derived AES-GCM vault key. Never leaves this module's caller. */
  vaultKey: CryptoKey;
  /** Salt the key was derived with. */
  vaultSalt: string;
}

export interface AuthOptions {
  store: Store;
  mode?: AuthMode;
  /** Fires once the session is established and the key is derived. */
  onAuthenticated: (result: AuthResult) => void;
}

export function openAuthSheet(options: AuthOptions): void {
  const { store } = options;
  let mode: AuthMode = options.mode ?? 'login';
  let busy = false;

  const sheet = openSheet({ title: 'Sign in to Mirenda', onClose: () => undefined });

  const email = textField({
    label: 'Email',
    type: 'email',
    placeholder: 'you@example.com',
    autocomplete: 'username',
    name: 'email',
  });
  const password = textField({
    label: 'Master password',
    type: 'password',
    placeholder: 'At least 10 characters',
    autocomplete: 'current-password',
    name: 'password',
  });

  const errorSlot = el('div', { class: 'stack' });
  const submit = el('button', { class: 'button button--primary', type: 'submit', text: 'Sign in' });

  const modeRow = el('div', { class: 'tabs-row' });
  const loginTab = el('button', { class: 'tabs-row__button', type: 'button', text: 'Sign in' });
  const registerTab = el('button', { class: 'tabs-row__button', type: 'button', text: 'Create account' });
  modeRow.append(loginTab, registerTab);

  const hint = el('p', {
    class: 'hint',
    text:
      'Your master password derives the vault key on this device with PBKDF2 (SHA-256, 310k) ' +
      'and AES-GCM. It is never sent to the server and cannot be recovered if lost.',
  });

  function setMode(next: AuthMode): void {
    mode = next;
    if (next === 'unlock') {
      modeRow.hidden = true;
      submit.textContent = 'Unlock vault';
      sheet.root.querySelector('.sheet__title')!.textContent = 'Unlock your vault';
      return;
    }
    modeRow.hidden = false;
    loginTab.className = `tabs-row__button${next === 'login' ? ' tabs-row__button--active' : ''}`;
    registerTab.className = `tabs-row__button${next === 'register' ? ' tabs-row__button--active' : ''}`;
    submit.textContent = next === 'login' ? 'Sign in' : 'Create account';
    password.input.setAttribute('autocomplete', next === 'login' ? 'current-password' : 'new-password');
    sheet.root.querySelector('.sheet__title')!.textContent =
      next === 'login' ? 'Sign in to Mirenda' : 'Create your Mirenda account';
  }

  loginTab.addEventListener('click', () => setMode('login'));
  registerTab.addEventListener('click', () => setMode('register'));

  const form = el(
    'form',
    { class: 'stack', novalidate: 'true' },
    modeRow,
    email.wrapper,
    password.wrapper,
    hint,
    errorSlot,
    submit,
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    void submitForm();
  });

  function idleLabel(): string {
    if (mode === 'login') return 'Sign in';
    if (mode === 'register') return 'Create account';
    return 'Unlock vault';
  }

  async function submitForm(): Promise<void> {
    const emailValue = email.input.value.trim();
    const passwordValue = password.input.value;
    errorSlot.replaceChildren();

    if (emailValue === '' || passwordValue === '') {
      errorSlot.append(alertBox('Email and master password are required.'));
      return;
    }
    if (mode === 'register' && passwordValue.length < 10) {
      errorSlot.append(alertBox('Choose a master password of at least 10 characters.'));
      return;
    }

    busy = true;
    submit.disabled = true;
    submit.textContent = mode === 'unlock' ? 'Unlocking…' : mode === 'login' ? 'Signing in…' : 'Creating…';
    store.set({ loading: true });

    try {
      if (mode === 'unlock') {
        const vaultSalt = await api.vaultSalt();
        const vaultKey = await deriveMasterKey(passwordValue, vaultSalt);
        sheet.close();
        options.onAuthenticated({ vaultKey, vaultSalt });
        return;
      }

      const response =
        mode === 'register'
          ? await api.register(emailValue, passwordValue)
          : await api.login(emailValue, passwordValue);

      const vaultKey = await deriveMasterKey(passwordValue, response.vaultSalt);
      sheet.close();
      options.onAuthenticated({ vaultKey, vaultSalt: response.vaultSalt });
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Something went wrong. Try again.';
      errorSlot.append(alertBox(message));
      busy = false;
      submit.disabled = false;
      submit.textContent = idleLabel();
    } finally {
      store.set({ loading: false });
    }
  }

  if (mode === 'unlock') {
    email.input.value = store.get().user?.email ?? '';
    email.wrapper.hidden = true;
  }

  setMode(mode);
  sheet.body.append(form);
}
