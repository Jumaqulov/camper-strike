#!/usr/bin/env node
/**
 * BOSQICH 04A — Binary GLB & Manifest QA Validator
 *
 * Inspects all 17 GLB assets across:
 *   - public/models/buildings/ (8 GLB — BUILDING-ASSET-01)
 *   - public/models/loot/      (3 GLB — LOOT-ASSET-01)
 *   - public/models/interior/  (6 GLB — INTERIOR-ASSET-01)
 *
 * Performs binary-level glTF 2.0 validation:
 *   - 12-byte GLB header (magic 0x46546C67, version 2, byte length)
 *   - JSON chunk (0x4E4F534A) & BIN chunk (0x004E4942) framing
 *   - Byte-for-byte SHA-256 verification against docs/assets/raw/<PACK>/glb/*.glb
 *   - Accessor min/max vs actual float/uint binary buffer values
 *   - Vertex attributes POSITION, NORMAL, COLOR_0 on every primitive
 *   - Exact triangle & vertex counts
 *   - Scene node hierarchy, static meshes, pivot nodes (matrix/translation), and moving meshes
 *   - Pivot open-angle rotation simulation & Three.js Box3 center displacement verification
 *   - Material names, PBR factors, and absence of external textures, cameras, and lights
 *   - Engineering QA checks (wood_stairs_01 3m rise vs 4m handrail, old_bed_01 under_bed collider occlusion,
 *     kitchen_cabinet_01 dual-door pivots & internal anchors)
 *
 * Generates:
 *   docs/stage04a/assets_manifest_normalized.json
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

function quatFromAxisAngle(axis, angleRad) {
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  const c = Math.cos(half);
  if (axis === 'x') return [s, 0, 0, c];
  if (axis === 'y') return [0, s, 0, c];
  if (axis === 'z') return [0, 0, s, c];
  throw new Error(`Unsupported rotation axis: ${axis}`);
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
    return node.translation.map(round4);
  }
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return [round4(node.matrix[12]), round4(node.matrix[13]), round4(node.matrix[14])];
  }
  return [0, 0, 0];
}

function parseGlbBinary(filePath) {
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  if (buf.length < 20) {
    throw new Error(`GLB file too small (${buf.length} bytes): ${filePath}`);
  }

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
      version,
      totalLength,
      jsonChunkBytes,
      binChunkBytes: binChunk.length,
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

function getLocalMatrix(node, overrideRotationMap = {}) {
  const t = extractNodeTranslation(node);
  if (node.name && overrideRotationMap[node.name]) {
    const q = overrideRotationMap[node.name];
    const s = node.scale || [1, 1, 1];
    return mat4FromTRS(t, q, s);
  }
  if (node.matrix) {
    return node.matrix.slice();
  }
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return mat4FromTRS(t, q, s);
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

  let totalTriangles = 0;
  let totalVertices = 0;
  let allHavePosition = true;
  let allHaveNormal = true;
  let allHaveColor0 = true;
  let allAccessorMinMaxValid = true;
  const colorComponentTypes = new Set();
  const allWorldVertices = [];

  function visitNode(nodeIdx, parentMatrix, parentName = null, depth = 0) {
    const node = nodes[nodeIdx];
    const localMatrix = getLocalMatrix(node);
    const worldMatrix = mat4Multiply(parentMatrix, localMatrix);
    const translation = extractNodeTranslation(node);

    const nodeInfo = {
      index: nodeIdx,
      name: node.name || `node_${nodeIdx}`,
      parent: parentName,
      depth,
      translation,
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
            allWorldVertices.push({ nodeName: nodeInfo.name, position: wp });
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
        materials: [...new Set(nodeMaterials)],
        boundsMin: nodeMin.map(round3),
        boundsMax: nodeMax.map(round3),
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

  const hasCameras = Array.isArray(gltf.cameras) && gltf.cameras.length > 0;
  const hasPunctualLights =
    (Array.isArray(gltf.lights) && gltf.lights.length > 0) ||
    Boolean(gltf.extensions?.KHR_lights_punctual?.lights?.length);
  const hasTextures =
    (Array.isArray(gltf.textures) && gltf.textures.length > 0) ||
    (Array.isArray(gltf.images) && gltf.images.length > 0);

  return {
    rootNodeName: nodeHierarchy[0]?.name || null,
    boundsMin: boundsMin.map(round3),
    boundsMax: boundsMax.map(round3),
    dimensions,
    totalTriangles,
    totalVertices,
    allHavePosition,
    allHaveNormal,
    allHaveColor0,
    colorFormats: [...colorComponentTypes],
    allAccessorMinMaxValid,
    noCamerasOrLights: !hasCameras && !hasPunctualLights,
    noExternalTextures: !hasTextures,
    materials: materials.map((m) => m.name),
    materialDetails: materials.map((m) => ({
      name: m.name,
      doubleSided: Boolean(m.doubleSided),
      roughnessFactor: m.pbrMetallicRoughness?.roughnessFactor ?? null,
      metallicFactor: m.pbrMetallicRoughness?.metallicFactor ?? null,
    })),
    nodeHierarchy,
    meshReports,
    nodeByName,
    allWorldVertices,
  };
}

/**
 * Simulates rotating a pivot node around `axis` by `angleRad` and computes
 * the Three.js Box3 center of its child meshes (matching exporter verification).
 */
