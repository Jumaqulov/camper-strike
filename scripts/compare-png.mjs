import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePngRgba(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]; // 6 = RGBA, 2 = RGB
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const decompressed = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = 1 + width * bpp;
  const raw = Buffer.alloc(width * height * 4);

  // Unfilter
  let prevRow = Buffer.alloc(width * bpp);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const filter = decompressed[rowStart];
    const currRow = Buffer.alloc(width * bpp);
    for (let x = 0; x < width * bpp; x++) {
      const rawByte = decompressed[rowStart + 1 + x];
      const left = x >= bpp ? currRow[x - bpp] : 0;
      const up = prevRow[x];
      const upLeft = x >= bpp ? prevRow[x - bpp] : 0;
      let val = rawByte;
      if (filter === 1) val = (rawByte + left) & 0xff;
      else if (filter === 2) val = (rawByte + up) & 0xff;
      else if (filter === 3) val = (rawByte + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        val = (rawByte + pr) & 0xff;
      }
      currRow[x] = val;
    }
    prevRow = currRow;

    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4;
      if (bpp === 4) {
        raw[outIdx] = currRow[x * 4];
        raw[outIdx + 1] = currRow[x * 4 + 1];
        raw[outIdx + 2] = currRow[x * 4 + 2];
        raw[outIdx + 3] = currRow[x * 4 + 3];
      } else {
        raw[outIdx] = currRow[x * 3];
        raw[outIdx + 1] = currRow[x * 3 + 1];
        raw[outIdx + 2] = currRow[x * 3 + 2];
        raw[outIdx + 3] = 255;
      }
    }
  }
  return { width, height, data: raw };
}

function compare(file) {
  const pBefore = 'docs/screenshots/stage08terrain-art-polish/before/' + file;
  const pAfter = 'docs/screenshots/stage08terrain-art-polish/after/' + file;
  if (!fs.existsSync(pBefore) || !fs.existsSync(pAfter)) return;
  const b1 = decodePngRgba(fs.readFileSync(pBefore));
  const b2 = decodePngRgba(fs.readFileSync(pAfter));

  let totalDiff = 0;
  let changedPixels = 0;
  let totalPixels = b1.width * b1.height;
  
  let lowerQuarterDiff = 0;
  let lowerQuarterChanged = 0;
  let lowerQuarterPixels = 0;
  const startY = Math.floor(b1.height * 0.75);

  for (let y = 0; y < b1.height; y++) {
    for (let x = 0; x < b1.width; x++) {
      const idx = (b1.width * y + x) * 4;
      const dr = Math.abs(b1.data[idx] - b2.data[idx]);
      const dg = Math.abs(b1.data[idx+1] - b2.data[idx+1]);
      const db = Math.abs(b1.data[idx+2] - b2.data[idx+2]);
      const maxD = Math.max(dr, dg, db);
      const avgD = (dr + dg + db) / 3;
      if (maxD > 1) changedPixels++;
      totalDiff += avgD;

      if (y >= startY) {
        lowerQuarterPixels++;
        if (maxD > 1) lowerQuarterChanged++;
        lowerQuarterDiff += avgD;
      }
    }
  }

  console.log(`\n=== ${file} ===`);
  console.log(`Overall Image: ${totalPixels} px | Changed: ${changedPixels} (${(changedPixels/totalPixels*100).toFixed(2)}%) | Mean RGB diff: ${(totalDiff/totalPixels).toFixed(2)} units`);
  console.log(`Foreground (Lower 25%): ${lowerQuarterPixels} px | Changed: ${lowerQuarterChanged} (${(lowerQuarterChanged/lowerQuarterPixels*100).toFixed(2)}%) | Mean RGB diff: ${(lowerQuarterDiff/lowerQuarterPixels).toFixed(2)} units`);
}

const list = [
  '01_first_join_open_forest.png',
  '02_tree_shadow_ferns.png',
  '03_moss_soil_ground_detail.png',
  '04_winding_dirt_road.png',
  '05_road_edge_flowers_grass.png',
  '06_poi_ranger_yard_approach.png',
  '07a_first_person_near_grass.png',
  '07b_third_person_near_grass.png',
  '08_topdown_map_overview.png'
];
for (const f of list) compare(f);
