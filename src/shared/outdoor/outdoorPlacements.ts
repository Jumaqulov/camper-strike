import { sampleForestSquareRoad } from '../forestSquareRoads';
import { q3 } from '../math';
import {
  OUTDOOR_ASSET_IDS,
  OUTDOOR_ASSET_MANIFEST,
  type OutdoorAssetId,
  type OutdoorPlacement,
  type OutdoorSignpostBoardLabel,
  type OutdoorSiteId,
} from './contracts';
import {
  getForestSquarePoiSites,
  type ForestSquarePoiId,
  type ForestSquarePoiSiteSpec,
} from '../structures/contracts';
import {
  createSeededRng,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_PUBLIC_LAYOUT_SEED,
  getChunkCoord,
  sampleTerrainHeight,
  type TerrainDescriptor,
  type VisualCategory,
  type VisualDescriptor,
} from '../world';


const UNIT_SCALE = { x: 1, y: 1, z: 1 } as const;

function makePlacementId(siteId: OutdoorSiteId, index: number, assetId: OutdoorAssetId): string {
  if (siteId === 'loc_sq_central_crossroads') {
    return `crossroads:out_${index}:${assetId}`;
  }
  return `poi:${siteId}:out_${index}:${assetId}`;
}

function groundedPlacement(params: {
  siteId: OutdoorSiteId;
  index: number;
  assetId: OutdoorAssetId;
  terrain: TerrainDescriptor;
  x: number;
  z: number;
  yOverride?: number;
  rotationY: number;
  rotationX?: number;
  rotationZ?: number;
  elevatedSurface?: boolean;
  hideStartPost?: boolean;
  signLabels?: OutdoorSignpostBoardLabel[];
  campfireLit?: boolean;
  role?: string;
}): OutdoorPlacement {
  const x = q3(params.x);
  const z = q3(params.z);
  const y =
    params.yOverride !== undefined
      ? q3(params.yOverride)
      : q3(sampleTerrainHeight(params.terrain, x, z));

  const placement: OutdoorPlacement = {
    id: makePlacementId(params.siteId, params.index, params.assetId),
    siteId: params.siteId,
    assetId: params.assetId,
    position: { x, y, z },
    rotationY: q3(params.rotationY),
    scale: { ...UNIT_SCALE },
  };

  if (params.rotationX !== undefined) {
    placement.rotationX = q3(params.rotationX);
  }
  if (params.rotationZ !== undefined) {
    placement.rotationZ = q3(params.rotationZ);
  }
  if (params.elevatedSurface !== undefined) {
    placement.elevatedSurface = params.elevatedSurface;
  }
  if (params.hideStartPost !== undefined) {
    placement.hideStartPost = params.hideStartPost;
  }
  if (params.signLabels !== undefined) {
    placement.signLabels = params.signLabels.map((lbl) => ({ ...lbl }));
  }
  if (params.campfireLit !== undefined) {
    placement.campfireLit = params.campfireLit;
  }
  if (params.role !== undefined) {
    placement.role = params.role;
  }

  return placement;
}

/**
 * Ensures a roadside signpost placement is at least `minRoadDist` meters from the road centerline
 * while staying on the roadside shoulder (`<= maxRoadDist`).
 */
function resolveRoadsidePoint(
  baseX: number,
  baseZ: number,
  seed: number,
  minRoadDist = 4.35,
  maxRoadDist = 7.5,
): { x: number; z: number } {
  const bx = q3(baseX);
  const bz = q3(baseZ);
  const initialDist = sampleForestSquareRoad(bx, bz, seed).dist;
  if (initialDist >= minRoadDist && initialDist <= maxRoadDist) {
    return { x: bx, z: bz };
  }

  for (let r = 0.5; r <= 12.0; r += 0.5) {
    const steps = 16;
    for (let s = 0; s < steps; s++) {
      const ang = (s / steps) * Math.PI * 2;
      const cx = q3(bx + Math.cos(ang) * r);
      const cz = q3(bz + Math.sin(ang) * r);
      const d = sampleForestSquareRoad(cx, cz, seed).dist;
      if (d >= minRoadDist && d <= maxRoadDist) {
        return { x: cx, z: cz };
      }
    }
  }

  for (let r = 0.5; r <= 16.0; r += 0.5) {
    const steps = 16;
    for (let s = 0; s < steps; s++) {
      const ang = (s / steps) * Math.PI * 2;
      const cx = q3(bx + Math.cos(ang) * r);
      const cz = q3(bz + Math.sin(ang) * r);
      const d = sampleForestSquareRoad(cx, cz, seed).dist;
      if (d >= minRoadDist) {
        return { x: cx, z: cz };
      }
    }
  }

  return { x: bx, z: bz };
}