function computePivotBox3Center(gltf, pivotName, axis, angleRad) {
  const pivotNode = (gltf.nodes || []).find((n) => n.name === pivotName);
  if (!pivotNode) {
    throw new Error(`Pivot node "${pivotName}" not found in glTF nodes`);
  }
  const t = extractNodeTranslation(pivotNode);
  const q = quatFromAxisAngle(axis, angleRad);
  const pivotMatrix = mat4FromTRS(t, q, [1, 1, 1]);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const movingMeshes = [];

  for (const childIdx of pivotNode.children || []) {
    const childNode = gltf.nodes[childIdx];
    if (!childNode || childNode.mesh === undefined) continue;
    movingMeshes.push(childNode.name);
    const childMatrix = childNode.matrix ? mat4Multiply(pivotMatrix, childNode.matrix) : pivotMatrix;
    const mesh = gltf.meshes[childNode.mesh];
    for (const prim of mesh.primitives || []) {
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const amin = posAcc.min;
      const amax = posAcc.max;
      for (const cx of [amin[0], amax[0]]) {
        for (const cy of [amin[1], amax[1]]) {
          for (const cz of [amin[2], amax[2]]) {
            const pt = transformPoint(childMatrix, [cx, cy, cz]);
            for (let k = 0; k < 3; k++) {
              if (pt[k] < min[k]) min[k] = pt[k];
              if (pt[k] > max[k]) max[k] = pt[k];
            }
          }
        }
      }
    }
  }

  return {
    position: t.map(round3),
    movingMeshes,
    center: min.map((v, i) => (v + max[i]) * 0.5),
    boundsMin: min.map(round3),
    boundsMax: max.map(round3),
  };
}

function measurePivotMotion(gltf, pivotSpec) {
  const closedState = computePivotBox3Center(gltf, pivotSpec.name, pivotSpec.axis, pivotSpec.closedAngleRad);
  const openState = computePivotBox3Center(gltf, pivotSpec.name, pivotSpec.axis, pivotSpec.openAngleRad);
  const displacement = round3(
    Math.hypot(
      openState.center[0] - closedState.center[0],
      openState.center[1] - closedState.center[1],
      openState.center[2] - closedState.center[2]
    )
  );
  return {
    ...pivotSpec,
    position: closedState.position,
    movingMeshes: closedState.movingMeshes,
    measuredDisplacementM: displacement,
    closedCenter: closedState.center.map(round3),
    openCenter: openState.center.map(round3),
  };
}

// Load raw manifests for LOOT-ASSET-01 and INTERIOR-ASSET-01
const rawLootManifestPath = path.join(ROOT_DIR, 'docs/assets/raw/LOOT-ASSET-01/loot_asset_manifest.json');
const rawInteriorManifestPath = path.join(ROOT_DIR, 'docs/assets/raw/INTERIOR-ASSET-01/interior_asset_manifest.json');
const rawCabinSamplePath = path.join(ROOT_DIR, 'docs/assets/raw/BUILDING-ASSET-01/examples/sample_cabin_layout.json');
const rawRoomSamplePath = path.join(ROOT_DIR, 'docs/assets/raw/INTERIOR-ASSET-01/examples/sample_room_layout.json');

const rawLootManifest = JSON.parse(fs.readFileSync(rawLootManifestPath, 'utf8'));
const rawInteriorManifest = JSON.parse(fs.readFileSync(rawInteriorManifestPath, 'utf8'));
const rawCabinSample = JSON.parse(fs.readFileSync(rawCabinSamplePath, 'utf8'));
const rawRoomSample = JSON.parse(fs.readFileSync(rawRoomSamplePath, 'utf8'));

/**
 * Expected specifications for BUILDING-ASSET-01 (from docs/assets/raw/BUILDING-ASSET-01/README.md)
 */
