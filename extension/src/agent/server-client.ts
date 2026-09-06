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
import type { AgentActionCommand, AgentPlanRequest, AskRequest } from '../types';

/** Local dev only — Phase 4's server has no deployment story yet. */
const SERVER_BASE = 'http://127.0.0.1:8000';
export const PLAN_ACTION_URL = `${SERVER_BASE}/plan-action`;
export const ASK_URL = `${SERVER_BASE}/ask`;

export type PlanActionResult = { ok: true; action: AgentActionCommand } | { ok: false; error: string };
export type AskResult = { ok: true; answer: string } | { ok: false; error: string };

/** Shared by planAction and askQuestion — the fetch/JSON/error-shape
 *  handling is identical; only which field of a successful body counts as
 *  the "real" result differs (action vs. answer). */
async function postToServer<T>(
  url: string,
  req: unknown,
  extractField: (body: { ok?: boolean; error?: string } & Record<string, unknown>) => T | undefined,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach the action-planner server at ${url}. Is it running? (${
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

  const parsed = body as { ok?: boolean; error?: string } & Record<string, unknown>;
  const value = extractField(parsed);
  if (!parsed.ok || value === undefined) {
    return { ok: false, error: parsed.error ?? 'Server returned ok:false with no error detail.' };
  }

  return { ok: true, value };
}

export async function planAction(req: AgentPlanRequest): Promise<PlanActionResult> {
  const result = await postToServer<AgentActionCommand>(
    PLAN_ACTION_URL,
    req,
    (body) => body.action as AgentActionCommand | undefined,
  );
  return result.ok ? { ok: true, action: result.value } : result;
}

export async function askQuestion(req: AskRequest): Promise<AskResult> {
  const result = await postToServer<string>(ASK_URL, req, (body) => body.answer as string | undefined);
  return result.ok ? { ok: true, answer: result.value } : result;
}
