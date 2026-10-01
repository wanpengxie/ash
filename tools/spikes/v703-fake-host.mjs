import { createServer } from "node:http";

const port = Number(process.env.ASH_703_PORT || 4870);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("invalid test port");
const prefix = "ASH703_SYNTHETIC_";
let accepted = 0;
let rejected = 0;

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted, rejected }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/send") {
    res.writeHead(404).end();
    return;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32_768) { res.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  let valid = false;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    valid = /^Bearer [^\s]+$/.test(req.headers.authorization || "") &&
      body.to === null && body.kind === "event" && body.word === "sense.notification" &&
      typeof body.client_id === "string" && body.client_id.length > 0 &&
      typeof body.body?.app === "string" &&
      typeof body.body?.title === "string" && body.body.title.startsWith(prefix) &&
      typeof body.body?.text === "string" && body.body.text.startsWith(prefix);
  } catch { /* Deliberately do not print notification contents or credentials. */ }
  if (!valid) { rejected++; res.writeHead(400).end(); return; }
  accepted++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: `synthetic-${accepted}`, seq: accepted }));
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`synthetic sense host listening on loopback:${port}\n`));