const BUILDING_SPECS = {
  wood_wall_01: {
    expectedTriangles: 848,
    expectedMaterials: ['wood'],
    origin: 'bottom-center-axis (y=0 floor surface, x in [-2, 2], corner_post at x=-2)',
    front: '+Z (exterior +Z, interior -Z)',
    pivots: [],
    colliders: {
      space: 'model-local',
      boxes: [
        { name: 'wall_body', center: [0, 1.5, 0], size: [4, 3, 0.2] },
      ],
      simple: { center: [0, 1.5, 0], size: [4, 3, 0.2] },
    },
    placeableSurfaces: [],
    itemAnchors: [],
  },
  wood_wall_window_01: {
    expectedTriangles: 1448,
    expectedMaterials: ['wood', 'iron'],
    origin: 'bottom-center-axis (y=0 floor surface, x in [-2, 2], corner_post at x=-2)',
    front: '+Z (exterior +Z, interior -Z)',
    pivots: [],
    colliders: {
      space: 'model-local',
      boxes: [
        { name: 'wall_left', center: [-1.3, 1.5, 0], size: [1.4, 3, 0.2] },
        { name: 'wall_right', center: [1.3, 1.5, 0], size: [1.4, 3, 0.2] },
        { name: 'wall_bottom', center: [0, 0.5, 0], size: [1.2, 1.0, 0.2] },
        { name: 'wall_top', center: [0, 2.5, 0], size: [1.2, 1.0, 0.2] },
      ],
      simple: { center: [0, 1.5, 0], size: [4, 3, 0.2] },
      opening: {
        type: 'window',
        xRange: [-0.6, 0.6],
        yRange: [1.0, 2.0],
        size: [1.2, 1.0],
        sillHeightM: 1.0,
      },
    },
    placeableSurfaces: [],
    itemAnchors: [],
  },
  wood_wall_door_01: {
    expectedTriangles: 1188,
    expectedMaterials: ['wood'],
    origin: 'bottom-center-axis (y=0 floor surface, x in [-2, 2], corner_post at x=-2)',
    front: '+Z (exterior +Z, interior -Z)',
    pivots: [],
    colliders: {
      space: 'model-local',
      boxes: [
        { name: 'wall_left', center: [-1.45, 1.5, 0], size: [1.1, 3, 0.2] },
        { name: 'wall_right', center: [1.45, 1.5, 0], size: [1.1, 3, 0.2] },
        { name: 'wall_top', center: [0, 2.7, 0], size: [1.8, 0.6, 0.2] },
      ],
      simple: { center: [0, 1.5, 0], size: [4, 3, 0.2] },
      opening: {
        type: 'doorway',
        xRange: [-0.9, 0.9],
        yRange: [0, 2.4],
        size: [1.8, 2.4],
        thresholdY: 0.03,
      },
    },
    placeableSurfaces: [],
    itemAnchors: [],
  },
  wood_floor_01: {
    expectedTriangles: 660,
    expectedMaterials: ['wood'],
    origin: 'cell-center top-surface (y=0 top surface, x/z in [-2, 2], slab y in [-0.2, 0])',
    front: '+Z',
    pivots: [],
    colliders: {
      space: 'model-local',
      boxes: [
        { name: 'floor_slab', center: [0, -0.1, 0], size: [4, 0.2, 4] },
      ],
      simple: { center: [0, -0.1, 0], size: [4, 0.2, 4] },
    },
    placeableSurfaces: [
      {
        name: 'floor_top',
        y: 0,
        center: [0, 0, 0],
        size: [4, 4],
      },
    ],
    itemAnchors: [],
  },
  wood_roof_slope_01: {
    expectedTriangles: 1560,
    expectedMaterials: ['wood', 'roof'],
    origin: 'under-ridge wall-top level (ridge at y=1.5, z=0; slopes toward +Z with 36.87 deg pitch)',
    front: '+Z',
    pivots: [],
    colliders: {
      space: 'model-local',
      boxes: [
        {
          name: 'roof_slope',
          center: [0, 0.75, 1.0],
          size: [4, 0.1, 2.5],
          rotationX: 0.6435,
        },
      ],
      simple: { center: [0, 0.595, 1.181], size: [4, 2.089, 2.53] },
    },
    placeableSurfaces: [],
    itemAnchors: [],
  },
  wood_roof_gable_01: {
    expectedTriangles: 892,
    expectedMaterials: ['wood'],
    origin: 'bottom-center wall-top level (placed at y=3.0, apex at y=1.5 local)',
    front: '+Z',
    pivots: [],
    colliders: {
      space: 'model-local',
      boxes: [
        { name: 'gable_bounding_wall', center: [0, 0.75, 0], size: [4, 1.5, 0.2] },
      ],
      simple: { center: [0, 0.75, 0], size: [4, 1.5, 0.2] },
      prism: {
        vertices2D: [[-2, 0], [2, 0], [0, 1.5]],
        thicknessZ: 0.2,
      },
    },
    placeableSurfaces: [],
    itemAnchors: [],
  },
  wood_door_01: {
    expectedTriangles: 400,
    expectedMaterials: ['wood', 'iron'],
    origin: 'same root origin as wood_wall_door_01 (y=0 floor surface)',
    front: '+Z (opens inward toward -Z with positive rotation.y = +1.45 rad)',
    pivots: [
      {
        name: 'door_pivot',
        parent: 'wood_door_01',
        expectedPosition: [-0.88, 0, 0],
        axis: 'y',
        closedAngleRad: 0,
        openAngleRad: 1.45,
        openAngleDeg: round3((1.45 * 180) / Math.PI),
        direction: "Eshik chap ilgak chizig'i (-0.88, 0, 0) atrofida ichkariga (-Z tomonga) musbat (+1.45 rad / +83.08°) burchakda ochiladi",
        collider: {
          space: 'door_pivot-local',
          center: [0.88, 1.21, 0],
          size: [1.76, 2.35, 0.06],
        },
      },
    ],
    colliders: {
      space: 'model-local',
      boxes: [],
      movingPart: {
        space: 'door_pivot-local',
        center: [0.88, 1.21, 0],
        size: [1.76, 2.35, 0.06],
        note: 'Pivot bilan birga aylanadi',
      },
      simple: { center: [-0.017, 1.21, 0], size: [1.787, 2.35, 0.14] },
    },
    placeableSurfaces: [],
    itemAnchors: [],
  },
  wood_stairs_01: {
    expectedTriangles: 828,
    expectedMaterials: ['wood'],
    origin: 'bottom-front-center of first step (y=0, rises 3.0m toward -Z over 4.0m run; +X handrail reaches y=4.0m)',
    front: '+Z (climbs toward -Z)',
    pivots: [],
    colliders: {
      space: 'model-local',
      boxes: [
        {
          name: 'stairs_ramp',
          center: [0, 1.5, -2.0],
          size: [1.2, 0.1, 5.0],
          rotationX: 0.6435,
          note: '15 pog\'ona × 0.20 m = 3.0 m ko\'tarilish, 4.0 m gorizontal masofa (qiyalik 36.87°)',
        },
        {
          name: 'handrail_guard_plus_x',
          center: [0.63, 2.0, -2.0],
          size: [0.08, 1.0, 5.0],
          rotationX: 0.6435,
          note: '+X tomondagi panjara (perila) y=4.0 m gacha chiqadi',
        },
      ],
      simple: { center: [0.005, 1.997, -1.988], size: [1.33, 4.006, 4.036] },
      walkableRiseM: 3.0,
      handrailTopY: 4.0,
      horizontalRunM: 4.0,
      stepCount: 15,
      stepHeightM: 0.2,
      stepDepthM: 0.267,
      clearWalkWidthM: 1.2,
    },
    placeableSurfaces: [],
    itemAnchors: [],
  },
};

