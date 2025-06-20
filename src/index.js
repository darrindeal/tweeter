import { DurableObject } from "cloudflare:workers";

/**
 * Minimal Pusher compatible server using Cloudflare Durable Objects.
 * The worker exposes the Pusher WebSocket endpoint at /app/APP_KEY and
 * an HTTP endpoint for server side event publishing at /apps/APP_ID/events.
 */

/**
 * Helper to compute an HMAC SHA256
 * @param {string} secret
 * @param {string} msg
 */
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Durable Object storing all connections for a single Pusher application.
 */
export class PusherDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    /** @type {Map<string, {ws:WebSocket, channels:Set<string>, user?:{id:string,info:any}}>} */
    this.clients = new Map();
    /** @type {Map<string, Set<string>>} */
    this.channels = new Map();
    /** @type {Map<string, Map<string, any>>} */
    this.presence = new Map();
  }

  /**
   * Entry point for all requests routed to this Durable Object
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    if (url.pathname.endsWith("/events") && request.method === "POST") {
      const body = await request.json();
      await this.broadcast(body);
      return new Response(JSON.stringify({ sent: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Handle a new WebSocket connection
   */
  async handleWebSocket(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const socketId = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
    await this.acceptWebSocket(server, socketId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async acceptWebSocket(ws, socketId) {
    ws.accept();
    this.clients.set(socketId, { ws, channels: new Set() });

    ws.send(
      JSON.stringify({
        event: "pusher:connection_established",
        data: JSON.stringify({ socket_id: socketId, activity_timeout: 120 }),
      })
    );

    ws.addEventListener("message", (ev) => this.onMessage(socketId, ev));
    ws.addEventListener("close", () => this.onClose(socketId));
    ws.addEventListener("error", () => this.onClose(socketId));
  }

  async onMessage(socketId, ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    const event = msg.event;
    const data = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data || {});
    if (event === "pusher:ping") {
      this.clients.get(socketId)?.ws.send(
        JSON.stringify({ event: "pusher:pong", data: "{}" })
      );
      return;
    }

    if (event === "pusher:subscribe") {
      const payload = JSON.parse(data);
      return this.subscribe(socketId, payload);
    }
    if (event === "pusher:unsubscribe") {
      const payload = JSON.parse(data);
      return this.unsubscribe(socketId, payload.channel);
    }

    if (event && event.startsWith("client-")) {
      return this.clientEvent(socketId, msg.channel, event, data);
    }
  }

  async subscribe(socketId, payload) {
    const channel = payload.channel;
    const client = this.clients.get(socketId);
    if (!client) return;

    if (channel.startsWith("private-") || channel.startsWith("presence-")) {
      if (!payload.auth) {
        client.ws.send(
          JSON.stringify({ event: "pusher:error", data: { message: "Auth required", code: 4009 } })
        );
        return;
      }
      const [key, signature] = payload.auth.split(":");
      if (key !== this.env.PUSHER_APP_KEY) {
        client.ws.send(
          JSON.stringify({ event: "pusher:error", data: { message: "Invalid key", code: 4009 } })
        );
        return;
      }
      const base = `${socketId}:${channel}` + (payload.channel_data ? `:${payload.channel_data}` : "");
      const expected = await hmac(this.env.PUSHER_APP_SECRET, base);
      if (signature !== expected) {
        client.ws.send(
          JSON.stringify({ event: "pusher:error", data: { message: "Invalid signature", code: 4009 } })
        );
        return;
      }
      if (channel.startsWith("presence-")) {
        const channelData = JSON.parse(payload.channel_data);
        client.user = { id: channelData.user_id, info: channelData.user_info };
        if (!this.presence.has(channel)) this.presence.set(channel, new Map());
        this.presence.get(channel).set(channelData.user_id, channelData.user_info);
      }
    }

    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(socketId);
    client.channels.add(channel);

    if (channel.startsWith("presence-")) {
      const members = this.presence.get(channel) || new Map();
      const ids = [...members.keys()];
      const hash = Object.fromEntries(members.entries());
      const count = ids.length;
      client.ws.send(
        JSON.stringify({
          event: "pusher_internal:subscription_succeeded",
          channel,
          data: JSON.stringify({ presence: { ids, hash, count } }),
        })
      );
      client.ws.send(
        JSON.stringify({
          event: "pusher:subscription_succeeded",
          channel,
          members: { count, each: () => {} },
        })
      );
      for (const sid of this.channels.get(channel)) {
        if (sid === socketId) continue;
        this.clients.get(sid)?.ws.send(
          JSON.stringify({
            event: "pusher_internal:member_added",
            channel,
            data: JSON.stringify({ user_id: client.user.id, user_info: client.user.info }),
          })
        );
      }
    } else {
      client.ws.send(
        JSON.stringify({ event: "pusher_internal:subscription_succeeded", channel, data: "{}" })
      );
      client.ws.send(
        JSON.stringify({ event: "pusher:subscription_succeeded", channel, data: "{}" })
      );
    }
  }

  async unsubscribe(socketId, channel) {
    const client = this.clients.get(socketId);
    if (!client) return;
    client.channels.delete(channel);
    const set = this.channels.get(channel);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) this.channels.delete(channel);
    }
    if (channel.startsWith("presence-") && client.user) {
      const members = this.presence.get(channel);
      if (members) members.delete(client.user.id);
      for (const sid of set || []) {
        this.clients.get(sid)?.ws.send(
          JSON.stringify({
            event: "pusher_internal:member_removed",
            channel,
            data: JSON.stringify({ user_id: client.user.id }),
          })
        );
      }
    }
  }

  async clientEvent(socketId, channel, event, data) {
    const client = this.clients.get(socketId);
    if (!client || !client.channels.has(channel)) return;
    if (!channel.startsWith("private-") && !channel.startsWith("presence-")) return;
    const set = this.channels.get(channel);
    if (!set) return;
    for (const sid of set) {
      if (sid === socketId) continue;
      this.clients.get(sid)?.ws.send(
        JSON.stringify({ event, channel, data, user_id: client.user?.id })
      );
    }
  }

  async broadcast({ name, data, channels, socket_id }) {
    for (const channel of channels) {
      const set = this.channels.get(channel);
      if (!set) continue;
      for (const sid of set) {
        if (sid === socket_id) continue;
        this.clients.get(sid)?.ws.send(
          JSON.stringify({ event: name, channel, data })
        );
      }
    }
  }

  async onClose(socketId) {
    const client = this.clients.get(socketId);
    if (!client) return;
    for (const channel of [...client.channels]) {
      await this.unsubscribe(socketId, channel);
    }
    this.clients.delete(socketId);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wsPath = `/app/${env.PUSHER_APP_KEY}`;
    const httpPath = `/apps/${env.PUSHER_APP_ID}/events`;

    const id = env.PUSHER.idFromName(env.PUSHER_APP_ID);
    const stub = env.PUSHER.get(id);

    if (url.pathname === wsPath && request.headers.get("Upgrade") === "websocket") {
      return stub.fetch(request);
    }

    if (url.pathname === httpPath && request.method === "POST") {
      // In production you should verify the Pusher auth signature here.
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
