import { pathToFileURL } from 'node:url';
const root = (process.argv[2] ?? 'd:/Stickman-strike-backup-pre08fix').replace(/\\/g, '/') + '/';
const fsq = await import(pathToFileURL(root + 'src/shared/forestSquare.ts').href);
const phys = await import(pathToFileURL(root + 'src/shared/physics.ts').href);
const w = fsq.createForestSquareWorld({ publicLayoutSeed: 6501 });
const id = 'poi:poi_forest_camp:out_1:forest_tent_01';
const cols = w.colliders.filter((c: any) => c.id.startsWith(id));
for (const c of cols) console.log(c.id, JSON.stringify(c.min), JSON.stringify(c.max));
const c = { x: -51.6, y: 0.5, z: 65.8 };
const yaw = -0.35;
const ex = Math.sin(yaw), ez = Math.cos(yaw), sx = Math.cos(yaw), sz = -Math.sin(yaw);
console.log('collides center', phys.collidesAtWorld(w, c.x, c.y, c.z));
// grid of local (lx,lz) inside tent
const rows: string[] = [];
for (let lz = 2.0; lz >= -2.0; lz -= 0.2) {
  let row = `${lz.toFixed(1).padStart(5)} `;
  for (let lx = -1.6; lx <= 1.6001; lx += 0.2) {
    const x = c.x + sx * lx + ex * lz;
    const z = c.z + sz * lx + ez * lz;
    row += phys.collidesAtWorld(w, x, c.y, z) ? '#' : '.';
  }
  rows.push(row);
}
console.log('local grid (rows lz +2..-2 [entrance at +], cols lx -1.6..1.6)');
console.log(rows.join('\n'));