// ---------------- 1. POI: O'rmonchi Uyi (poi_ranger_house) ----------------

function buildRangerHouseOutdoor(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  yawJitter: () => number,
): OutdoorPlacement[] {
  const cx = site.center.x;
  const cz = site.center.z;
  const siteId = site.id;

  return [
    // 0: Directional wooden signpost at south-east road approach
    groundedPlacement({
      siteId,
      index: 0,
      assetId: 'wooden_signpost_01',
      terrain,
      x: cx + 4.8,
      z: cz + 8.2,
      rotationY: -0.35,
      role: 'poi_entry_signpost',
      signLabels: [
        { boardIndex: 1, textFront: "O'RMONCHI UYI", textBack: 'CHORRAHA 75m' },
        { boardIndex: 2, textFront: 'ARRAKORLIK 60m', textBack: 'LAGER 110m' },
        { boardIndex: 3, textFront: 'SERVIS 85m', textBack: 'QOYA 140m' },
      ],
    }),
    // 1: South-west porch/terrace edge railing (clear of cabin & doorway)
    groundedPlacement({
      siteId,
      index: 1,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx - 5.8,
      z: cz + 4.2,
      rotationY: 0,
      hideStartPost: false,
      role: 'terrace_railing_sw',
    }),
    // 2: East yard edge railing
    groundedPlacement({
      siteId,
      index: 2,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx + 5.8,
      z: cz + 2.0,
      rotationY: Math.PI / 2,
      hideStartPost: false,
      role: 'terrace_railing_east',
    }),
    // 3: West yard stacked timber (replaces old primitive woodpile box)
    groundedPlacement({
      siteId,
      index: 3,
      assetId: 'lumber_stack_01',
      terrain,
      x: cx - 6.8,
      z: cz - 0.5,
      rotationY: Math.PI / 2,
      role: 'ranger_woodpile_west',
    }),
    // 4: North-east corner rusty barrel
    groundedPlacement({
      siteId,
      index: 4,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx + 5.2,
      z: cz - 2.8,
      rotationY: 0.4 + yawJitter(),
      role: 'corner_rain_barrel',
    }),
  ];
}

// ---------------- 2. POI: Uylar Guruhi (poi_cabin_cluster) ----------------

