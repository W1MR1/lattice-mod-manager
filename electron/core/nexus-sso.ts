// Nexus Mods single sign-on, protocol 2 (github.com/Nexus-Mods/sso-integration-demo):
// open a socket, send our id, let the user approve the app in the browser, and
// receive their API key over the socket. Lattice never sees the password.
import { randomUUID } from 'node:crypto';
import { t } from '../../shared/i18n';

export const SSO_SOCKET = 'wss://sso.nexusmods.com';

interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SsoOptions {
  slug: string;
  /** opens the approval page in the user's browser */
  openBrowser: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  /** for tests */
  socketFactory?: (url: string) => SocketLike;
}

export function ssoUrl(id: string, slug: string): string {
  return `https://www.nexusmods.com/sso?id=${encodeURIComponent(id)}&application=${encodeURIComponent(slug)}`;
}

/** Resolves with the user's API key once they approve Lattice on nexusmods.com. */
export function nexusSso(opts: SsoOptions): Promise<string> {
  if (!opts.slug) return Promise.reject(new Error(t('Вход через Nexus появится после регистрации Lattice в Nexus Mods')));
  const make = opts.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const id = randomUUID();
  let token: string | null = null;
  let opened = false;
  let done = false;
  let retries = 0;

  return new Promise<string>((resolve, reject) => {
    let socket: SocketLike;
    const finish = (err: Error | null, key?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(key!);
    };
    const timer = setTimeout(() => finish(new Error(t('Nexus не ответил: подтверждение не пришло за 5 минут'))), opts.timeoutMs ?? 5 * 60_000);

    const connect = () => {
      socket = make(SSO_SOCKET);
      socket.onopen = () => {
        // a reconnect reuses the id and the connection token the server gave us
        socket.send(JSON.stringify({ id, token, protocol: 2 }));
        if (!opened) {
          opened = true;
          void Promise.resolve(opts.openBrowser(ssoUrl(id, opts.slug))).catch((e) => finish(e as Error));
        }
      };
      socket.onmessage = (ev) => {
        let msg: { success?: boolean; data?: { connection_token?: string; api_key?: string }; error?: unknown };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!msg.success) return finish(new Error(t('Nexus отклонил вход{0}', msg.error ? `: ${String(msg.error)}` : '')));
        if (msg.data?.connection_token) token = msg.data.connection_token;
        if (msg.data?.api_key) finish(null, msg.data.api_key);
      };
      socket.onerror = () => undefined; // onclose follows and decides
      socket.onclose = () => {
        if (done) return;
        if (retries++ < 3) setTimeout(connect, 1000 * retries);
        else finish(new Error(t('Соединение с Nexus прервалось')));
      };
    };
    connect();
  });
}