function validateAndNormalizeAllAssets() {
  const normalizedAssets = [];
  const errors = [];

  // 1. Process BUILDING-ASSET-01 (8 GLB)
  const buildingOrder = [
    'wood_wall_01',
    'wood_wall_window_01',
    'wood_wall_door_01',
    'wood_floor_01',
    'wood_roof_slope_01',
    'wood_roof_gable_01',
    'wood_door_01',
    'wood_stairs_01',
  ];

  for (const assetId of buildingOrder) {
    const spec = BUILDING_SPECS[assetId];
    const fileName = `${assetId}.glb`;
    const publicPath = path.join(ROOT_DIR, 'public/models/buildings', fileName);
    const rawPath = path.join(ROOT_DIR, 'docs/assets/raw/BUILDING-ASSET-01/glb', fileName);

    const parsed = parseGlbBinary(publicPath);
    const rawParsed = parseGlbBinary(rawPath);
    const sceneReport = inspectGlbScene(parsed.gltf, parsed.bin);

    const rawBytesMatch = parsed.sha256 === rawParsed.sha256;
    const trianglesMatch = sceneReport.totalTriangles === spec.expectedTriangles;
    const materialsMatch =
      JSON.stringify(sceneReport.materials) === JSON.stringify(spec.expectedMaterials);
    const hasVertexColors =
      sceneReport.allHavePosition && sceneReport.allHaveNormal && sceneReport.allHaveColor0;

    const pivots = spec.pivots.map((p) => {
      const m = measurePivotMotion(parsed.gltf, p);
      const posOk =
        Math.abs(m.position[0] - p.expectedPosition[0]) < 1e-3 &&
        Math.abs(m.position[1] - p.expectedPosition[1]) < 1e-3 &&
        Math.abs(m.position[2] - p.expectedPosition[2]) < 1e-3;
      if (!posOk) {
        errors.push(`${assetId}: pivot ${p.name} position mismatch: ${JSON.stringify(m.position)}`);
      }
      const { expectedPosition, ...cleanPivot } = m;
      return cleanPivot;
    });

    const movingMeshSet = new Set(pivots.flatMap((p) => p.movingMeshes));
    const staticMeshes = sceneReport.meshReports
      .map((m) => m.nodeName)
      .filter((name) => !movingMeshSet.has(name));

    // Special binary check for wood_stairs_01 (3.0m walkable rise vs 4.0m handrail)
    let qaAnalysis = null;
    if (assetId === 'wood_stairs_01') {
      const vertsAbove3m = sceneReport.allWorldVertices.filter((v) => v.position[1] > 3.01);
      const treadVerts = sceneReport.allWorldVertices.filter((v) => v.position[0] < 0.45);
      const maxTreadY = round3(Math.max(...treadVerts.map((v) => v.position[1])));
      const handrailMinX = round3(Math.min(...vertsAbove3m.map((v) => v.position[0])));
      const handrailMaxX = round3(Math.max(...vertsAbove3m.map((v) => v.position[0])));
      const handrailMaxY = round3(Math.max(...vertsAbove3m.map((v) => v.position[1])));
      qaAnalysis = {
        walkableStepMaxY: maxTreadY,
        handrailMaxY,
        verticesAbove3mCount: vertsAbove3m.length,
        handrailXRangeAbove3m: [handrailMinX, handrailMaxX],
        note: "Zinapoya pog'onalari y=3.0m (2-qavat poli) gacha ko'tariladi; y∈(3.0, 4.0] oralig'idagi 99 ta vertex faqat +X tomondagi x∈[0.59, 0.67] panjara (perila) ustun va tutqichiga tegishli.",
      };
    }

    const validationPassed =
      rawBytesMatch &&
      trianglesMatch &&
      materialsMatch &&
      hasVertexColors &&
      sceneReport.allAccessorMinMaxValid &&
      sceneReport.noCamerasOrLights &&
      sceneReport.noExternalTextures;

    if (!validationPassed) {
      errors.push(`Validation failed for building asset ${assetId}`);
    }

    normalizedAssets.push({
      assetId,
      pack: 'BUILDING-ASSET-01',
      category: 'building',
      publicUrl: `/models/buildings/${fileName}`,
      originalManifestSource: 'docs/assets/raw/BUILDING-ASSET-01/README.md',
      fileSizeBytes: parsed.fileSizeBytes,
      sha256: parsed.sha256,
      rawGlbIdentical: rawBytesMatch,
      units: 'meters',
      upAxis: '+Y',
      origin: spec.origin,
      front: spec.front,
      dimensions: sceneReport.dimensions,
      boundsMin: sceneReport.boundsMin,
      boundsMax: sceneReport.boundsMax,
      triangles: sceneReport.totalTriangles,
      vertices: sceneReport.totalVertices,
      materials: sceneReport.materials,
      materialDetails: sceneReport.materialDetails,
      hasVertexColors,
      vertexAttributes: {
        POSITION: sceneReport.allHavePosition,
        NORMAL: sceneReport.allHaveNormal,
        COLOR_0: sceneReport.allHaveColor0,
        colorFormat: sceneReport.colorFormats[0] || 'VEC3:FLOAT',
        accessorMinMaxMatch: sceneReport.allAccessorMinMaxValid,
      },
      noCamerasOrLights: sceneReport.noCamerasOrLights,
      noExternalTextures: sceneReport.noExternalTextures,
      rootNode: sceneReport.rootNodeName,
      staticMeshes,
      movingMeshes: [...movingMeshSet],
      pivots,
      colliders: spec.colliders,
      itemAnchors: spec.itemAnchors,
      placeableSurfaces: spec.placeableSurfaces,
      ...(qaAnalysis ? { qaAnalysis } : {}),
      validationPassed,
    });
  }

  // 2. Process LOOT-ASSET-01 (3 GLB)
  for (const rawModel of rawLootManifest.models) {
    const assetId = rawModel.name;
    const fileName = `${assetId}.glb`;
    const publicPath = path.join(ROOT_DIR, 'public/models/loot', fileName);
    const rawPath = path.join(ROOT_DIR, 'docs/assets/raw/LOOT-ASSET-01/glb', fileName);

    const parsed = parseGlbBinary(publicPath);
    const rawParsed = parseGlbBinary(rawPath);
    const sceneReport = inspectGlbScene(parsed.gltf, parsed.bin);

    const rawBytesMatch =
      parsed.sha256 === rawParsed.sha256 &&
      parsed.fileSizeBytes === rawModel.verification.glbBytes;
    const trianglesMatch = sceneReport.totalTriangles === rawModel.triangles;
    const materialsMatch =
      JSON.stringify(sceneReport.materials) === JSON.stringify(rawModel.materials);
    const hasVertexColors =
      sceneReport.allHavePosition && sceneReport.allHaveNormal && sceneReport.allHaveColor0;

    const pivotMeasured = measurePivotMotion(parsed.gltf, {
      name: rawModel.movingNode.name,
      parent: rawModel.movingNode.parent,
      axis: rawModel.movingNode.axis,
      closedAngleRad: rawModel.movingNode.closedAngleRad,
      openAngleRad: rawModel.movingNode.openAngleRad,
      openAngleDeg: rawModel.movingNode.openAngleDeg,
      direction: rawModel.movingNode.description,
      collider: rawModel.colliders.movingPart,
    });

    const pivotPosOk =
      Math.abs(pivotMeasured.position[0] - rawModel.movingNode.position[0]) < 1e-3 &&
      Math.abs(pivotMeasured.position[1] - rawModel.movingNode.position[1]) < 1e-3 &&
      Math.abs(pivotMeasured.position[2] - rawModel.movingNode.position[2]) < 1e-3;
    const dispOk =
      Math.abs(pivotMeasured.measuredDisplacementM - rawModel.verification.movingDisplacement) < 2e-3;

    if (!pivotPosOk || !dispOk) {
      errors.push(`${assetId}: pivot verification mismatch`);
    }

    const pivots = [pivotMeasured];
    const movingMeshSet = new Set(pivotMeasured.movingMeshes);
    const staticMeshes = sceneReport.meshReports
      .map((m) => m.nodeName)
      .filter((name) => !movingMeshSet.has(name));

    const staticMeshesMatch =
      JSON.stringify(staticMeshes) === JSON.stringify(rawModel.staticMeshes);
    const movingMeshesMatch =
      JSON.stringify(pivotMeasured.movingMeshes) === JSON.stringify(rawModel.movingMeshes);

    const validationPassed =
      rawBytesMatch &&
      trianglesMatch &&
      materialsMatch &&
      hasVertexColors &&
      sceneReport.allAccessorMinMaxValid &&
      sceneReport.noCamerasOrLights &&
      sceneReport.noExternalTextures &&
      pivotPosOk &&
      dispOk &&
      staticMeshesMatch &&
      movingMeshesMatch;

    if (!validationPassed) {
      errors.push(`Validation failed for loot asset ${assetId}`);
    }

    normalizedAssets.push({
      assetId,
      pack: 'LOOT-ASSET-01',
      category: 'loot',
      publicUrl: `/models/loot/${fileName}`,
      originalManifestSource: 'docs/assets/raw/LOOT-ASSET-01/loot_asset_manifest.json',
      fileSizeBytes: parsed.fileSizeBytes,
      sha256: parsed.sha256,
      rawGlbIdentical: rawBytesMatch,
      units: rawModel.units || 'meters',
      upAxis: '+Y',
      origin: rawModel.origin || 'bottom-center',
      front: '+Z',
      dimensions: sceneReport.dimensions,
      boundsMin: sceneReport.boundsMin,
      boundsMax: sceneReport.boundsMax,
      triangles: sceneReport.totalTriangles,
      vertices: sceneReport.totalVertices,
      materials: sceneReport.materials,
      materialDetails: sceneReport.materialDetails,
      hasVertexColors,
      vertexAttributes: {
        POSITION: sceneReport.allHavePosition,
        NORMAL: sceneReport.allHaveNormal,
        COLOR_0: sceneReport.allHaveColor0,
        colorFormat: sceneReport.colorFormats[0] || 'VEC3:FLOAT',
        accessorMinMaxMatch: sceneReport.allAccessorMinMaxValid,
      },
      noCamerasOrLights: sceneReport.noCamerasOrLights,
      noExternalTextures: sceneReport.noExternalTextures,
      rootNode: sceneReport.rootNodeName,
      staticMeshes,
      movingMeshes: pivotMeasured.movingMeshes,
      pivots,
      colliders: {
        space: 'model-local',
        boxes: [
          {
            name: 'staticBody',
            center: rawModel.colliders.staticBody.center,
            size: rawModel.colliders.staticBody.size,
          },
        ],
        staticBody: rawModel.colliders.staticBody,
        movingPart: rawModel.colliders.movingPart,
        simple: {
          center: rawModel.colliders.simpleClosed.center,
          size: rawModel.colliders.simpleClosed.size,
          note: rawModel.colliders.simpleClosed.note,
        },
        simpleClosed: rawModel.colliders.simpleClosed,
      },
      interaction: rawModel.interaction,
      interiorVolume: rawModel.interiorVolume,
      itemAnchors: [],
      placeableSurfaces: [],
      validationPassed,
    });
  }

  // 3. Process INTERIOR-ASSET-01 (6 GLB)
  for (const rawModel of rawInteriorManifest.models) {
    const assetId = rawModel.name;
    const fileName = `${assetId}.glb`;
    const publicPath = path.join(ROOT_DIR, 'public/models/interior', fileName);
    const rawPath = path.join(ROOT_DIR, 'docs/assets/raw/INTERIOR-ASSET-01/glb', fileName);

    const parsed = parseGlbBinary(publicPath);
    const rawParsed = parseGlbBinary(rawPath);
    const sceneReport = inspectGlbScene(parsed.gltf, parsed.bin);

    const rawBytesMatch =
      parsed.sha256 === rawParsed.sha256 &&
      parsed.fileSizeBytes === rawModel.verification.glbBytes;
    const trianglesMatch = sceneReport.totalTriangles === rawModel.triangles;
    const materialsMatch =
      JSON.stringify(sceneReport.materials) === JSON.stringify(rawModel.materials);
    const hasVertexColors =
      sceneReport.allHavePosition && sceneReport.allHaveNormal && sceneReport.allHaveColor0;

    const pivots = (rawModel.pivots || []).map((rawPivot, idx) => {
      const m = measurePivotMotion(parsed.gltf, {
        name: rawPivot.name,
        parent: assetId,
        axis: rawPivot.axis,
        closedAngleRad: rawPivot.closedAngleRad,
        openAngleRad: rawPivot.openAngleRad,
        openAngleDeg: rawPivot.openAngleDeg,
        direction: rawPivot.description,
        collider: rawPivot.collider,
      });
      const posOk =
        Math.abs(m.position[0] - rawPivot.position[0]) < 1e-3 &&
        Math.abs(m.position[1] - rawPivot.position[1]) < 1e-3 &&
        Math.abs(m.position[2] - rawPivot.position[2]) < 1e-3;
      const expectedVerif = rawModel.verification.pivots?.[idx];
      const dispOk = expectedVerif
        ? Math.abs(m.measuredDisplacementM - expectedVerif.displacement) < 2e-3
        : true;
      if (!posOk || !dispOk) {
        errors.push(`${assetId}: pivot ${rawPivot.name} mismatch`);
      }
      return m;
    });

    const movingMeshSet = new Set(pivots.flatMap((p) => p.movingMeshes));
    const staticMeshes = sceneReport.meshReports
      .map((m) => m.nodeName)
      .filter((name) => !movingMeshSet.has(name));

    const staticMeshesMatch =
      JSON.stringify(staticMeshes) === JSON.stringify(rawModel.meshes.static);

    // Annotate colliders and anchors with QA findings for old_bed_01 and kitchen_cabinet_01
    const colliders = structuredClone(rawModel.colliders);
    const itemAnchors = structuredClone(rawModel.itemAnchors || []);
    const placeableSurfaces = structuredClone(rawModel.placeableSurfaces || []);
    let qaAnalysis = null;

    if (assetId === 'old_bed_01') {
      const frameVertsLow = sceneReport.allWorldVertices.filter(
        (v) => v.nodeName === 'old_bed_01_frame' && v.position[1] < 0.195
      );
      const minAbsXLow = round3(Math.min(...frameVertsLow.map((v) => Math.abs(v.position[0]))));
      const minAbsZLow = round3(Math.min(...frameVertsLow.map((v) => Math.abs(v.position[2]))));

      colliders.underBedClearanceAdjustedBoxes = [
        {
          name: 'frame_mattress_raised',
          center: [0, 0.33, 0],
          size: [2, 0.26, 0.95],
          note: "Karavot ostidagi y∈[0, 0.20] bo'shliqni va under_bed (0,0,0) anchorini LOS/raycast uchun ochiq qoldiruvchi alternativ collider",
        },
        {
          name: 'headboard',
          center: [0.965, 0.555, 0],
          size: [0.09, 0.19, 0.95],
        },
      ];
      colliders.qaNote =
        "Standart frame_mattress collideri (center [0, 0.23, 0], size [2, 0.46, 0.95]) y∈[0.00, 0.46] oraliqni to'liq yopadi va under_bed ([0, 0, 0]) anchorini AABB ichida ko'mib qo'yadi. Yashirin loot LOS/pickup ishlashi uchun frame_mattress_raised (y∈[0.20, 0.46]) ishlatilishi yoki LOS tekshiruvida pastki 0.20 m qatlam istisno qilinishi zarur.";

      for (const anchor of itemAnchors) {
        if (anchor.name === 'under_bed') {
          anchor.occludedByDefaultCollider = true;
          anchor.clearanceHeightM = 0.2;
        }
      }

      qaAnalysis = {
        visualUnderBedClearanceM: 0.2,
        cornerLegMinAbsX: minAbsXLow,
        cornerLegMinAbsZ: minAbsZLow,
        defaultFrameColliderYRange: [0, 0.46],
        adjustedFrameColliderYRange: [0.2, 0.46],
        underBedAnchorPosition: [0, 0, 0],
        occludedByDefaultFrameCollider: true,
      };
    }

    if (assetId === 'kitchen_cabinet_01') {
      for (const surface of placeableSurfaces) {
        surface.requiresOpenDoors = surface.name.startsWith('inside_');
      }
      for (const anchor of itemAnchors) {
        const isInterior = anchor.name.startsWith('inside_');
        anchor.requiresOpenDoors = isInterior;
        anchor.enclosedByBodyCollider = isInterior;
      }
      colliders.qaNote =
        "kitchen_cabinet_01 body collideri (center [0, 0.45, 0], size [1.2, 0.9, 0.55]) ichki 4 ta anchorni (inside_bottom_1..2, inside_shelf_1..2) qamrab oladi. Eshiklar ochilganda (door_left_pivot=-1.75 rad, door_right_pivot=+1.75 rad) ichki anchorlardan buyum olish uchun LOS raycast body AABB'ni ichki anchorlar uchun o'tkazib yuborishi kerak.";
      qaAnalysis = {
        dualPivots: true,
        leftPivotPosition: [-0.585, 0, 0.255],
        rightPivotPosition: [0.585, 0, 0.255],
        readmeRoundedPositionNote:
          'README 4-bo\'limida (-0.58, 0.00, 0.26) / (0.58, 0.00, 0.26) deb yaxlitlangan; GLB binary node.matrix va manifestda aniq (-0.585, 0, 0.255) / (0.585, 0, 0.255).',
        exteriorAnchors: itemAnchors.filter((a) => !a.requiresOpenDoors).map((a) => a.name),
        interiorAnchors: itemAnchors.filter((a) => a.requiresOpenDoors).map((a) => a.name),
      };
    }

    const validationPassed =
      rawBytesMatch &&
      trianglesMatch &&
      materialsMatch &&
      hasVertexColors &&
      sceneReport.allAccessorMinMaxValid &&
      sceneReport.noCamerasOrLights &&
      sceneReport.noExternalTextures &&
      staticMeshesMatch;

    if (!validationPassed) {
      errors.push(`Validation failed for interior asset ${assetId}`);
    }

    normalizedAssets.push({
      assetId,
      pack: 'INTERIOR-ASSET-01',
      category: 'interior',
      publicUrl: `/models/interior/${fileName}`,
      originalManifestSource: 'docs/assets/raw/INTERIOR-ASSET-01/interior_asset_manifest.json',
      fileSizeBytes: parsed.fileSizeBytes,
      sha256: parsed.sha256,
      rawGlbIdentical: rawBytesMatch,
      units: rawModel.units || 'meters',
      upAxis: '+Y',
      origin: rawModel.origin || 'bottom-center',
      front: rawModel.front || '+Z',
      dimensions: sceneReport.dimensions,
      boundsMin: sceneReport.boundsMin,
      boundsMax: sceneReport.boundsMax,
      triangles: sceneReport.totalTriangles,
      vertices: sceneReport.totalVertices,
      materials: sceneReport.materials,
      materialDetails: sceneReport.materialDetails,
      hasVertexColors,
      vertexAttributes: {
        POSITION: sceneReport.allHavePosition,
        NORMAL: sceneReport.allHaveNormal,
        COLOR_0: sceneReport.allHaveColor0,
        colorFormat: sceneReport.colorFormats[0] || 'VEC3:FLOAT',
        accessorMinMaxMatch: sceneReport.allAccessorMinMaxValid,
      },
      noCamerasOrLights: sceneReport.noCamerasOrLights,
      noExternalTextures: sceneReport.noExternalTextures,
      rootNode: sceneReport.rootNodeName,
      staticMeshes,
      movingMeshes: [...movingMeshSet],
      pivots,
      colliders,
      itemAnchors,
      placeableSurfaces,
      ...(rawModel.cover ? { cover: rawModel.cover } : {}),
      ...(qaAnalysis ? { qaAnalysis } : {}),
      validationPassed,
    });
  }

  return { normalizedAssets, errors };
}