function buildCabinClusterOutdoor(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  yawJitter: () => number,
): OutdoorPlacement[] {
  const cx = site.center.x;
  const cz = site.center.z;
  const siteId = site.id;

  return [
    // 0: Central courtyard campfire pit between the 3 cabins
    groundedPlacement({
      siteId,
      index: 0,
      assetId: 'campfire_pit_01',
      terrain,
      x: cx + 1.6,
      z: cz + 2.6,
      rotationY: 0.25,
      campfireLit: true,
      role: 'courtyard_campfire',
    }),
    // 1: West road entrance signpost
    groundedPlacement({
      siteId,
      index: 1,
      assetId: 'wooden_signpost_01',
      terrain,
      x: cx - 11.2,
      z: cz + 8.4,
      rotationY: 0.55,
      role: 'poi_entry_signpost',
      signLabels: [
        { boardIndex: 1, textFront: 'UYLAR GURUHI', textBack: 'CHORRAHA 80m' },
        { boardIndex: 2, textFront: 'SERVIS 65m', textBack: "O'RMONCHI 120m" },
        { boardIndex: 3, textFront: 'QOYA MINORA', textBack: 'SOQMOQ' },
      ],
    }),
    // 2: North-west courtyard perimeter railing
    groundedPlacement({
      siteId,
      index: 2,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx - 7.5,
      z: cz - 4.5,
      rotationY: 0,
      hideStartPost: false,
      role: 'courtyard_railing_nw',
    }),
    // 3: North-east courtyard perimeter railing
    groundedPlacement({
      siteId,
      index: 3,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx + 7.5,
      z: cz - 4.5,
      rotationY: 0,
      hideStartPost: false,
      role: 'courtyard_railing_ne',
    }),
    // 4: Upright rusty barrel east of north cabin
    groundedPlacement({
      siteId,
      index: 4,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx + 5.2,
      z: cz - 7.0,
      rotationY: 0.8 + yawJitter(),
      role: 'cabin_barrel_east',
    }),
    // 5: Upright rusty barrel west of north cabin
    groundedPlacement({
      siteId,
      index: 5,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx - 5.2,
      z: cz - 7.2,
      rotationY: 2.1 + yawJitter(),
      role: 'cabin_barrel_west',
    }),
  ];
}

// ---------------- 3. POI: Taxta Tilish va Yog'och Ombori (poi_lumber_mill) ----------------

function buildLumberMillOutdoor(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  yawJitter: () => number,
): OutdoorPlacement[] {
  const cx = site.center.x;
  const cz = site.center.z;
  const siteId = site.id;

  const tippedX = q3(cx + 5.2);
  const tippedZ = q3(cz - 5.2);
  const tippedY = q3(sampleTerrainHeight(terrain, tippedX, tippedZ) + 0.305);

  return [
    // 0: Lumber stack 0 (North yard)
    groundedPlacement({
      siteId,
      index: 0,
      assetId: 'lumber_stack_01',
      terrain,
      x: cx + 1.8,
      z: cz - 6.6,
      rotationY: 0,
      role: 'yard_lumber_stack_north',
    }),
    // 1: Lumber stack 1 (East yard)
    groundedPlacement({
      siteId,
      index: 1,
      assetId: 'lumber_stack_01',
      terrain,
      x: cx + 7.4,
      z: cz - 1.2,
      rotationY: Math.PI / 2,
      role: 'yard_lumber_stack_east',
    }),
    // 2: Lumber stack 2 (South-East yard)
    groundedPlacement({
      siteId,
      index: 2,
      assetId: 'lumber_stack_01',
      terrain,
      x: cx + 6.8,
      z: cz + 5.4,
      rotationY: 0.18,
      role: 'yard_lumber_stack_se',
    }),
    // 3: Sawhorse 0 (Central-west work line, clear of warehouse +X doorway corridor)
    groundedPlacement({
      siteId,
      index: 3,
      assetId: 'sawhorse_01',
      terrain,
      x: cx + 1.8,
      z: cz - 0.2,
      rotationY: 0.15,
      role: 'yard_sawhorse_west',
    }),
    // 4: Sawhorse 1 (Central-east work line)
    groundedPlacement({
      siteId,
      index: 4,
      assetId: 'sawhorse_01',
      terrain,
      x: cx + 4.4,
      z: cz - 0.2,
      rotationY: -0.12,
      role: 'yard_sawhorse_east',
    }),
    // 5: Sawhorse 2 (South yard)
    groundedPlacement({
      siteId,
      index: 5,
      assetId: 'sawhorse_01',
      terrain,
      x: cx + 2.2,
      z: cz + 5.8,
      rotationY: Math.PI / 4,
      role: 'yard_sawhorse_south',
    }),
    // 6: Upright rusty barrel (North-west yard)
    groundedPlacement({
      siteId,
      index: 6,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx - 1.2,
      z: cz - 5.6,
      rotationY: 0.5 + yawJitter(),
      role: 'yard_barrel_upright',
    }),
    // 7: Tipped rusty barrel on its side (North-east yard)
    groundedPlacement({
      siteId,
      index: 7,
      assetId: 'rusty_barrel_01',
      terrain,
      x: tippedX,
      z: tippedZ,
      yOverride: tippedY,
      rotationY: 0.9,
      rotationZ: Math.PI / 2,
      elevatedSurface: true,
      role: 'tipped_barrel',
    }),
    // 8: South-east road entrance signpost
    groundedPlacement({
      siteId,
      index: 8,
      assetId: 'wooden_signpost_01',
      terrain,
      x: cx + 10.2,
      z: cz + 4.6,
      rotationY: -0.6,
      role: 'poi_entry_signpost',
      signLabels: [
        { boardIndex: 1, textFront: 'ARRAKORLIK', textBack: 'CHORRAHA 65m' },
        { boardIndex: 2, textFront: "O'RMONCHI 60m", textBack: 'LAGER 70m' },
        { boardIndex: 3, textFront: 'YOGOCH OMBORI', textBack: 'XAVFSIZ YOL' },
      ],
    }),
  ];
}

