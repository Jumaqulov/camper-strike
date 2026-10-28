import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { SERVER_PORT } from '../shared/constants';
import { createWorldDefinition } from '../shared/world';
import { Lobby } from './lobby';
import { getNav } from './navgraph';
import { validateMapSpawns } from './room';

// `--port N` (dev:server skriptida — Vite proxy 3000 ni kutadi) muhitdagi PORT dan ustun: `npm run dev` ni
// PORT=5173 beradigan vosita ishga tushirsa ham o'yin serveri Vite porti bilan to'qnashmaydi
const portArgIdx = process.argv.indexOf('--port');
const PORT = Number(portArgIdx >= 0 ? process.argv[portArgIdx + 1] : NaN) || Number(process.env.PORT) || SERVER_PORT;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');

function lanIPs(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      const fam = a.family as unknown;
      if ((fam === 'IPv4' || fam === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 10000 });

app.get('/api/info', (_req, res) => {
  res.json({ ips: lanIPs(), port: PORT });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
} else {
  app.get('/', (_req, res) => {
    res
      .type('html')
      .send(
        '<h2>Klient hali build qilinmagan.</h2><p><code>npm start</code> buyrug\'i bilan ishga tushiring yoki dev rejimda <a href="http://localhost:5173">http://localhost:5173</a> ga kiring.</p>',
      );
  });
}

new Lobby(io);

// Standart xarita (forest_square, standart seed) uchun botlar navigatsiya to'rini oldindan hisoblab qo'yamiz —
// keyin shu seed bilan ochilgan xonalar `getNav` keshidan tayyor to'rni oladi.
const t0 = performance.now();
const defaultWorld = createWorldDefinition({ mapId: 'forest_square' });
const nav = getNav(defaultWorld);
console.log(`[nav] ${nav.validList.length} ta tugun, ${(performance.now() - t0).toFixed(0)} ms`);
const badSpawns = validateMapSpawns(defaultWorld);
if (badSpawns.length) console.warn('[map] Devor ichida qolgan spawnlar:', badSpawns.join(', '));

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ====================================');
  console.log('   CAMPER STRIKE 65 serveri ishga tushdi');
  console.log('  ====================================');
  console.log(`   Shu kompyuterda:   http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`   Lokal tarmoqda:    http://${ip}:${PORT}`);
  console.log('');
});
