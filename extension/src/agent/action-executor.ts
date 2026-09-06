/**
 * SIH 26171 — Phase 5: action executor (content script).
 *
 * Executes ONE action already resolved to CSS-pixel space (see App.tsx's use
 * of coords.ts's imagePointToCssPoint before EXECUTE_ACTION_REQUEST is ever
 * sent) against the live DOM. No coordinate math here — that already
 * happened before this module sees a point, same division of responsibility
 * as mask-overlay.ts.
 *
 * Scoped to ONE action per the roadmap: no loop, no retry, no
 * task_complete-driven continuation. This file's job ends the moment the
 * DOM has been acted on once.
 */
import type { ExecutableAction } from '../types';

export interface ExecutionResult {
  ok: boolean;
  detail?: string;
}

export function executeAction(action: ExecutableAction): ExecutionResult {
  switch (action.kind) {
    case 'click':
      return executeClick(action);
    case 'type':
      return executeType(action);
    case 'scroll':
      return executeScroll(action);
    case 'done':
      return { ok: true, detail: 'Planner marked the task complete; nothing to execute.' };
  }
}

function executeClick(action: ExecutableAction): ExecutionResult {
  if (!action.point) return { ok: false, detail: "click action is missing its target point." };

  const el = document.elementFromPoint(action.point.left, action.point.top);
  if (!el) {
    return {
      ok: false,
      detail: `No element found at (${action.point.left}, ${action.point.top}).`,
    };
  }

  (el as HTMLElement).click();
  return { ok: true, detail: `Clicked ${describeElement(el)}.` };
}

/**
 * Sets .value via the native property setter, not a plain assignment, then
 * dispatches input/change — a plain `el.value = x` does not notify a
 * React-controlled input's change handler (React wraps the native setter),
 * so a naive assignment would silently do nothing on a React form. Costs
 * nothing on a plain uncontrolled input either.
 */
function executeType(action: ExecutableAction): ExecutionResult {
  if (!action.text) return { ok: false, detail: 'type action is missing text.' };

  const active = document.activeElement;
  const isTextInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  if (!isTextInput) {
    return { ok: false, detail: 'No focused input/textarea to type into — click a field first.' };
  }

  const proto = active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(active, action.text);

  active.dispatchEvent(new Event('input', { bubbles: true }));
  active.dispatchEvent(new Event('change', { bubbles: true }));

  return { ok: true, detail: `Typed into ${describeElement(active)}.` };
}

function executeScroll(action: ExecutableAction): ExecutionResult {
  if (!action.scrollDirection) return { ok: false, detail: 'scroll action is missing a direction.' };

  const amount = window.innerHeight * 0.8;
  window.scrollBy({ top: action.scrollDirection === 'down' ? amount : -amount });

  return { ok: true, detail: `Scrolled ${action.scrollDirection}.` };
}

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  return `${tag}${id}`;
}