// ---------------- 4. POI: O'rmon Servis va Yoqilg'i Shoxobchasi (poi_service_station) ----------------

function buildServiceStationOutdoor(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  yawJitter: () => number,
): OutdoorPlacement[] {
  const cx = site.center.x;
  const cz = site.center.z;
  const siteId = site.id;

  const islandSurfaceY = q3(sampleTerrainHeight(terrain, cx - 1.0, cz + 4.2) + 0.22);
  const tippedX = q3(cx - 5.2);
  const tippedZ = q3(cz - 5.4);
  const tippedY = q3(sampleTerrainHeight(terrain, tippedX, tippedZ) + 0.305);

  return [
    // 0: West vintage fuel pump on elevated concrete island
    groundedPlacement({
      siteId,
      index: 0,
      assetId: 'old_fuel_pump_01',
      terrain,
      x: cx - 2.6,
      z: cz + 4.2,
      yOverride: islandSurfaceY,
      rotationY: 0,
      elevatedSurface: true,
      role: 'fuel_island_pump_west',
    }),
    // 1: Center-west vintage fuel pump on elevated concrete island
    groundedPlacement({
      siteId,
      index: 1,
      assetId: 'old_fuel_pump_01',
      terrain,
      x: cx - 0.6,
      z: cz + 4.2,
      yOverride: islandSurfaceY,
      rotationY: Math.PI,
      elevatedSurface: true,
      role: 'fuel_island_pump_east',
    }),
    // 2: Garage west barrel 0 (upright)
    groundedPlacement({
      siteId,
      index: 2,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx - 6.2,
      z: cz - 4.8,
      rotationY: 0.3 + yawJitter(),
      role: 'service_barrel_nw_0',
    }),
    // 3: Garage west barrel 1 (upright)
    groundedPlacement({
      siteId,
      index: 3,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx - 6.2,
      z: cz - 3.8,
      rotationY: 1.7 + yawJitter(),
      role: 'service_barrel_nw_1',
    }),
    // 4: East fuel tank barrel 2 (upright)
    groundedPlacement({
      siteId,
      index: 4,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx + 8.2,
      z: cz + 4.2,
      rotationY: 2.4 + yawJitter(),
      role: 'service_barrel_east',
    }),
    // 5: Garage west barrel 3 (tipped on side)
    groundedPlacement({
      siteId,
      index: 5,
      assetId: 'rusty_barrel_01',
      terrain,
      x: tippedX,
      z: tippedZ,
      yOverride: tippedY,
      rotationY: 0.45,
      rotationZ: Math.PI / 2,
      elevatedSurface: true,
      role: 'tipped_barrel',
    }),
    // 6: Service bay sawhorse barrier
    groundedPlacement({
      siteId,
      index: 6,
      assetId: 'sawhorse_01',
      terrain,
      x: cx - 7.8,
      z: cz + 0.6,
      rotationY: 0.28,
      role: 'service_bay_sawhorse',
    }),
    // 7: South forecourt road entrance signpost
    groundedPlacement({
      siteId,
      index: 7,
      assetId: 'wooden_signpost_01',
      terrain,
      x: cx - 5.4,
      z: cz + 8.6,
      rotationY: 0.25,
      role: 'poi_entry_signpost',
      signLabels: [
        { boardIndex: 1, textFront: 'AVTO SERVIS', textBack: 'YOQILGI BEKATI' },
        { boardIndex: 2, textFront: 'UYLAR 65m', textBack: 'QOYA 85m' },
        { boardIndex: 3, textFront: 'ARRAKORLIK 90m', textBack: 'LAGER 95m' },
      ],
    }),
  ];
}

