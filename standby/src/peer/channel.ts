// The peer channel (direct mode): HTTPS with mutual TLS where each side pins
// the other's self-signed certificate by SHA-256 fingerprint. There is no CA
// and no hostname check; the fingerprint IS the identity. A connection whose
// certificate does not match is closed before any request is sent.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { normaliseFingerprint, type Identity } from "../crypto/identity.ts";
import type { PeerApi } from "../link/link.ts";

export interface PeerTarget { addresses: string[]; port: number; fingerprint: string }

export class PeerUnreachableError extends Error {}
export class PeerIdentityError extends Error {}

/** Open a TLS connection to one address and verify the pinned certificate. */
export function connectPinned(host: string, port: number, fingerprint: string, id: Identity, timeoutMs = 8000): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, key: id.keyPem, cert: id.certPem, rejectUnauthorized: false, servername: "vibe-standby-peer" });
    const timer = setTimeout(() => { socket.destroy(); reject(new PeerUnreachableError(`${host}:${port} did not answer`)); }, timeoutMs);
    socket.once("error", (e) => { clearTimeout(timer); reject(new PeerUnreachableError(`${host}:${port}: ${e.message}`)); });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const got = normaliseFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
      if (got !== fingerprint) {
        socket.destroy();
        reject(new PeerIdentityError(`${host}:${port} is not the paired box (its certificate does not match). Nothing was sent.`));
      } else resolve(socket);
    });
  });
}

/** Try each known address in order; an identity mismatch stops at once. */
export async function connectAny(t: PeerTarget, id: Identity): Promise<tls.TLSSocket> {
  let last: Error = new PeerUnreachableError("no peer address is known");
  for (const host of t.addresses) {
    try { return await connectPinned(host, t.port, t.fingerprint, id); }
    catch (e) { if (e instanceof PeerIdentityError) throw e; last = e as Error; }
  }
  throw last;
}

export class PeerClient implements PeerApi {
  #t: () => PeerTarget | undefined; #id: Identity;
  constructor(target: () => PeerTarget | undefined, id: Identity) { this.#t = target; this.#id = id; }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const t = this.#t();
    if (!t) throw new PeerUnreachableError("this box is not paired in direct mode");
    const socket = await connectAny(t, this.#id);
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({
        createConnection: () => socket, method, path,
        headers: { host: "peer", connection: "close", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = {};
          try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
          if ((res.statusCode ?? 500) >= 400) reject(new Error((json as { error?: string }).error ?? `the other box answered ${res.statusCode}`));
          else resolve(json as T);
        });
      });
      req.setTimeout(30000, () => req.destroy(new PeerUnreachableError("the other box stopped answering")));
      req.on("error", reject);
      req.end(payload);
    });
  }
}

export interface PeerRequest { method: string; path: string; body: unknown; fingerprint: string; remoteAddress: string }
export type PeerHandler = (r: PeerRequest) => Promise<{ status?: number; body: unknown }>;

export interface PeerServerOptions {
  identity: Identity;
  port: number;
  host?: string;
  /** JSON routes. Authorisation (is this the paired box?) is the handler's job, given the caller's fingerprint. */
  handle: PeerHandler;
  /** Raw passthrough for /peer/repo/*: return the local port to proxy to, or null to refuse. */
  repoUpstream: (fingerprint: string) => number | null;
}

export function startPeerServer(o: PeerServerOptions): Promise<https.Server> {
  const server = https.createServer({ key: o.identity.keyPem, cert: o.identity.certPem, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const sock = req.socket as tls.TLSSocket;
    const fingerprint = normaliseFingerprint(sock.getPeerCertificate()?.fingerprint256 ?? "");
    const url = req.url ?? "/";
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!fingerprint) return send(401, { error: "a client certificate is required" });

    if (url.startsWith("/peer/repo/") || url === "/peer/repo") {
      const port = o.repoUpstream(fingerprint);
      if (!port) return send(403, { error: "this box does not accept repository traffic from you" });
      const headers = { ...req.headers, host: `127.0.0.1:${port}` };
      const up = http.request({ host: "127.0.0.1", port, method: req.method, path: url.slice("/peer/repo".length) || "/", headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on("error", () => { if (!res.headersSent) send(502, { error: "the repository receiver is not running" }); else res.destroy(); });
      req.pipe(up);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 256 * 1024) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
      let body: unknown;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; }
      catch { return send(400, { error: "not JSON" }); }
      o.handle({ method: req.method ?? "GET", path: url.split("?")[0]!, body, fingerprint, remoteAddress: (sock.remoteAddress ?? "").replace(/^::ffff:/, "") })
        .then((r) => send(r.status ?? 200, r.body), (e: Error) => send(500, { error: e.message }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "0.0.0.0", () => resolve(server));
  });
}

/**
 * Primary side of direct mode: a plain-HTTP listener on localhost that
 * carries restic's requests to the standby's receiver over the pinned
 * channel. restic only ever talks to 127.0.0.1.
 */
export function startRepoForwarder(port: number, target: () => PeerTarget | undefined, id: Identity): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const t = target();
    const fail = (status: number, msg: string) => { if (!res.headersSent) { res.writeHead(status, { "content-type": "text/plain" }); res.end(msg); } else res.destroy(); };
    if (!t) return fail(503, "not paired");
    connectAny(t, id).then((socket) => {
      const up = http.request({ createConnection: () => socket, method: req.method, path: `/peer/repo${req.url ?? "/"}`, headers: { ...req.headers, host: "peer", connection: "close" } }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on("error", (e) => fail(502, e.message));
      req.pipe(up);
    }, (e: Error) => fail(e instanceof PeerIdentityError ? 495 : 503, e.message));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