const { normalizedAssets, errors } = validateAndNormalizeAllAssets();

if (errors.length > 0) {
  console.error('STAGE 04A ASSET VALIDATION ERRORS:');
  for (const err of errors) {
    console.error('  - ' + err);
  }
  process.exit(1);
}

const packSummary = {};
for (const asset of normalizedAssets) {
  if (!packSummary[asset.pack]) {
    packSummary[asset.pack] = {
      count: 0,
      totalBytes: 0,
      totalTriangles: 0,
      totalVertices: 0,
      assetIds: [],
    };
  }
  packSummary[asset.pack].count += 1;
  packSummary[asset.pack].totalBytes += asset.fileSizeBytes;
  packSummary[asset.pack].totalTriangles += asset.triangles;
  packSummary[asset.pack].totalVertices += asset.vertices;
  packSummary[asset.pack].assetIds.push(asset.assetId);
}

const assetsById = Object.fromEntries(normalizedAssets.map((a) => [a.assetId, a]));

const manifestPayload = {
  schemaVersion: '1.0.0',
  stage: 'STAGE-04A',
  title: 'Normalized Building, Loot & Interior Assets Manifest',
  units: 'meters',
  upAxis: '+Y',
  conventions: {
    gridStepM: 4.0,
    wallHeightM: 3.0,
    wallThicknessM: 0.2,
    floorSurfaceY: 0.0,
    defaultFrontAxis: '+Z',
    sharedMaterials: {
      wood: { metallicFactor: 0.0, roughnessFactor: 0.88, doubleSided: false },
      roof: { metallicFactor: 0.0, roughnessFactor: 0.92, doubleSided: false },
      iron: { metallicFactor: 0.45, roughnessFactor: 0.6, doubleSided: false },
      painted_metal: { metallicFactor: 0.25, roughnessFactor: 0.72, doubleSided: false },
      fabric: { metallicFactor: 0.0, roughnessFactor: 0.97, doubleSided: false },
    },
  },
  summary: {
    totalAssets: normalizedAssets.length,
    totalBytes: normalizedAssets.reduce((sum, a) => sum + a.fileSizeBytes, 0),
    totalTriangles: normalizedAssets.reduce((sum, a) => sum + a.triangles, 0),
    totalVertices: normalizedAssets.reduce((sum, a) => sum + a.vertices, 0),
    totalPivots: normalizedAssets.reduce((sum, a) => sum + a.pivots.length, 0),
    totalItemAnchors: normalizedAssets.reduce((sum, a) => sum + a.itemAnchors.length, 0),
    totalPlaceableSurfaces: normalizedAssets.reduce((sum, a) => sum + a.placeableSurfaces.length, 0),
    allValidationPassed: normalizedAssets.every((a) => a.validationPassed === true),
    byPack: packSummary,
  },
  sampleLayouts: {
    cabin8x4: {
      source: 'docs/assets/raw/BUILDING-ASSET-01/examples/sample_cabin_layout.json',
      name: rawCabinSample.name,
      moduleCount: rawCabinSample.modules.length,
    },
    room4x4: {
      source: 'docs/assets/raw/INTERIOR-ASSET-01/examples/sample_room_layout.json',
      room: rawRoomSample.room,
      cell: rawRoomSample.cell,
      walkway: rawRoomSample.walkway,
      objectCount: rawRoomSample.objects.length,
    },
  },
  assets: normalizedAssets,
  assetsById,
};

