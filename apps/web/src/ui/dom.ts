/** Tiny DOM helpers. No virtual DOM: this UI is small and hot paths are direct. */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else if (name === 'text') node.textContent = String(value);
    else if (name === 'html') node.innerHTML = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Build an icon from the shared SVG sprite, sized by CSS. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [d, filled] of PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    if (filled) path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

export type IconName =
  | 'back'
  | 'forward'
  | 'reload'
  | 'go'
  | 'tabs'
  | 'profiles'
  | 'extensions'
  | 'plus'
  | 'close'
  | 'lock'
  | 'unlock'
  | 'shield'
  | 'ua'
  | 'bolt'
  | 'zen'
  | 'search'
  | 'trash';

type Path = readonly [string, boolean?];

const PATHS: Record<IconName, readonly Path[]> = {
  back: [['M15 5l-7 7 7 7']],
  forward: [['M9 5l7 7-7 7']],
  reload: [['M20 11a8 8 0 10-2.6 5.9'], ['M20 5v6h-6']],
  go: [['M5 12h13'], ['M12 6l6 6-6 6']],
  tabs: [
    ['M8 4h11a1 1 0 011 1v11a1 1 0 01-1 1h-2'],
    ['M4 8h11a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z'],
  ],
  profiles: [['M12 12a4 4 0 100-8 4 4 0 000 8z'], ['M4 21a8 8 0 0116 0']],
  extensions: [['M10 3h4v4h4v4h-4v10h-4V11H6V7h4z']],
  plus: [['M12 5v14'], ['M5 12h14']],
  close: [['M6 6l12 12'], ['M18 6L6 18']],
  lock: [['M7 11V8a5 5 0 0110 0v3'], ['M6 11h12v10H6z']],
  unlock: [['M7 11V8a5 5 0 019.6-2'], ['M6 11h12v10H6z']],
  shield: [['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z']],
  ua: [
    ['M3 5h18v11H3z'],
    ['M8 20h8'],
    ['M12 16v4'],
  ],
  bolt: [['M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z']],
  zen: [
    ['M4 9V5.5A1.5 1.5 0 015.5 4H9'],
    ['M15 4h3.5A1.5 1.5 0 0120 5.5V9'],
    ['M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15'],
    ['M9 20H5.5A1.5 1.5 0 014 18.5V15'],
  ],
  search: [['M11 4a7 7 0 100 14 7 7 0 000-14z'], ['M20 20l-4.2-4.2']],
  trash: [['M4 7h16'], ['M9 7V5h6v2'], ['M6 7l1 13h10l1-13']],
};
