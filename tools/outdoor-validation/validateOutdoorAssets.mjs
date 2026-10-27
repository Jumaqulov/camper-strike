#!/usr/bin/env node
/**
 * BOSQICH 08A — OUTDOOR-ASSET-01 Binary GLB & Manifest QA Validator
 *
 * Inspects all 8 new outdoor GLB assets in `public/models/outdoor/` against
 * `tools/outdoor-validation/outdoor_asset_manifest.json` (git tarixidan tiklangan
 * OUTDOOR-ASSET-01 manifesti) and verifies the stage-08A GLB inventory across:
 *   - public/models/outdoor/   (8 GLB — OUTDOOR-ASSET-01)
 *   - public/models/forest/    (7 GLB — FOREST-ASSET-01)
 *   - public/models/weapons/   (4 GLB — WEAPON-ASSET-01)
 *   - public/models/buildings/ (8 GLB — BUILDING-ASSET-01)
 *   - public/models/loot/      (3 GLB — LOOT-ASSET-01)
 *   - public/models/interior/  (6 GLB — INTERIOR-ASSET-01)
 *
 * Performs binary-level glTF 2.0 validation:
 *   - 12-byte GLB header (magic 0x46546C67, version 2, byte length)
 *   - JSON chunk (0x4E4F534A) & BIN chunk (0x004E4942) framing
 *   - Exact byte size match against manifest `verification.glbBytes`
 *   - Accessor min/max vs actual float/uint binary buffer values
 *   - Vertex attributes POSITION, NORMAL, COLOR_0 on every primitive
 *   - Exact triangle & vertex counts (both glTF vertex stream and unique welded positions)
 *   - Exact mesh node names & order vs manifest
 *   - PBR material names (`wood`, `rock`/`stone`, `iron`, `fabric`, `painted_metal`) and metallic/roughness factors
 *   - World-space bounding box (`bounds.min`, `bounds.max`, `dimensions`) and ground sink (`minY`) check
 *   - Special anchor nodes & modular geometry checks:
 *     - `wooden_signpost_01`: 6 text anchor nodes (`sign_1..3_text_front/back`) position + quaternion
 *     - `campfire_pit_01`: `fire_anchor` at `[0, 0.15, 0]`
 *     - `wooden_railing_01`: `railing_post_start` separate mesh at `x = -1.5m` for 3.0m modular chaining
 *   - Zero embedded cameras, lights, animations, skins, or external textures
 *
 * Generates:
 *   tools/outdoor-validation/out/assets_qa.json  (git-ignored QA report)
 *
 * Eslatma: keyingi bosqichlarda qo'shilgan GLB'lar (grass/, characters/, knife.glb)
 * `extraWorkspaceGlbs` bo'limida faqat hisobga olinadi — ular bu validatorning
 * o'tish sharti emas.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

const GLB_MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK_TYPE = 0x4e4f534a; // 'JSON'
const BIN_CHUNK_TYPE = 0x004e4942; // 'BIN\0'

const COMPONENT_TYPE_BYTES = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const COMPONENT_TYPE_NAMES = {
  5120: 'BYTE',
  5121: 'UNSIGNED_BYTE',
  5122: 'SHORT',
  5123: 'UNSIGNED_SHORT',
  5125: 'UNSIGNED_INT',
  5126: 'FLOAT',
};

const TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const EXPECTED_PBR_MATERIALS = {
  wood: { metallicFactor: 0, roughnessFactor: 0.88, runtimeAlias: 'wood' },
  rock: { metallicFactor: 0, roughnessFactor: 0.93, runtimeAlias: 'stone' },
  stone: { metallicFactor: 0, roughnessFactor: 0.93, runtimeAlias: 'stone' },
  iron: { metallicFactor: 0.45, roughnessFactor: 0.6, runtimeAlias: 'iron' },
  painted_metal: { metallicFactor: 0.25, roughnessFactor: 0.72, runtimeAlias: 'painted_metal' },
  fabric: { metallicFactor: 0, roughnessFactor: 0.97, runtimeAlias: 'fabric' },
};

const PREVIOUS_GLB_INVENTORY = {
  forest: [
    'birch_tree_01.glb',
    'dead_tree_01.glb',
    'forest_bush_01.glb',
    'forest_rock_01.glb',
    'pine_tree_01.glb',
    'pine_tree_02.glb',
    'spruce_tree_01.glb',
  ],
  weapons: [
    'ak47.glb',
    'awp.glb',
    'pistol.glb',
    'shotgun.glb',
  ],
  buildings: [
    'wood_door_01.glb',
    'wood_floor_01.glb',
    'wood_roof_gable_01.glb',
    'wood_roof_slope_01.glb',
    'wood_stairs_01.glb',
    'wood_wall_01.glb',
    'wood_wall_door_01.glb',
    'wood_wall_window_01.glb',
  ],
  interior: [
    'kitchen_cabinet_01.glb',
    'old_bed_01.glb',
    'old_sofa_01.glb',
    'wooden_chair_01.glb',
    'wooden_shelf_01.glb',
    'wooden_table_01.glb',
  ],
  loot: [
    'metal_locker_01.glb',
    'old_toolbox_01.glb',
    'wooden_loot_crate_01.glb',
  ],
};

function round3(n) {
  const v = Math.round((n + Number.EPSILON) * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
}

function round4(n) {
  const v = Math.round((n + Number.EPSILON) * 10000) / 10000;
  return Object.is(v, -0) ? 0 : v;
}

function mat4Identity() {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

function mat4Multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function mat4FromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function quatFromMat4(m) {
  const m00 = m[0], m10 = m[1], m20 = m[2];
  const m01 = m[4], m11 = m[5], m21 = m[6];
  const m02 = m[8], m12 = m[9], m22 = m[10];
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return [round3(x), round3(y), round3(z), round3(w)];
}

function transformPoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function extractNodeTranslation(node) {
  if (Array.isArray(node.translation)) {
    return node.translation.map(round3);
  }
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return [round3(node.matrix[12]), round3(node.matrix[13]), round3(node.matrix[14])];
  }
  return [0, 0, 0];
}

function extractNodeQuaternion(node) {
  if (Array.isArray(node.rotation) && node.rotation.length === 4) {
    return node.rotation.map(round3);
  }
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return quatFromMat4(node.matrix);
  }
  return [0, 0, 0, 1];
}

function getLocalMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return node.matrix.slice();
  }
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return mat4FromTRS(t, q, s);
}

function parseGlbBinary(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`GLB file does not exist: ${filePath}`);
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length < 20) {
    throw new Error(`GLB file too small (${buf.length} bytes): ${filePath}`);
  }

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const totalLength = buf.readUInt32LE(8);

  const headerValid = magic === GLB_MAGIC && version === 2 && totalLength === buf.length;
  if (!headerValid) {
    throw new Error(
      `Invalid GLB header in ${filePath}: magic=0x${magic.toString(16)}, version=${version}, totalLength=${totalLength} (actual=${buf.length})`
    );
  }

  let offset = 12;
  let jsonChunk = null;
  let binChunk = null;
  let jsonChunkBytes = 0;

  while (offset < buf.length) {
    if (offset + 8 > buf.length) {
      throw new Error(`Truncated chunk header at offset ${offset} in ${filePath}`);
    }
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > buf.length) {
      throw new Error(`Chunk exceeds buffer length in ${filePath}`);
    }
    if (chunkType === JSON_CHUNK_TYPE && jsonChunk === null) {
      jsonChunkBytes = chunkLength;
      jsonChunk = JSON.parse(buf.subarray(chunkStart, chunkEnd).toString('utf8'));
    } else if (chunkType === BIN_CHUNK_TYPE && binChunk === null) {
      binChunk = buf.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd;
  }

  if (!jsonChunk) throw new Error(`Missing JSON chunk in ${filePath}`);
  if (!binChunk) throw new Error(`Missing BIN chunk in ${filePath}`);

  return {
    fileSizeBytes: buf.length,
    sha256,
    header: {
      magic: 'glTF',
      magicHex: `0x${magic.toString(16).toUpperCase()}`,
      version,
      totalLength,
      jsonChunkBytes,
      binChunkBytes: binChunk.length,
      valid: headerValid,
    },
    gltf: jsonChunk,
    bin: binChunk,
  };
}

function readAccessorValues(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  if (!accessor) throw new Error(`Invalid accessor index ${accessorIndex}`);
  const bufferView = gltf.bufferViews[accessor.bufferView];
  if (!bufferView) throw new Error(`Missing bufferView for accessor ${accessorIndex}`);

  const numComponents = TYPE_COMPONENTS[accessor.type];
  const bytesPerComponent = COMPONENT_TYPE_BYTES[accessor.componentType];
  if (!numComponents || !bytesPerComponent) {
    throw new Error(`Unsupported accessor type=${accessor.type} componentType=${accessor.componentType}`);
  }

  const elementSize = numComponents * bytesPerComponent;
  const byteStride = bufferView.byteStride || elementSize;
  const baseOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);

  const values = [];
  const computedMin = new Array(numComponents).fill(Infinity);
  const computedMax = new Array(numComponents).fill(-Infinity);

  for (let i = 0; i < accessor.count; i++) {
    const elemOffset = baseOffset + i * byteStride;
    const elem = new Array(numComponents);
    for (let c = 0; c < numComponents; c++) {
      const compOffset = elemOffset + c * bytesPerComponent;
      let val;
      switch (accessor.componentType) {
        case 5120:
          val = bin.readInt8(compOffset);
          if (accessor.normalized) val = Math.max(val / 127.0, -1.0);
          break;
        case 5121:
          val = bin.readUInt8(compOffset);
          if (accessor.normalized) val = val / 255.0;
          break;
        case 5122:
          val = bin.readInt16LE(compOffset);
          if (accessor.normalized) val = Math.max(val / 32767.0, -1.0);
          break;
        case 5123:
          val = bin.readUInt16LE(compOffset);
          if (accessor.normalized) val = val / 65535.0;
          break;
        case 5125:
          val = bin.readUInt32LE(compOffset);
          break;
        case 5126:
          val = bin.readFloatLE(compOffset);
          break;
        default:
          throw new Error(`Unsupported componentType ${accessor.componentType}`);
      }
      elem[c] = val;
      if (val < computedMin[c]) computedMin[c] = val;
      if (val > computedMax[c]) computedMax[c] = val;
    }
    values.push(numComponents === 1 ? elem[0] : elem);
  }

  let accessorMinMaxMatch = true;
  if (Array.isArray(accessor.min) && Array.isArray(accessor.max)) {
    for (let c = 0; c < numComponents; c++) {
      if (
        Math.abs(accessor.min[c] - computedMin[c]) > 1e-4 ||
        Math.abs(accessor.max[c] - computedMax[c]) > 1e-4
      ) {
        accessorMinMaxMatch = false;
      }
    }
  }

  return {
    accessor,
    values,
    computedMin,
    computedMax,
    accessorMinMaxMatch,
  };
}

function inspectGlbScene(gltf, bin) {
  const sceneIdx = gltf.scene ?? 0;
  const scene = gltf.scenes[sceneIdx];
  const nodes = gltf.nodes || [];
  const meshes = gltf.meshes || [];
  const materials = gltf.materials || [];

  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];
  const meshReports = [];
  const nodeHierarchy = [];
  const nodeByName = new Map();
  const uniquePositions = new Set();

  let totalTriangles = 0;
  let totalVertices = 0;
  let allHavePosition = true;
  let allHaveNormal = true;
  let allHaveColor0 = true;
  let allAccessorMinMaxValid = true;
  const colorComponentTypes = new Set();

  function visitNode(nodeIdx, parentMatrix, parentName = null, depth = 0) {
    const node = nodes[nodeIdx];
    const localMatrix = getLocalMatrix(node);
    const worldMatrix = mat4Multiply(parentMatrix, localMatrix);
    const translation = extractNodeTranslation(node);
    const quaternion = extractNodeQuaternion(node);

    const nodeInfo = {
      index: nodeIdx,
      name: node.name || `node_${nodeIdx}`,
      parent: parentName,
      depth,
      translation,
      quaternion,
      usesMatrixProperty: Array.isArray(node.matrix),
      hasMesh: node.mesh !== undefined,
      meshIndex: node.mesh ?? null,
      children: (node.children || []).map((cIdx) => nodes[cIdx]?.name || `node_${cIdx}`),
    };
    nodeHierarchy.push(nodeInfo);
    nodeByName.set(nodeInfo.name, { node, nodeInfo, worldMatrix });

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      let nodeTris = 0;
      let nodeVerts = 0;
      const nodeUniquePos = new Set();
      const nodeMaterials = [];
      const nodeMin = [Infinity, Infinity, Infinity];
      const nodeMax = [-Infinity, -Infinity, -Infinity];

      for (const prim of mesh.primitives || []) {
        const attrs = prim.attributes || {};
        const hasPos = attrs.POSITION !== undefined;
        const hasNorm = attrs.NORMAL !== undefined;
        const hasCol = attrs.COLOR_0 !== undefined;

        if (!hasPos) allHavePosition = false;
        if (!hasNorm) allHaveNormal = false;
        if (!hasCol) allHaveColor0 = false;

        if (hasPos) {
          const posData = readAccessorValues(gltf, bin, attrs.POSITION);
          if (!posData.accessorMinMaxMatch) allAccessorMinMaxValid = false;
          nodeVerts += posData.values.length;
          totalVertices += posData.values.length;

          for (const v of posData.values) {
            const wp = transformPoint(worldMatrix, v);
            const key = `${wp[0].toFixed(4)},${wp[1].toFixed(4)},${wp[2].toFixed(4)}`;
            uniquePositions.add(key);
            nodeUniquePos.add(key);
            for (let k = 0; k < 3; k++) {
              if (wp[k] < boundsMin[k]) boundsMin[k] = wp[k];
              if (wp[k] > boundsMax[k]) boundsMax[k] = wp[k];
              if (wp[k] < nodeMin[k]) nodeMin[k] = wp[k];
              if (wp[k] > nodeMax[k]) nodeMax[k] = wp[k];
            }
          }
        }

        if (hasNorm) {
          const normData = readAccessorValues(gltf, bin, attrs.NORMAL);
          if (normData.accessor.type !== 'VEC3' || normData.accessor.componentType !== 5126) {
            allHaveNormal = false;
          }
        }

        if (hasCol) {
          const colData = readAccessorValues(gltf, bin, attrs.COLOR_0);
          colorComponentTypes.add(
            `${colData.accessor.type}:${COMPONENT_TYPE_NAMES[colData.accessor.componentType]}`
          );
        }

        if (prim.indices !== undefined) {
          const idxData = readAccessorValues(gltf, bin, prim.indices);
          const tris = idxData.accessor.count / 3;
          nodeTris += tris;
          totalTriangles += tris;
        } else if (hasPos) {
          const posAcc = gltf.accessors[attrs.POSITION];
          const tris = posAcc.count / 3;
          nodeTris += tris;
          totalTriangles += tris;
        }

        if (prim.material !== undefined && materials[prim.material]) {
          nodeMaterials.push(materials[prim.material].name || `material_${prim.material}`);
        }
      }

      meshReports.push({
        nodeName: nodeInfo.name,
        parentName,
        triangles: nodeTris,
        vertices: nodeVerts,
        uniqueVertices: nodeUniquePos.size,
        materials: [...new Set(nodeMaterials)],
        boundsMin: nodeMin.map(round3),
        boundsMax: nodeMax.map(round3),
        dimensions: {
          x: round3(nodeMax[0] - nodeMin[0]),
          y: round3(nodeMax[1] - nodeMin[1]),
          z: round3(nodeMax[2] - nodeMin[2]),
        },
      });
    }

    for (const childIdx of node.children || []) {
      visitNode(childIdx, worldMatrix, nodeInfo.name, depth + 1);
    }
  }

  for (const rootIdx of scene.nodes || []) {
    visitNode(rootIdx, mat4Identity(), null, 0);
  }

  const dimensions = {
    x: round3(boundsMax[0] - boundsMin[0]),
    y: round3(boundsMax[1] - boundsMin[1]),
    z: round3(boundsMax[2] - boundsMin[2]),
  };

  const camerasCount = Array.isArray(gltf.cameras) ? gltf.cameras.length : 0;
  const lightsCount =
    (Array.isArray(gltf.lights) ? gltf.lights.length : 0) +
    (gltf.extensions?.KHR_lights_punctual?.lights?.length || 0);
  const animationsCount = Array.isArray(gltf.animations) ? gltf.animations.length : 0;
  const skinsCount = Array.isArray(gltf.skins) ? gltf.skins.length : 0;
  const texturesCount =
    (Array.isArray(gltf.textures) ? gltf.textures.length : 0) +
    (Array.isArray(gltf.images) ? gltf.images.length : 0);

  const materialDetails = materials.map((m) => {
    const expected = EXPECTED_PBR_MATERIALS[m.name] || null;
    const metallicFactor = m.pbrMetallicRoughness?.metallicFactor ?? null;
    const roughnessFactor = m.pbrMetallicRoughness?.roughnessFactor ?? null;
    const pbrFactorsMatch =
      expected !== null &&
      Math.abs((metallicFactor ?? 0) - expected.metallicFactor) < 1e-4 &&
      Math.abs((roughnessFactor ?? 0) - expected.roughnessFactor) < 1e-4;
    return {
      name: m.name,
      runtimeAlias: expected?.runtimeAlias || m.name,
      doubleSided: Boolean(m.doubleSided),
      metallicFactor,
      roughnessFactor,
      pbrFactorsMatch,
    };
  });

  return {
    rootNodeName: nodeHierarchy[0]?.name || null,
    boundsMin: boundsMin.map(round3),
    boundsMax: boundsMax.map(round3),
    dimensions,
    groundSinkY: round3(boundsMin[1]),
    totalTriangles,
    totalVertices,
    uniqueVertices: uniquePositions.size,
    allHavePosition,
    allHaveNormal,
    allHaveColor0,
    colorFormats: [...colorComponentTypes],
    allAccessorMinMaxValid,
    embeddedCounts: {
      cameras: camerasCount,
      lights: lightsCount,
      animations: animationsCount,
      skins: skinsCount,
      externalTextures: texturesCount,
    },
    noCamerasLightsAnimationsSkins:
      camerasCount === 0 &&
      lightsCount === 0 &&
      animationsCount === 0 &&
      skinsCount === 0 &&
      texturesCount === 0,
    materials: materials.map((m) => m.name),
    runtimeMaterials: materialDetails.map((m) => m.runtimeAlias),
    materialDetails,
    allMaterialsValidPbr: materialDetails.every((m) => m.pbrFactorsMatch),
    nodeHierarchy,
    meshReports,
    nodeByName,
  };
}

function validatePreviousInventory() {
  const categoryReports = {};
  let totalExistingCount = 0;
  let allExistingValid = true;
  const errors = [];

  for (const [category, files] of Object.entries(PREVIOUS_GLB_INVENTORY)) {
    const fileReports = [];
    for (const fileName of files) {
      const fullPath = path.join(ROOT_DIR, 'public/models', category, fileName);
      const exists = fs.existsSync(fullPath);
      let fileSizeBytes = 0;
      let headerValid = false;
      if (exists) {
        const parsed = parseGlbBinary(fullPath);
        fileSizeBytes = parsed.fileSizeBytes;
        headerValid = parsed.header.valid && fileSizeBytes > 0;
      }
      if (!exists || !headerValid) {
        allExistingValid = false;
        errors.push(`Missing or invalid existing GLB: public/models/${category}/${fileName}`);
      }
      totalExistingCount += 1;
      fileReports.push({
        fileName,
        publicUrl: `/models/${category}/${fileName}`,
        exists,
        fileSizeBytes,
        headerValid,
      });
    }
    categoryReports[category] = {
      expectedCount: files.length,
      verifiedCount: fileReports.filter((f) => f.exists && f.headerValid).length,
      allValid: fileReports.every((f) => f.exists && f.headerValid),
      files: fileReports,
    };
  }

  return {
    expectedExistingCount: 28,
    verifiedExistingCount: totalExistingCount,
    allExistingValid,
    categories: categoryReports,
    errors,
  };
}

function main() {
  const manifestPath = path.join(__dirname, 'outdoor_asset_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const errors = [];
  const modelReports = [];

  let totalBytes = 0;
  let totalTriangles = 0;
  let totalVertices = 0;
  let totalUniqueVertices = 0;
  let totalMeshes = 0;
  let totalAnchorNodes = 0;

  for (const entry of manifest.models) {
    const fileName = `${entry.name}.glb`;
    const publicPath = path.join(ROOT_DIR, 'public/models/outdoor', fileName);

    const parsed = parseGlbBinary(publicPath);
    const scene = inspectGlbScene(parsed.gltf, parsed.bin);

    totalBytes += parsed.fileSizeBytes;
    totalTriangles += scene.totalTriangles;
    totalVertices += scene.totalVertices;
    totalUniqueVertices += scene.uniqueVertices;
    totalMeshes += scene.meshReports.length;

    const bytesMatch = parsed.fileSizeBytes === entry.verification.glbBytes;
    const trianglesMatch = scene.totalTriangles === entry.triangles;
    const verticesMatch = scene.totalVertices === entry.triangles * 3;
    const meshNamesActual = scene.meshReports.map((m) => m.nodeName);
    const meshNamesMatch = JSON.stringify(meshNamesActual) === JSON.stringify(entry.meshes);
    const materialsMatch = JSON.stringify(scene.materials) === JSON.stringify(entry.materials);
    const vertexAttributesValid =
      scene.allHavePosition && scene.allHaveNormal && scene.allHaveColor0 && scene.allAccessorMinMaxValid;

    const boundsMinMatch = entry.boundingBox.min.every(
      (v, i) => Math.abs(v - scene.boundsMin[i]) <= 0.002
    );
    const boundsMaxMatch = entry.boundingBox.max.every(
      (v, i) => Math.abs(v - scene.boundsMax[i]) <= 0.002
    );
    const dimensionsMatch =
      Math.abs(entry.dimensions.x - scene.dimensions.x) <= 0.002 &&
      Math.abs(entry.dimensions.y - scene.dimensions.y) <= 0.002 &&
      Math.abs(entry.dimensions.z - scene.dimensions.z) <= 0.002;

    // Grounding check: bottom min.y should be in [-0.16, 0.0]m (either flush at 0 or slightly sunk into ground)
    const groundingValid = scene.groundSinkY >= -0.16 && scene.groundSinkY <= 0.001;

    // Validate special anchor nodes against manifest
    const anchorChecks = [];
    for (const expectedNode of entry.nodes || []) {
      const found = scene.nodeByName.get(expectedNode.name);
      if (!found) {
        anchorChecks.push({
          name: expectedNode.name,
          found: false,
          positionMatch: false,
          quaternionMatch: false,
        });
        continue;
      }
      const actualPos = found.nodeInfo.translation;
      const actualQuat = found.nodeInfo.quaternion;
      const posMatch = expectedNode.position.every(
        (v, i) => Math.abs(v - actualPos[i]) <= 0.002
      );
      const quatDot = Math.abs(
        expectedNode.quaternion[0] * actualQuat[0] +
        expectedNode.quaternion[1] * actualQuat[1] +
        expectedNode.quaternion[2] * actualQuat[2] +
        expectedNode.quaternion[3] * actualQuat[3]
      );
      const quatMatch = quatDot >= 0.999;

      totalAnchorNodes += 1;
      anchorChecks.push({
        name: expectedNode.name,
        found: true,
        expectedPosition: expectedNode.position,
        actualPosition: actualPos,
        positionMatch: posMatch,
        expectedQuaternion: expectedNode.quaternion,
        actualQuaternion: actualQuat,
        quaternionMatch: quatMatch,
        textArea: expectedNode.textArea || null,
      });
    }
    const anchorsValid = anchorChecks.every((a) => a.found && a.positionMatch && a.quaternionMatch);

    // Special modular check for wooden_railing_01 (`railing_post_start`)
    let modularRailingCheck = null;
    if (entry.name === 'wooden_railing_01') {
      const postMesh = scene.meshReports.find((m) => m.nodeName === 'railing_post_start');
      const bodyMesh = scene.meshReports.find((m) => m.nodeName === 'wooden_railing_01_body');
      const postCenterX = postMesh ? round3((postMesh.boundsMin[0] + postMesh.boundsMax[0]) * 0.5) : null;
      const bodySpanX = bodyMesh ? round3(bodyMesh.boundsMax[0] - bodyMesh.boundsMin[0]) : null;
      modularRailingCheck = {
        hasSeparateStartPostMesh: Boolean(postMesh),
        startPostCenterX: postCenterX,
        startPostBoundsMin: postMesh?.boundsMin || null,
        startPostBoundsMax: postMesh?.boundsMax || null,
        bodySpanX,
        modularStepM: 3.0,
        valid: Boolean(postMesh) && Math.abs(postCenterX - -1.5) <= 0.01 && Math.abs(bodySpanX - 3.0) <= 0.01,
      };
      if (!modularRailingCheck.valid) {
        errors.push(`Modular railing check failed for wooden_railing_01`);
      }
    }

    const modelPassed =
      parsed.header.valid &&
      bytesMatch &&
      trianglesMatch &&
      verticesMatch &&
      meshNamesMatch &&
      materialsMatch &&
      scene.allMaterialsValidPbr &&
      vertexAttributesValid &&
      boundsMinMatch &&
      boundsMaxMatch &&
      dimensionsMatch &&
      groundingValid &&
      anchorsValid &&
      scene.noCamerasLightsAnimationsSkins &&
      (modularRailingCheck ? modularRailingCheck.valid : true);

    if (!modelPassed) {
      errors.push(
        `Validation mismatch on ${entry.assetId} (${entry.name}): ` +
          JSON.stringify({
            headerValid: parsed.header.valid,
            bytesMatch,
            trianglesMatch,
            verticesMatch,
            meshNamesMatch,
            materialsMatch,
            allMaterialsValidPbr: scene.allMaterialsValidPbr,
            vertexAttributesValid,
            boundsMinMatch,
            boundsMaxMatch,
            dimensionsMatch,
            groundingValid,
            anchorsValid,
            noCamerasLightsAnimationsSkins: scene.noCamerasLightsAnimationsSkins,
          })
      );
    }

    modelReports.push({
      assetId: entry.assetId,
      name: entry.name,
      publicUrl: `/models/outdoor/${fileName}`,
      fileSizeBytes: parsed.fileSizeBytes,
      expectedBytes: entry.verification.glbBytes,
      bytesMatch,
      sha256: parsed.sha256,
      header: parsed.header,
      poi: entry.poi,
      role: entry.role,
      originDescription: entry.origin,
      triangles: scene.totalTriangles,
      expectedTriangles: entry.triangles,
      trianglesMatch,
      vertices: scene.totalVertices,
      uniqueVertices: scene.uniqueVertices,
      verticesMatch,
      meshNames: meshNamesActual,
      expectedMeshNames: entry.meshes,
      meshNamesMatch,
      meshes: scene.meshReports,
      materials: scene.materials,
      runtimeMaterials: scene.runtimeMaterials,
      expectedMaterials: entry.materials,
      materialsMatch,
      materialDetails: scene.materialDetails,
      allMaterialsValidPbr: scene.allMaterialsValidPbr,
      vertexAttributes: {
        POSITION: scene.allHavePosition,
        NORMAL: scene.allHaveNormal,
        COLOR_0: scene.allHaveColor0,
        colorFormats: scene.colorFormats,
        accessorMinMaxMatch: scene.allAccessorMinMaxValid,
        valid: vertexAttributesValid,
      },
      bounds: {
        min: scene.boundsMin,
        max: scene.boundsMax,
        expectedMin: entry.boundingBox.min,
        expectedMax: entry.boundingBox.max,
        dimensions: scene.dimensions,
        expectedDimensions: entry.dimensions,
        groundSinkY: scene.groundSinkY,
        boundsMinMatch,
        boundsMaxMatch,
        dimensionsMatch,
        groundingValid,
      },
      anchorNodes: anchorChecks,
      anchorsValid,
      modularRailingCheck,
      colliders: entry.colliders,
      clearance: entry.clearance,
      embeddedCounts: scene.embeddedCounts,
      noCamerasLightsAnimationsSkins: scene.noCamerasLightsAnimationsSkins,
      passed: modelPassed,
    });
  }

  const inventoryReport = validatePreviousInventory();
  if (!inventoryReport.allExistingValid) {
    errors.push(...inventoryReport.errors);
  }

  const totalWorkspaceGlbs = inventoryReport.verifiedExistingCount + modelReports.length;
  // Stage 08A dan keyin qo'shilgan GLB'lar (faqat ma'lumot uchun; o'tish sharti emas)
  const stage08aKnown = new Set([
    ...Object.entries(PREVIOUS_GLB_INVENTORY).flatMap(([cat, files]) => files.map((f) => `${cat}/${f}`)),
    ...modelReports.map((m) => `outdoor/${m.fileName}`),
  ]);
  const modelsRoot = path.join(ROOT_DIR, 'public/models');
  const allWorkspaceGlbs = fs
    .readdirSync(modelsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(modelsRoot, d.name)).filter((f) => f.endsWith('.glb')).map((f) => `${d.name}/${f}`))
    .sort();
  const extraWorkspaceGlbs = allWorkspaceGlbs.filter((f) => !stage08aKnown.has(f));
  const allPassed =
    errors.length === 0 &&
    modelReports.length === 8 &&
    modelReports.every((m) => m.passed) &&
    inventoryReport.allExistingValid &&
    totalWorkspaceGlbs === 36;

  const qaReport = {
    stage: '08A',
    assetPack: manifest.assetPack,
    generatedAt: new Date().toISOString(),
    validatorScript: 'tools/outdoor-validation/validateOutdoorAssets.mjs',
    manifestPath: 'tools/outdoor-validation/outdoor_asset_manifest.json',
    allPassed,
    summary: {
      outdoorModelsVerified: modelReports.length,
      outdoorModelsPassed: modelReports.filter((m) => m.passed).length,
      totalOutdoorBytes: totalBytes,
      totalOutdoorTriangles: totalTriangles,
      totalOutdoorVertices: totalVertices,
      totalOutdoorUniqueVertices: totalUniqueVertices,
      totalOutdoorMeshes: totalMeshes,
      totalOutdoorAnchorNodes: totalAnchorNodes,
      previousGlbCount: inventoryReport.verifiedExistingCount,
      totalWorkspaceGlbCount: totalWorkspaceGlbs,
      actualWorkspaceGlbCount: allWorkspaceGlbs.length,
      zeroCamerasLightsAnimationsSkins: modelReports.every((m) => m.noCamerasLightsAnimationsSkins),
      allVertexColorsPresent: modelReports.every((m) => m.vertexAttributes.valid),
    },
    pbrMaterialCatalog: EXPECTED_PBR_MATERIALS,
    models: modelReports,
    workspaceGlbInventory: {
      previousExisting: inventoryReport,
      outdoorStage08aCount: modelReports.length,
      totalGlbFiles: totalWorkspaceGlbs,
      actualGlbFiles: allWorkspaceGlbs.length,
      extraWorkspaceGlbs,
    },
    errors,
  };

  const outPath = path.join(__dirname, 'out', 'assets_qa.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(qaReport, null, 2) + '\n', 'utf8');

  console.log(`[Stage 08A QA] Validated ${modelReports.length}/8 outdoor GLB models.`);
  console.log(
    `[Stage 08A QA] Total outdoor geometry: ${totalTriangles} triangles, ${totalVertices} glTF vertices (${totalUniqueVertices} unique positions), ${totalBytes} bytes.`
  );
  console.log(
    `[Stage 08A QA] Workspace GLB inventory: ${inventoryReport.verifiedExistingCount} existing + ${modelReports.length} outdoor = ${totalWorkspaceGlbs} total GLB files.`
  );
  console.log(`[Stage 08A QA] Stage-08A dan keyin qo'shilgan GLB'lar: ${extraWorkspaceGlbs.length} ta (jami public/models: ${allWorkspaceGlbs.length}).`);
  console.log(`[Stage 08A QA] Wrote QA report to: ${outPath}`);
  console.log(`[Stage 08A QA] allPassed = ${allPassed}`);

  if (!allPassed) {
    console.error('[Stage 08A QA] Validation failed:', errors);
    process.exit(1);
  }
}

main();
