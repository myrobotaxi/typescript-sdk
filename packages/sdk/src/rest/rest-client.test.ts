import { describe, expect, it, vi } from 'vitest';

import { RestClient } from './rest-client';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient() {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return ok({ items: [], nextCursor: null, hasMore: false });
  });
  const client = new RestClient({
    baseUrl: 'https://t.example/',
    getToken: async () => 'tok',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls };
}

describe('RestClient — endpoint URLs + methods (rest-api §7)', () => {
  it('vehicles.list → GET /api/vehicles', async () => {
    const { client, calls } = makeClient();
    await client.vehicles.list();
    expect(calls[0]).toEqual({ url: 'https://t.example/api/vehicles', method: 'GET' });
  });

  it('snapshot.get → GET /api/vehicles/{id}/snapshot (id encoded)', async () => {
    const { client, calls } = makeClient();
    await client.snapshot.get('veh/1');
    expect(calls[0]!.url).toBe('https://t.example/api/vehicles/veh%2F1/snapshot');
  });

  it('drives.list → cursor + limit query', async () => {
    const { client, calls } = makeClient();
    await client.drives.list('v1', { cursor: 'abc', limit: 50 });
    expect(calls[0]!.url).toBe(
      'https://t.example/api/vehicles/v1/drives?cursor=abc&limit=50',
    );
  });

  it('drives.get / drives.route', async () => {
    const { client, calls } = makeClient();
    await client.drives.get('d1');
    await client.drives.route('d1');
    expect(calls[0]!.url).toBe('https://t.example/api/drives/d1');
    expect(calls[1]!.url).toBe('https://t.example/api/drives/d1/route');
  });

  it('invites.create POST, list GET, revoke DELETE', async () => {
    const { client, calls } = makeClient();
    await client.invites.create('a@b.com');
    await client.invites.list();
    await client.invites.revoke('i1');
    expect(calls[0]).toEqual({ url: 'https://t.example/api/invites', method: 'POST' });
    expect(calls[1]).toEqual({ url: 'https://t.example/api/invites', method: 'GET' });
    expect(calls[2]).toEqual({ url: 'https://t.example/api/invites/i1', method: 'DELETE' });
  });

  it('users.delete DELETE, users.export GET', async () => {
    const { client, calls } = makeClient();
    await client.users.delete();
    await client.users.export();
    expect(calls[0]).toEqual({ url: 'https://t.example/api/users/me', method: 'DELETE' });
    expect(calls[1]).toEqual({ url: 'https://t.example/api/users/me/export', method: 'GET' });
  });

  it('returns discriminated ok result', async () => {
    const { client } = makeClient();
    const r = await client.vehicles.list();
    expect(r.ok).toBe(true);
  });
});
