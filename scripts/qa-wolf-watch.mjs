/**
 * QA: ishlab turgan serverdagi xonaga ikkinchi o'yinchi sifatida kirib, bo'rilarning holat o'zgarishlari,
 * tishlashlari, uvlashlari va g'ayritabiiy sakrashlarini (> 9 m/s) konsolga yozadi.
 *
 *   npm run serve                      # alohida terminalda
 *   node scripts/qa-wolf-watch.mjs <roomId> [soniya=40]
 *
 * roomId ni lobbidagi xona ro'yxatidan yoki `/addwolf` qilingan xonadan oling (masalan r1abcd).
 */
import { io } from 'socket.io-client';
const roomId = process.argv[2];
const seconds = Number(process.argv[3] ?? 40);
if (!roomId) {
  console.error('Foydalanish: node scripts/qa-wolf-watch.mjs <roomId> [soniya]');
  process.exit(1);
}
const s = io('http://localhost:3000', { transports: ['websocket'] });
const ack = (ev, data) => new Promise((res) => s.emit(ev, data, res));
s.on('connect', async () => {
  await ack('hello', { name: 'Watcher' });
  const joined = await ack('joinRoom', { roomId });
  if (!joined.ok) {
    console.log('join failed', joined);
    process.exit(1);
  }
  await ack('ready', { world: joined.welcome.world });
  const prev = new Map();
  const states = new Map();
  let lastPrint = 0;
  s.on('snap', (snap) => {
    const now = Date.now();
    const me = snap.players.find((p) => p.id === s.id);
    for (const w of snap.wolves ?? []) {
      const p = prev.get(w.id);
      if (p) {
        const dt = (now - p.at) / 1000;
        const sp = Math.hypot(w.x - p.x, w.z - p.z) / Math.max(dt, 1e-3);
        if (sp > 9) console.log(`!! ${w.id} sakradi: ${sp.toFixed(1)} m/s (${p.x.toFixed(1)},${p.z.toFixed(1)}) -> (${w.x.toFixed(1)},${w.z.toFixed(1)}) state=${w.state}`);
      }
      prev.set(w.id, { x: w.x, z: w.z, at: now });
      if (states.get(w.id) !== w.state) {
        states.set(w.id, w.state);
        const d = me ? Math.hypot(w.x - me.x, w.z - me.z).toFixed(0) : '?';
        console.log(`${((now - t0) / 1000).toFixed(1)}s ${w.id} -> ${w.state} tgt=${w.targetId ?? '-'} role=${w.role ?? '-'} dMe=${d}`);
      }
    }
    if (now - lastPrint > 5000) {
      lastPrint = now;
      const ws = (snap.wolves ?? []).map((w) => `${w.id}:${w.state}@${me ? Math.hypot(w.x - me.x, w.z - me.z).toFixed(0) : '?'}m`).join(' ');
      console.log(`${((now - t0) / 1000).toFixed(0)}s hp=${me?.hp} ${ws}`);
    }
  });
  s.on('wolf:bite', (e) => console.log('BITE', JSON.stringify(e)));
  s.on('wolf:howl', (e) => console.log('HOWL', e.id));
  s.on('hurt', (e) => console.log('HURT', e.attacker, e.damage));
  const t0 = Date.now();
  setTimeout(() => {
    s.emit('leaveRoom');
    s.close();
    process.exit(0);
  }, seconds * 1000);
});
