// Server-Sent Events hub: keeps one open connection per browser tab and
// pushes realtime events (chat messages, schedule changes, notifications).

const clients = new Map(); // userId -> Set<res>

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.on('close', () => {
    const set = clients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(userId);
    }
  });
}

function isOnline(userId) {
  return clients.has(userId);
}

function sendTo(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(frame);
}

function sendToMany(userIds, event, data) {
  for (const id of new Set(userIds)) sendTo(id, event, data);
}

function broadcast(event, data) {
  for (const id of clients.keys()) sendTo(id, event, data);
}

module.exports = { addClient, isOnline, sendTo, sendToMany, broadcast };