// ---------------- 5. POI: Kemperlar va Palatkalar Lageri (poi_forest_camp) ----------------

function buildForestCampOutdoor(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
  yawJitter: () => number,
): OutdoorPlacement[] {
  const cx = site.center.x;
  const cz = site.center.z;
  const siteId = site.id;

  return [
    // 0: North-west A-frame forest tent (entrance on +Z facing campfire clearing)
    groundedPlacement({
      siteId,
      index: 0,
      assetId: 'forest_tent_01',
      terrain,
      x: cx - 2.2,
      z: cz - 6.2,
      rotationY: 0.22,
      role: 'camp_tent_nw',
    }),
    // 1: North-east A-frame forest tent (entrance on +Z facing campfire clearing)
    groundedPlacement({
      siteId,
      index: 1,
      assetId: 'forest_tent_01',
      terrain,
      x: cx + 5.4,
      z: cz - 5.2,
      rotationY: -0.35,
      role: 'camp_tent_ne',
    }),
    // 2: Central stone campfire pit
    groundedPlacement({
      siteId,
      index: 2,
      assetId: 'campfire_pit_01',
      terrain,
      x: cx + 0.5,
      z: cz - 0.4,
      rotationY: 0,
      campfireLit: true,
      role: 'camp_main_campfire',
    }),
    // 3: South-east camp firewood lumber stack
    groundedPlacement({
      siteId,
      index: 3,
      assetId: 'lumber_stack_01',
      terrain,
      x: cx + 6.4,
      z: cz + 3.2,
      rotationY: -Math.PI / 3,
      role: 'camp_firewood_stack',
    }),
    // 4: Camper van utility barrel
    groundedPlacement({
      siteId,
      index: 4,
      assetId: 'rusty_barrel_01',
      terrain,
      x: cx - 6.2,
      z: cz + 4.4,
      rotationY: 1.1 + yawJitter(),
      role: 'camp_van_barrel',
    }),
    // 5: North-east camp trail signpost
    groundedPlacement({
      siteId,
      index: 5,
      assetId: 'wooden_signpost_01',
      terrain,
      x: cx + 6.2,
      z: cz - 8.4,
      rotationY: 2.65,
      role: 'poi_entry_signpost',
      signLabels: [
        { boardIndex: 1, textFront: 'KEMPER LAGERI', textBack: 'CHORRAHA 85m' },
        { boardIndex: 2, textFront: 'ARRAKORLIK 70m', textBack: 'SERVIS 95m' },
        { boardIndex: 3, textFront: 'GULXAN MAYDONI', textBack: 'SOQMOQ' },
      ],
    }),
  ];
}

// ---------------- 6. POI: Qoya Kuzatuv va Xaroba Hududi (poi_cliff_watch) ----------------

