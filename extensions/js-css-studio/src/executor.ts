/**
 * Applying a snippet to the proxied page.
 *
 * JS runs in the page's own realm, because that is the point: the user is
 * extending a page they are already viewing. It is contained by the iframe's
 * sandbox — an opaque origin with no session, no cookie jar, and no path to
 * Mirenda's shell beyond the allowlisted RPC bridge.
 *
 * CSS is applied by appending a `<style>` element, tagged so it can be removed
 * again without disturbing the page's own styles.
 */
import type { StudioRule } from './rules.js';

/** Marker attribute on every injected style element. */
const STYLE_ATTR = 'data-mirenda-studio-style';

/** Result of one application, for the panel's status line. */
export interface ApplyResult {
  ruleId: string;
  ok: boolean;
  error?: string;
}

/** Apply a CSS rule. Returns the element so the caller can remove it. */
export function applyCss(rule: StudioRule): HTMLStyleElement {
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, rule.id);
  style.textContent = rule.code;
  document.head.append(style);
  return style;
}

/**
 * Run a JS rule.
 *
 * `new Function` is used rather than `eval` so the code is compiled in global
 * scope but does not inherit the caller's local bindings. Errors are captured
 * and returned rather than thrown: one broken snippet must not stop the others.
 */
export function applyJs(rule: StudioRule): ApplyResult {
  try {
    // The function body runs with `this === undefined`; the user's snippet is
    // written as statements, matching how devtools evaluates them.
    const fn = new Function(`"use strict";\n${rule.code}`);
    fn.call(undefined);
    return { ruleId: rule.id, ok: true };
  } catch (error) {
    return {
      ruleId: rule.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Apply one rule of either kind. */
export function applyRule(rule: StudioRule): ApplyResult {
  if (rule.kind === 'css') {
    try {
      applyCss(rule);
      return { ruleId: rule.id, ok: true };
    } catch (error) {
      return {
        ruleId: rule.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return applyJs(rule);
}

/** Apply every rule, collecting per-rule outcomes. */
export function applyRules(rules: readonly StudioRule[]): ApplyResult[] {
  return rules.map(applyRule);
}

/** Remove every style this extension injected. */
export function clearInjectedStyles(): void {
  for (const node of document.querySelectorAll(`style[${STYLE_ATTR}]`)) node.remove();
}

/** Remove the styles belonging to one rule. */
export function clearRuleStyles(ruleId: string): void {
  for (const node of document.querySelectorAll(`style[${STYLE_ATTR}="${CSS.escape(ruleId)}"]`)) node.remove();
}
