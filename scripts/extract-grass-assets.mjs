import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const zipPath = 'C:/Users/Developartwo/.gemini/antigravity/brain/4f81d0e4-a157-4181-b1b9-cc0a31c2f374/.user_uploaded/media_1792680218324_d3628627.zip';
const tmpDir = path.resolve('tmp-grass');

if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

console.log('Extracting archive...');
execSync(`powershell -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'inherit' });

const grassDir = path.resolve('public/models/grass');
fs.mkdirSync(grassDir, { recursive: true });
const docsDir = path.resolve('docs/stage08terrain');
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
fs.copyFileSync(path.join(tmpDir, 'GRASS-ASSET-01', 'README.md'), path.join(docsDir, 'README_CLAUDE_GRASS.md'));

const srcPreviews = path.join(tmpDir, 'GRASS-ASSET-01', 'previews');
const destPreviews = path.join(docsDir, 'previews');
fs.cpSync(srcPreviews, destPreviews, { recursive: true });

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Successfully extracted ${glbCount} GLB files to public/models/grass:`);
fs.readdirSync(grassDir).forEach(f => console.log(' -', f, fs.statSync(path.join(grassDir, f)).size, 'bytes'));
