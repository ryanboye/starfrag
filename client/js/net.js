// STARFRAG — client networking. Thin wrapper over one WebSocket to the
// authoritative server. Holds the latest snapshot of every player and fires
// callbacks for one-shot events (shots, hits, kills) so the renderer can flash.
import { C2S, S2C } from '../shared/protocol.js';

function wsUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get('ws')) return q.get('ws');                 // explicit override for local dev
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return `ws://${h}:8791`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/starfrag-ws`;      // Caddy reverse-proxies this
}

export const Net = {
  ws: null,
  connected: false,
  myId: null,
  players: new Map(),        // id -> latest public state
  handlers: {},              // name -> fn(msg)
  onWelcome: null,

  on(name, fn) { this.handlers[name] = fn; },

  connect(name) {
    const url = wsUrl();
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.connected = true;
      this.send({ t: C2S.JOIN, name });
    };
    this.ws.onclose = () => { this.connected = false; };
    this.ws.onerror = () => { this.connected = false; };
    this.ws.onmessage = (ev) => this._recv(ev.data);
    return this;
  },

  _recv(data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case S2C.WELCOME:
        this.myId = m.id;
        for (const p of m.players) this.players.set(p.id, p);
        this.onWelcome && this.onWelcome(m);
        break;
      case S2C.STATE: {
        const seen = new Set();
        for (const p of m.players) { this.players.set(p.id, p); seen.add(p.id); }
        for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
        break;
      }
      case S2C.SPAWN: {
        const p = this.players.get(m.id);
        if (p) { p.x = m.x; p.y = m.y; p.ang = m.ang; p.dead = false; p.hp = 100; }
        break;
      }
      case S2C.LEAVE:
        this.players.delete(m.id);
        break;
    }
    const h = this.handlers[m.t];
    if (h) h(m);
  },

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  },
  move(x, y, ang, moving) { this.send({ t: C2S.MOVE, x, y, ang, moving }); },
  shoot(ang, weapon) { this.send({ t: C2S.SHOOT, ang, weapon }); },   // weapon is advisory; server uses its authoritative one
  charge() { this.send({ t: C2S.CHARGE }); },                         // charge weapons: start the SERVER-side charge clock (it times the hold)
  reload(weapon) { this.send({ t: C2S.RELOAD, weapon }); },
  switchWeapon(weapon) { this.send({ t: C2S.SWITCH, weapon }); },
};
