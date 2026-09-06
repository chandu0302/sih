/**
 * SIH 26171 — Phase 5: Phase 4 server client.
 *
 * One plain fetch, no WebSocket/offscreen document — see App.tsx's doc
 * comment on why: this phase is scoped to ONE action, and a single fetch
 * completes comfortably within a side panel's lifetime. host_permissions
 * already covers <all_urls>, so this needs no manifest change (verified
 * before building this file, not assumed).
 *
 * Errors are values, mirroring every other boundary in this codebase
 * (CaptureResponse, ScreenshotCaptureResponse, and the server's own
 * {ok,error} convention in server/app/main.py) rather than throwing across
 * the panel/server line.
 */
import type { AgentActionCommand, AgentPlanRequest } from '../types';

/** Local dev only — Phase 4's server has no deployment story yet. */
export const SERVER_URL = 'http://127.0.0.1:8000/plan-action';

export type PlanActionResult = { ok: true; action: AgentActionCommand } | { ok: false; error: string };

export async function planAction(req: AgentPlanRequest): Promise<PlanActionResult> {
  let res: Response;
  try {
    res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach the action-planner server at ${SERVER_URL}. Is it running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: `Server response was not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  if (!res.ok) {
    return { ok: false, error: `Server returned ${res.status}: ${JSON.stringify(body)}` };
  }

  const parsed = body as { ok?: boolean; action?: AgentActionCommand; error?: string };
  if (!parsed.ok || !parsed.action) {
    return { ok: false, error: parsed.error ?? 'Server returned ok:false with no error detail.' };
  }

  return { ok: true, action: parsed.action };
}