function buildCliffWatchOutdoor(
  site: ForestSquarePoiSiteSpec,
  terrain: TerrainDescriptor,
): OutdoorPlacement[] {
  const cx = site.center.x;
  const cz = site.center.z;
  const siteId = site.id;

  return [
    // 0: South cliff edge railing span 1
    groundedPlacement({
      siteId,
      index: 0,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx - 4.5,
      z: cz + 7.2,
      rotationY: 0,
      hideStartPost: false,
      role: 'cliff_railing_south_1',
    }),
    // 1: South cliff edge railing span 2 (chained seamlessly to span 1)
    groundedPlacement({
      siteId,
      index: 1,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx - 1.5,
      z: cz + 7.2,
      rotationY: 0,
      hideStartPost: true,
      role: 'cliff_railing_south_2',
    }),
    // 2: West cliff overlook railing span 1
    groundedPlacement({
      siteId,
      index: 2,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx - 7.8,
      z: cz + 1.5,
      rotationY: Math.PI / 2,
      hideStartPost: false,
      role: 'cliff_railing_west_1',
    }),
    // 3: West cliff overlook railing span 2 (chained seamlessly to span 1)
    groundedPlacement({
      siteId,
      index: 3,
      assetId: 'wooden_railing_01',
      terrain,
      x: cx - 7.8,
      z: cz + 4.5,
      rotationY: Math.PI / 2,
      hideStartPost: true,
      role: 'cliff_railing_west_2',
    }),
    // 4: Watchman's sheltered courtyard campfire pit
    groundedPlacement({
      siteId,
      index: 4,
      assetId: 'campfire_pit_01',
      terrain,
      x: cx + 3.4,
      z: cz + 1.8,
      rotationY: 0.5,
      campfireLit: true,
      role: 'watchpost_campfire',
    }),
    // 5: North-west trail approach signpost
    groundedPlacement({
      siteId,
      index: 5,
      assetId: 'wooden_signpost_01',
      terrain,
      x: cx - 7.6,
      z: cz - 4.8,
      rotationY: 2.35,
      role: 'poi_entry_signpost',
      signLabels: [
        { boardIndex: 1, textFront: 'QOYA KUZATUV', textBack: 'JARLIK XAVFI!' },
        { boardIndex: 2, textFront: 'SERVIS 85m', textBack: 'LAGER 130m' },
        { boardIndex: 3, textFront: '2-QAVAT MINORA', textBack: 'CHORRAHA 95m' },
      ],
    }),
  ];
}

// ---------------- 7. Central Crossroads (loc_sq_central_crossroads) ----------------

function buildCentralCrossroadsOutdoor(
  terrain: TerrainDescriptor,
  seed: number,
): OutdoorPlacement[] {
  const siteId: OutdoorSiteId = 'loc_sq_central_crossroads';
  const pt0 = resolveRoadsidePoint(-13.5, 1.5, seed, 4.35, 7.5);
  const pt1 = resolveRoadsidePoint(-2.5, 11.2, seed, 4.35, 7.5);

  return [
    groundedPlacement({
      siteId,
      index: 0,
      assetId: 'wooden_signpost_01',
      terrain,
      x: pt0.x,
      z: pt0.z,
      rotationY: 0.4,
      role: 'crossroads_signpost_west',
      signLabels: [
        { boardIndex: 1, textFront: 'MARKAZIY CHORRAHA', textBack: 'AVTO SERVIS 25m' },
        { boardIndex: 2, textFront: 'ARRAKORLIK 65m', textBack: "O'RMONCHI 85m" },
        { boardIndex: 3, textFront: 'KEMPER LAGERI 80m', textBack: 'UYLAR GURUHI 85m' },
      ],
    }),
    groundedPlacement({
      siteId,
      index: 1,
      assetId: 'wooden_signpost_01',
      terrain,
      x: pt1.x,
      z: pt1.z,
      rotationY: -2.4,
      role: 'crossroads_signpost_south',
      signLabels: [
        { boardIndex: 1, textFront: 'QOYA KUZATUV 90m', textBack: 'SHIMOLIY YOL' },
        { boardIndex: 2, textFront: 'UYLAR GURUHI 85m', textBack: 'KEMPER LAGERI 75m' },
        { boardIndex: 3, textFront: "O'RMONCHI UYI 90m", textBack: 'ARRAKORLIK 70m' },
      ],
    }),
  ];
}

// ---------------- Public API ----------------

/**
 * Deterministic seed-based placement of all 8 `OUTDOOR-ASSET-01` models across the 6 POIs
 * (`poi_ranger_house`, `poi_cabin_cluster`, `poi_lumber_mill`, `poi_service_station`,
 * `poi_forest_camp`, `poi_cliff_watch`) and the central crossroads (`loc_sq_central_crossroads`).
 */
