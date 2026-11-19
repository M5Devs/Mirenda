/**
 * Vault manager: credential entries sealed client-side before they are synced.
 *
 * The plaintext exists only inside this function's scope. What reaches the
 * worker is `{ encryptedBlob, iv }`, and the key is never persisted.
 */
import { api, ApiError, type VaultItem } from '../lib/api.js';
import { open as openSealed, seal, type SealedPayload } from '../lib/crypto.js';
import type { Store } from '../lib/store.js';
import { el, icon } from './dom.js';
import { alertBox, openSheet, textField } from './sheet.js';

/** The decrypted credential shape. Extend with fields, never change the seal. */
export interface CredentialPayload {
  username: string;
  password: string;
  notes?: string;
}

export interface VaultSheetDeps {
  store: Store;
  /** The unlocked key, or `null` while locked. */
  key: () => CryptoKey | null;
  /** Ask the user to unlock; called when the vault is locked. */
  requestUnlock: () => void;
}

export function openVaultSheet(deps: VaultSheetDeps): void {
  const { store } = deps;
  const sheet = openSheet({ title: 'Vault', onClose: () => undefined });
  const body = sheet.body;

  const key = deps.key();
  if (!key) {
    const locked = el('p', { class: 'hint', text: 'The vault is locked. Unlock it with your master password to continue.' });
    const unlock = el('button', { class: 'button button--primary', type: 'button' });
    unlock.append(icon('unlock'), document.createTextNode('Unlock vault'));
    unlock.addEventListener('click', () => {
      sheet.close();
      deps.requestUnlock();
    });
    body.append(locked, unlock);
    return;
  }

  const profileId = store.get().activeProfileId;
  if (!profileId) {
    body.append(el('p', { class: 'empty', text: 'Select a profile first.' }));
    return;
  }
  // Narrowed once here so every closure below captures a non-null value.
  const scope: string = profileId;
  const vaultKey: CryptoKey = key;

  const errorSlot = el('div', { class: 'stack' });
  const list = el('ul', { class: 'list' });
  const status = el('p', { class: 'hint', text: '' });
  body.append(errorSlot, status, list);

  async function renderItems(): Promise<void> {
    list.replaceChildren();
    let items: VaultItem[] = [];
    try {
      items = await api.listVault(scope);
    } catch (error) {
      errorSlot.append(alertBox(error instanceof Error ? error.message : 'Could not load the vault.'));
      return;
    }

    if (items.length === 0) {
      list.append(el('li', { class: 'empty', text: 'No saved credentials yet.' }));
      return;
    }

    for (const item of items) {
      const row = el(
        'li',
        {},
        el(
          'div',
          { class: 'list__item' },
          el(
            'span',
            { class: 'list__main' },
            el('span', { class: 'list__title', text: item.domain }),
            el('span', { class: 'list__sub', text: item.itemType === 'credential' ? 'Credential' : 'Cookie snapshot' }),
          ),
        ),
      );

      const reveal = el('button', { class: 'button button--ghost', type: 'button', text: 'Reveal' });
      const detail = el('div', { class: 'list__sub', text: '' });
      let revealed = false;

      reveal.addEventListener('click', () => {
        void (async () => {
          if (revealed) {
            detail.textContent = '';
            reveal.textContent = 'Reveal';
            revealed = false;
            return;
          }
          try {
            const payload = await openSealed<CredentialPayload>(vaultKey, {
              encryptedBlob: item.encryptedBlob,
              iv: item.iv,
            });
            detail.textContent = `${payload.username} — ${maskPassword(payload.password)}`;
            reveal.textContent = 'Hide';
            revealed = true;
          } catch {
            // A GCM tag failure means the wrong key or tampered ciphertext.
            errorSlot.append(alertBox('Could not decrypt this item with the current key.'));
          }
        })();
      });

      const remove = el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Delete ${item.domain}` });
      remove.append(icon('close'));
      remove.addEventListener('click', () => {
        void (async () => {
          try {
            await api.deleteVaultItem(item.id, scope);
            await renderItems();
          } catch (error) {
            errorSlot.append(alertBox(error instanceof Error ? error.message : 'Could not delete the item.'));
          }
        })();
      });

      const actions = el('div', { class: 'row' }, reveal, remove);
      row.append(actions, detail);
      list.append(row);
    }
  }

  // ---- add a credential ---------------------------------------------------
  const domain = textField({ label: 'Site', placeholder: 'example.com', autocomplete: 'off' });
  const username = textField({ label: 'Username', placeholder: 'you@example.com', autocomplete: 'off' });
  const password = textField({ label: 'Password', type: 'password', autocomplete: 'new-password' });
  const save = el('button', { class: 'button button--primary', type: 'button' });
  save.append(icon('lock'), document.createTextNode('Seal & save'));

  save.addEventListener('click', () => {
    void (async () => {
      errorSlot.replaceChildren();
      const site = domain.input.value.trim().toLowerCase();
      if (site === '' || username.input.value === '' || password.input.value === '') {
        errorSlot.append(alertBox('Site, username and password are required.'));
        return;
      }
      save.disabled = true;
      status.textContent = 'Sealing on this device…';
      try {
        const payload: CredentialPayload = {
          username: username.input.value,
          password: password.input.value,
        };
        const sealed: SealedPayload = await seal(vaultKey, payload);
        await api.putVaultItem({
          profileId: scope,
          domain: site,
          itemType: 'credential',
          encryptedBlob: sealed.encryptedBlob,
          iv: sealed.iv,
        });
        // Clear the plaintext from the form as soon as it is sealed.
        username.input.value = '';
        password.input.value = '';
        domain.input.value = '';
        status.textContent = 'Saved. Only ciphertext left this device.';
        await renderItems();
      } catch (error) {
        errorSlot.append(
          alertBox(error instanceof ApiError ? error.message : 'Could not save the credential.'),
        );
        status.textContent = '';
      } finally {
        save.disabled = false;
      }
    })();
  });

  const form = el(
    'div',
    { class: 'stack' },
    el('p', { class: 'hint', text: 'Credentials are encrypted in this tab before sync. The server never sees the plaintext.' }),
    domain.wrapper,
    username.wrapper,
    password.wrapper,
    save,
  );

  body.append(form);
  void renderItems();
}

/** Show only the last two characters so a shoulder-surfer learns nothing. */
function maskPassword(value: string): string {
  if (value.length <= 2) return '••';
  return `${'•'.repeat(Math.min(value.length - 2, 10))}${value.slice(-2)}`;
}
