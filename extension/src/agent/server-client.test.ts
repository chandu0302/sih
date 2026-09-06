import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentPlanRequest } from '../types';
import { planAction, SERVER_URL } from './server-client';

const sampleRequest: AgentPlanRequest = {
  image: 'data:image/png;base64,AAAA',
  manifest: { regions: [] },
  task: 'click submit',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('planAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the request body to SERVER_URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, action: { action: 'done', reasoning: 'x' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await planAction(sampleRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      SERVER_URL,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(sampleRequest),
      }),
    );
  });

  it('returns the action on a successful ok:true response', async () => {
    const action = { action: 'click', target: { x: 1, y: 2 }, reasoning: 'clicking' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, action })));

    const result = await planAction(sampleRequest);

    expect(result).toEqual({ ok: true, action });
  });

  it('surfaces the server error string on an ok:false response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { ok: false, error: 'OPENROUTER_API_KEY is not set' })),
    );

    const result = await planAction(sampleRequest);

    expect(result).toEqual({ ok: false, error: 'OPENROUTER_API_KEY is not set' });
  });

  it('surfaces a network failure (server not running) as a value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const result = await planAction(sampleRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Could not reach the action-planner server');
    }
  });

  it('surfaces a non-2xx HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { detail: 'internal error' })));

    const result = await planAction(sampleRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('500');
    }
  });

  it('surfaces non-JSON responses without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json', { status: 200 })),
    );

    const result = await planAction(sampleRequest);

    expect(result.ok).toBe(false);
  });
});
