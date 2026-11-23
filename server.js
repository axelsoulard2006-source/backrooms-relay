const http = require("http");
const { WebSocketServer } = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Backrooms relay OK");
});
const wss = new WebSocketServer({ server });
const rooms = new Map();
const send = (ws, m) => { try { if (ws && ws.readyState === 1) ws.send(m); } catch (e) {} };

wss.on("connection", (ws) => {
  let room = "", id = "", host = false;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data) => {
    const m = data.toString();
    if (m.startsWith("J:")) {
      const p = m.split(":");
      if (p.length < 4) return;
      room = p[1]; id = p[2]; host = p[3] === "H";
      let r = rooms.get(room);
      if (!r) { r = { host: null, guests: new Map() }; rooms.set(room, r); }
      if (host) { r.host = ws; for (const k of r.guests.keys()) send(ws, "P:" + k); }
      else { r.guests.set(id, ws); send(r.host, "P:" + id); }
      return;
    }
    if (m === "I:") { send(ws, "I:"); return; }
    const r = rooms.get(room);
    if (!r) return;
    if (m.startsWith("T:")) {
      const i = m.indexOf(":", 2);
      if (i < 0) return;
      const to = m.slice(2, i), payload = m.slice(i + 1);
      if (to === "H") send(r.host, "F:" + id + ":" + payload);
      else if (to === "*") { for (const g of r.guests.values()) send(g, "D:" + payload); }
      else send(r.guests.get(to), "D:" + payload);
    }
  });
  ws.on("close", () => {
    const r = rooms.get(room);
    if (!r) return;
    if (host) {
      if (r.host === ws) { r.host = null; for (const g of r.guests.values()) send(g, "X:"); }
    } else {
      if (r.guests.get(id) === ws) r.guests.delete(id);
      send(r.host, "B:" + id);
    }
    if (!r.host && r.guests.size === 0) rooms.delete(room);
  });
});

setInterval(() => {
  wss.clients.forEach((c) => { if (c.isAlive === false) return c.terminate(); c.isAlive = false; try { c.ping(); } catch (e) {} });
}, 25000);

server.listen(process.env.PORT || 8080, () => console.log("Relais Backrooms pret"));