export function buildForestSquareOutdoorPlacements(
  terrain: TerrainDescriptor,
  seed = DEFAULT_PUBLIC_LAYOUT_SEED,
): OutdoorPlacement[] {
  const sites = getForestSquarePoiSites(seed);
  const byId = new Map<ForestSquarePoiId, ForestSquarePoiSiteSpec>();
  for (const s of sites) {
    byId.set(s.id, s);
  }

  const rng = createSeededRng((seed ^ 0x08a08a) | 0);
  const yawJitter = (): number => q3((rng() - 0.5) * 0.04);

  const placements: OutdoorPlacement[] = [
    ...buildRangerHouseOutdoor(byId.get('poi_ranger_house')!, terrain, yawJitter),
    ...buildCabinClusterOutdoor(byId.get('poi_cabin_cluster')!, terrain, yawJitter),
    ...buildLumberMillOutdoor(byId.get('poi_lumber_mill')!, terrain, yawJitter),
    ...buildServiceStationOutdoor(byId.get('poi_service_station')!, terrain, yawJitter),
    ...buildForestCampOutdoor(byId.get('poi_forest_camp')!, terrain, yawJitter),
    ...buildCliffWatchOutdoor(byId.get('poi_cliff_watch')!, terrain),
    ...buildCentralCrossroadsOutdoor(terrain, seed),
  ];

  // Sanity-check unique deterministic IDs
  const seenIds = new Set<string>();
  for (const p of placements) {
    if (seenIds.has(p.id)) {
      throw new Error(`Duplicate OutdoorPlacement ID detected: "${p.id}"`);
    }
    seenIds.add(p.id);
  }

  return placements;
}

function outdoorVisualCategory(assetId: OutdoorAssetId): VisualCategory {
  if (assetId === 'forest_tent_01' || assetId === 'wooden_railing_01') {
    return 'structure';
  }
  return 'prop';
}

/**
 * Converts `OutdoorPlacement[]` into `VisualDescriptor[]` for chunked spatial culling and rendering.
 */
export function buildOutdoorVisualDescriptors(
  placements: readonly OutdoorPlacement[],
  chunkSize = DEFAULT_CHUNK_SIZE,
): VisualDescriptor[] {
  return placements.map((p) => {
    const manifest = OUTDOOR_ASSET_MANIFEST[p.assetId];
    const chunk = getChunkCoord(p.position.x, p.position.z, chunkSize);
    const [dx, dy, dz] = manifest.dimensions;

    return {
      id: `${p.id}:vis`,
      sourceObjectId: p.id,
      prefabId: `outdoor:${p.assetId}`,
      category: outdoorVisualCategory(p.assetId),
      batchKey: `outdoor:${p.assetId}`,
      batchMode: 'prefab_group',
      chunkKey: chunk.key,
      lod: 'near',
      maxDrawDistance: manifest.maxDrawDistance,
      transform: {
        position: { ...p.position },
        yaw: p.rotationY,
        scale: { ...p.scale },
      },
      boxDims: { x: dx, y: dy, z: dz },
      castShadow: true,
      receiveShadow: true,
    };
  });
}

/**
 * Computes summary counts of outdoor placements in total, by `OutdoorAssetId`, and by `siteId`.
 */
export function getOutdoorPlacementSummary(placements: readonly OutdoorPlacement[]): {
  total: number;
  byAsset: Record<OutdoorAssetId, number>;
  bySite: Record<string, number>;
} {
  const byAsset = {} as Record<OutdoorAssetId, number>;
  for (const assetId of OUTDOOR_ASSET_IDS) {
    byAsset[assetId] = 0;
  }

  const bySite: Record<string, number> = {};
  for (const p of placements) {
    byAsset[p.assetId] = (byAsset[p.assetId] ?? 0) + 1;
    bySite[p.siteId] = (bySite[p.siteId] ?? 0) + 1;
  }

  return {
    total: placements.length,
    byAsset,
    bySite,
  };
}
