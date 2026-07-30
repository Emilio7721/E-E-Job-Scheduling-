const webpush = require('web-push');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

// VAPID keys are generated once on first boot and persisted, so push
// subscriptions survive server restarts.
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (fs.existsSync(VAPID_FILE)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
}

const contact = process.env.VAPID_CONTACT || 'mailto:admin@example.com';
webpush.setVapidDetails(contact, vapid.publicKey, vapid.privateKey);

const deleteSub = db.prepare('DELETE FROM push_subs WHERE endpoint = ?');
const subsForUser = db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?');

/**
 * Send a push notification to every registered device of a user.
 * Dead subscriptions (uninstalled PWA, revoked permission) are pruned.
 */
async function pushToUser(userId, payload) {
  const subs = subsForUser.all(userId);
  const json = JSON.stringify(payload);
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        json,
        { TTL: 60 * 60 * 24 }
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        deleteSub.run(sub.endpoint);
      } else {
        console.error(`push to user ${userId} failed:`, err.statusCode || err.message);
      }
    }
  }));
}

module.exports = { publicKey: vapid.publicKey, pushToUser };
