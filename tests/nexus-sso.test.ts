import { describe, expect, it } from 'vitest';
import { nexusSso, SSO_SOCKET } from '../electron/core/nexus-sso';

/** A stand-in for the Nexus SSO socket that records what the client sends. */
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  reply(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('Nexus SSO (protocol 2)', () => {
  it('opens the approval page, survives a reconnect and returns the key', async () => {
    FakeSocket.all = [];
    const opened: string[] = [];
    const key = nexusSso({ slug: 'lattice', openBrowser: (u) => void opened.push(u), socketFactory: (u) => new FakeSocket(u) });
    await tick();
    const first = FakeSocket.all[0];
    expect(first.url).toBe(SSO_SOCKET);
    const hello = first.sent[0] as { id: string; token: null; protocol: number };
    expect(hello).toMatchObject({ token: null, protocol: 2 });
    expect(opened).toEqual([`https://www.nexusmods.com/sso?id=${hello.id}&application=lattice`]);

    first.reply({ success: true, data: { connection_token: 'tok-1' }, error: null });
    first.onclose?.({}); // the network drops before the user approves
    await new Promise((r) => setTimeout(r, 1100));
    const second = FakeSocket.all[1];
    expect(second.sent[0]).toEqual({ id: hello.id, token: 'tok-1', protocol: 2 });
    expect(opened).toHaveLength(1); // the page is not opened twice

    second.reply({ success: true, data: { api_key: 'user-key' }, error: null });
    await expect(key).resolves.toBe('user-key');
    expect(second.closed).toBe(true);
  });

  it('refuses to start without the slug Nexus issues at registration', async () => {
    await expect(nexusSso({ slug: '', openBrowser: () => undefined })).rejects.toThrow(/регистрации/);
  });

  it('reports a refusal from Nexus', async () => {
    FakeSocket.all = [];
    const p = nexusSso({ slug: 'lattice', openBrowser: () => undefined, socketFactory: (u) => new FakeSocket(u) });
    await tick();
    FakeSocket.all[0].reply({ success: false, data: null, error: 'denied' });
    await expect(p).rejects.toThrow(/denied/);
  });
});
