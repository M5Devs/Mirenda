/** Bottom-sheet overlay primitive shared by every modal in the UI. */
import { el, icon } from './dom.js';

export interface SheetOptions {
  title: string;
  onClose: () => void;
  /** Extra classes for the sheet body. */
  bodyClass?: string;
}

export interface Sheet {
  root: HTMLDivElement;
  body: HTMLDivElement;
  close: () => void;
}

/**
 * Mount a bottom sheet. Tapping the scrim, pressing Escape, or calling
 * `close()` removes it. Focus is moved into the sheet for keyboard users and
 * restored on close.
 */
export function openSheet(options: SheetOptions): Sheet {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const body = el('div', { class: `sheet__body ${options.bodyClass ?? ''}` });
  const closeButton = el('button', {
    class: 'iconbtn',
    type: 'button',
    'aria-label': 'Close',
  });
  closeButton.append(icon('close'));

  const sheet = el(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
    el('div', { class: 'sheet__grabber', 'aria-hidden': 'true' }),
    el(
      'div',
      { class: 'sheet__header' },
      el('h2', { class: 'sheet__title', text: options.title }),
      closeButton,
    ),
    body,
  );

  const root = el('div', { class: 'overlay' }, sheet);

  const close = (): void => {
    root.remove();
    document.removeEventListener('keydown', onKeyDown);
    previouslyFocused?.focus?.();
    options.onClose();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) close();
  });
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', onKeyDown);

  document.body.append(root);
  // Focus the first control so a hardware keyboard works immediately.
  requestAnimationFrame(() => {
    const focusable = sheet.querySelector<HTMLElement>('input, button, [tabindex]');
    focusable?.focus();
  });

  return { root, body, close };
}

/** One labelled text input. */
export function textField(input: {
  label: string;
  type?: string;
  value?: string;
  placeholder?: string;
  autocomplete?: string;
  name?: string;
}): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const field = el('input', {
    class: 'input',
    type: input.type ?? 'text',
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {}),
    ...(input.autocomplete !== undefined ? { autocomplete: input.autocomplete } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
  });
  const wrapper = el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label', text: input.label }),
    field,
  );
  return { wrapper, input: field };
}

export function alertBox(message: string): HTMLDivElement {
  return el('div', { class: 'alert', role: 'alert', text: message });
}