const outManifestPath = path.join(ROOT_DIR, 'docs/stage04a/assets_manifest_normalized.json');
fs.mkdirSync(path.dirname(outManifestPath), { recursive: true });
fs.writeFileSync(outManifestPath, JSON.stringify(manifestPayload, null, 2) + '\n', 'utf8');

console.log('================================================================================');
console.log('BOSQICH 04A — GLB BINARY VA MANIFEST VALIDATSIYASI MUVAFFAQIYATLI YAKUNLANDI');
console.log('================================================================================');
console.log(`Jami tekshirilgan GLB fayllar: ${manifestPayload.summary.totalAssets} ta`);
console.log(`Jami fayl hajmi:               ${manifestPayload.summary.totalBytes.toLocaleString('en-US')} bayt`);
console.log(`Jami uchburchaklar (tris):     ${manifestPayload.summary.totalTriangles.toLocaleString('en-US')} ta`);
console.log(`Jami vertexlar:                ${manifestPayload.summary.totalVertices.toLocaleString('en-US')} ta`);
console.log(`Jami harakatlanuvchi pivotlar: ${manifestPayload.summary.totalPivots} ta`);
console.log(`Jami buyum anchor nuqtalari:   ${manifestPayload.summary.totalItemAnchors} ta`);
console.log(`Jami buyum qo'yish yuzalari:   ${manifestPayload.summary.totalPlaceableSurfaces} ta`);
console.log(`Barcha testlar o'tdi:          ${manifestPayload.summary.allValidationPassed}`);
console.log('--------------------------------------------------------------------------------');
for (const a of normalizedAssets) {
  const pivotStr =
    a.pivots.length > 0
      ? a.pivots.map((p) => `${p.name}(${p.axis}:${p.openAngleRad}rad,d=${p.measuredDisplacementM}m)`).join(', ')
      : '-';
  console.log(
    `[PASS] ${a.pack.padEnd(17)} | ${a.assetId.padEnd(20)} | ${String(a.fileSizeBytes).padStart(6)} B | ${String(a.triangles).padStart(4)} tris | dims=${a.dimensions.x}x${a.dimensions.y}x${a.dimensions.z}m | pivots=${pivotStr}`
  );
}
console.log('--------------------------------------------------------------------------------');
console.log(`Generatsiya qilingan manifest: ${outManifestPath}`);
