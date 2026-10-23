import fs from 'node:fs';
import { PNG } from 'pngjs';

function compare(file) {
  const pBefore = 'docs/screenshots/stage08terrain-art-polish/before/' + file;
  const pAfter = 'docs/screenshots/stage08terrain-art-polish/after/' + file;
  if (!fs.existsSync(pBefore) || !fs.existsSync(pAfter)) return;
  const b1 = PNG.sync.read(fs.readFileSync(pBefore));
  const b2 = PNG.sync.read(fs.readFileSync(pAfter));
  let totalDiff = 0;
  let changedPixels = 0;
  let totalPixels = b1.width * b1.height;
  
  // Also check lower quarter (foreground terrain)
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

  console.log('=== ' + file + ' ===');
  console.log('Total pixels: ' + totalPixels + ', changed: ' + changedPixels + ' (' + (changedPixels/totalPixels*100).toFixed(2) + '%), mean RGB diff: ' + (totalDiff/totalPixels).toFixed(2));
  console.log('Foreground lower-quarter pixels: ' + lowerQuarterPixels + ', changed: ' + lowerQuarterChanged + ' (' + (lowerQuarterChanged/lowerQuarterPixels*100).toFixed(2) + '%), mean RGB diff: ' + (lowerQuarterDiff/lowerQuarterPixels).toFixed(2));
}

['01_first_join_open_forest.png', '02_tree_shadow_ferns.png', '03_moss_soil_ground_detail.png', '04_winding_dirt_road.png', '05_road_edge_flowers_grass.png', '06_poi_ranger_yard_approach.png', '07a_first_person_near_grass.png', '07b_third_person_near_grass.png', '08_topdown_map_overview.png'].forEach(compare);
