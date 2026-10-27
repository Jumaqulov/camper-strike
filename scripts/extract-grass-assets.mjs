import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// GRASS-ASSET-01 paketini (zip) public/models/grass/ ga ochib qo'yadi.
// Foydalanish: node scripts/extract-grass-assets.mjs <GRASS-ASSET-01.zip>
const zipPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!zipPath || !fs.existsSync(zipPath)) {
  console.error('Foydalanish: node scripts/extract-grass-assets.mjs <GRASS-ASSET-01.zip yo\'li>');
  console.error("  Zip ichida GRASS-ASSET-01/glb/*.glb, grass_asset_manifest.json, README.md va previews/ bo'lishi kerak.");
  process.exit(1);
}
const tmpDir = path.resolve('tmp-grass');

if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

console.log('Extracting archive...');
execSync(`powershell -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'inherit' });

const grassDir = path.resolve('public/models/grass');
fs.mkdirSync(grassDir, { recursive: true });
// Manifest validator yoniga (tools/grass-validation), README va previewlar git-ignored out/ ga
const docsDir = path.resolve('tools/grass-validation');
const outDir = path.join(docsDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

const srcGlb = path.join(tmpDir, 'GRASS-ASSET-01', 'glb');
const files = fs.readdirSync(srcGlb);
let glbCount = 0;
for (const f of files) {
  if (f.endsWith('.glb')) {
    fs.copyFileSync(path.join(srcGlb, f), path.join(grassDir, f));
    glbCount++;
  }
}

fs.copyFileSync(path.join(tmpDir, 'GRASS-ASSET-01', 'grass_asset_manifest.json'), path.join(docsDir, 'grass_asset_manifest.json'));
fs.copyFileSync(path.join(tmpDir, 'GRASS-ASSET-01', 'README.md'), path.join(outDir, 'README_CLAUDE_GRASS.md'));

const srcPreviews = path.join(tmpDir, 'GRASS-ASSET-01', 'previews');
const destPreviews = path.join(outDir, 'previews');
fs.cpSync(srcPreviews, destPreviews, { recursive: true });

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Successfully extracted ${glbCount} GLB files to public/models/grass:`);
fs.readdirSync(grassDir).forEach(f => console.log(' -', f, fs.statSync(path.join(grassDir, f)).size, 'bytes'));
