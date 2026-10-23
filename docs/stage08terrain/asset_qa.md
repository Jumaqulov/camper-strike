# Grass & Vegetation Asset QA Report — Stage 08-TERRAIN-VISUAL

**Asset Pack:** GRASS-ASSET-01  
**Date:** 2026-10-22T14:48:51.984Z  
**Status:** ✅ **100% PASSED** (All 17 models validated)  
**Total Assets:** 17 models (12 grass, 3 flowers, 2 ferns)  
**Total Triangles:** 1 748 (874 front/back blade pairs)  
**Total Vertices:** 5 244 (Non-indexed VEC3 Float32)  
**Total Payload:** 206.7 KB (avg 12.2 KB / model)  

---

## 1. Executive Summary

This validation suite thoroughly audited the 17 stylized forest vegetation GLB models generated for **Camper Strike 65**.
All assets strictly meet performance, visual, and architectural requirements for instanced foliage rendering.

### Key Quality Verification Results
- **Binary Integrity:** All 17 files feature valid glTF 2.0 GLB containers with exact chunk lengths (JSON + BIN) and zero trailing garbage.
- **Scene Cleanliness:** 100% of models contain exactly **1 mesh**, **1 primitive**, **0 cameras**, **0 punctual lights**, and **0 animations/skins**.
- **Vertex Layout:** 100% of models use unindexed `POSITION`, `NORMAL`, and `COLOR_0` attributes as `VEC3 Float32` with 12-byte strides.
- **Material Strategy:** Every asset utilizes the single standardized material **`vegetation`** configured with `FrontSide` (`doubleSided: false`), roughness **0.92**, and metalness **0.00**.
- **Double-Sided Foliage via Geometry:** Each model features an **even triangle count** where 100% of triangles exist in consecutive pairs `(2k, 2k+1)` with **inverted winding** and **identical upward-tilted normals** ($n_y \ge 0$). This ensures two-sided visibility under Three.js standard `FrontSide` backface culling without any dark reverse-face artifacts or double-sided lighting performance penalties.
- **Numerical & Geometric Purity:** Zero NaN/Infinity floats, zero non-unit normals, zero zero-area degenerate triangles (minimum triangle area is $2.22 \times 10^{-5}\text{ m}^2$), and zero collapsed edges.
- **Manifest Alignment:** Bounding boxes, dimensions, triangle counts, and height specs match `docs/stage08terrain/grass_asset_manifest.json` within 0.002m tolerance.
- **Origin & Root Penetration:** Every plant origin is centered at the root contact `(0, 0, 0)` with a intentional $\sim 1\text{ cm}$ root penetration ($y_{\min} \in [-0.015, -0.009]\text{ m}$) ensuring blades never float on uneven slopes.

---

## 2. Asset Metrics & Validation Matrix

| # | Model Name | Category | Height (m) | Triangles | Vertices | Pairs | File Size | Min Tri Area | Avg Normal Y | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `fern_small_01` | Fern | 0.340 | 140 | 420 | 70 | 16.1 KB | 1.50e-4 | 0.96 | ✅ PASS |
| 2 | `fern_wide_01` | Fern | 0.600 | 210 | 630 | 105 | 23.4 KB | 5.49e-4 | 0.97 | ✅ PASS |
| 3 | `flower_purple_01` | Flower | 0.420 | 132 | 396 | 66 | 15.2 KB | 2.61e-5 | 0.90 | ✅ PASS |
| 4 | `flower_white_01` | Flower | 0.260 | 126 | 378 | 63 | 14.6 KB | 5.53e-5 | 0.97 | ✅ PASS |
| 5 | `flower_yellow_01` | Flower | 0.300 | 124 | 372 | 62 | 14.4 KB | 2.22e-5 | 0.95 | ✅ PASS |
| 6 | `grass_dry_straw_01` | Grass | 0.360 | 90 | 270 | 45 | 10.8 KB | 2.71e-4 | 0.95 | ✅ PASS |
| 7 | `grass_forest_sparse_01` | Grass | 0.220 | 60 | 180 | 30 | 7.6 KB | 1.12e-4 | 0.94 | ✅ PASS |
| 8 | `grass_meadow_thin_01` | Grass | 0.300 | 96 | 288 | 48 | 11.4 KB | 2.00e-4 | 0.94 | ✅ PASS |
| 9 | `grass_meadow_wide_01` | Grass | 0.340 | 90 | 270 | 45 | 10.8 KB | 5.15e-4 | 0.95 | ✅ PASS |
| 10 | `grass_olive_tuft_01` | Grass | 0.260 | 84 | 252 | 42 | 10.2 KB | 6.21e-4 | 0.97 | ✅ PASS |
| 11 | `grass_path_edge_01` | Grass | 0.220 | 90 | 270 | 45 | 10.8 KB | 3.06e-4 | 0.98 | ✅ PASS |
| 12 | `grass_shade_dark_01` | Grass | 0.240 | 70 | 210 | 35 | 8.7 KB | 9.14e-4 | 0.97 | ✅ PASS |
| 13 | `grass_short_dense_01` | Grass | 0.150 | 84 | 252 | 42 | 10.2 KB | 4.75e-4 | 0.93 | ✅ PASS |
| 14 | `grass_short_soft_01` | Grass | 0.170 | 60 | 180 | 30 | 7.6 KB | 2.96e-4 | 0.94 | ✅ PASS |
| 15 | `grass_tall_seeded_01` | Grass | 0.540 | 102 | 306 | 51 | 12.1 KB | 2.59e-4 | 0.93 | ✅ PASS |
| 16 | `grass_tall_wild_01` | Grass | 0.520 | 90 | 270 | 45 | 10.8 KB | 4.46e-4 | 0.94 | ✅ PASS |
| 17 | `grass_wavy_broad_01` | Grass | 0.300 | 100 | 300 | 50 | 11.9 KB | 7.75e-4 | 0.96 | ✅ PASS |

---

## 3. Detailed Model Specifications

### 1. `fern_small_01` (Fern)
- **Status:** ✅ Validated
- **Height:** 0.34 m
- **Dimensions (X × Y × Z):** 0.588 × 0.351 × 0.774 m
- **Bounding Box:**
  - Min: `[-0.3034, -0.0108, -0.4109]`
  - Max: `[0.2849, 0.34, 0.3635]`
- **Root Penetration ($y_{\min}$):** -0.0108 m (anchor into terrain)
- **Geometry:** 140 triangles (420 vertices, non-indexed, 70 double-sided pairs)
- **Triangle Areas:** min = 0.00015016 m², max = 0.0029271 m², total surface = 0.1875 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9069$, max $n_y = 0.9994$, avg $n_y = 0.9646$
- **Vertex Color Range:**
  - Min RGB: `[0.0122, 0.0331, 0.0085]`
  - Max RGB: `[0.4339, 0.64, 0.1597]`
  - Avg RGB: `[0.1106, 0.2231, 0.0429]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 16 456 bytes

### 2. `fern_wide_01` (Fern)
- **Status:** ✅ Validated
- **Height:** 0.6 m
- **Dimensions (X × Y × Z):** 0.992 × 0.609 × 1.237 m
- **Bounding Box:**
  - Min: `[-0.5691, -0.0094, -0.6881]`
  - Max: `[0.4225, 0.6, 0.5491]`
- **Root Penetration ($y_{\min}$):** -0.0094 m (anchor into terrain)
- **Geometry:** 210 triangles (630 vertices, non-indexed, 105 double-sided pairs)
- **Triangle Areas:** min = 0.00054862 m², max = 0.0065309 m², total surface = 0.6421 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9014$, max $n_y = 1$, avg $n_y = 0.9658$
- **Vertex Color Range:**
  - Min RGB: `[0.0075, 0.0228, 0.0131]`
  - Max RGB: `[0.2106, 0.4017, 0.1106]`
  - Avg RGB: `[0.0687, 0.1667, 0.0503]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 24 012 bytes

### 3. `flower_purple_01` (Flower)
- **Status:** ✅ Validated
- **Height:** 0.42 m
- **Dimensions (X × Y × Z):** 0.172 × 0.43 × 0.206 m
- **Bounding Box:**
  - Min: `[-0.0863, -0.0103, -0.1234]`
  - Max: `[0.0854, 0.42, 0.0831]`
- **Root Penetration ($y_{\min}$):** -0.0103 m (anchor into terrain)
- **Geometry:** 132 triangles (396 vertices, non-indexed, 66 double-sided pairs)
- **Triangle Areas:** min = 0.0000261 m², max = 0.00033484 m², total surface = 0.0155 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.8762$, max $n_y = 0.998$, avg $n_y = 0.8958$
- **Vertex Color Range:**
  - Min RGB: `[0.0128, 0.0284, 0.0072]`
  - Max RGB: `[0.4564, 0.5175, 0.7454]`
  - Avg RGB: `[0.1609, 0.136, 0.2795]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 15 600 bytes

### 4. `flower_white_01` (Flower)
- **Status:** ✅ Validated
- **Height:** 0.26 m
- **Dimensions (X × Y × Z):** 0.227 × 0.272 × 0.216 m
- **Bounding Box:**
  - Min: `[-0.1075, -0.012, -0.128]`
  - Max: `[0.1195, 0.26, 0.0882]`
- **Root Penetration ($y_{\min}$):** -0.012 m (anchor into terrain)
- **Geometry:** 126 triangles (378 vertices, non-indexed, 63 double-sided pairs)
- **Triangle Areas:** min = 0.000055344 m², max = 0.00038651 m², total surface = 0.021 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.8881$, max $n_y = 0.9996$, avg $n_y = 0.9744$
- **Vertex Color Range:**
  - Min RGB: `[0.0137, 0.0329, 0.0077]`
  - Max RGB: `[0.9047, 0.8796, 0.807]`
  - Avg RGB: `[0.5309, 0.4992, 0.3097]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 14 948 bytes

### 5. `flower_yellow_01` (Flower)
- **Status:** ✅ Validated
- **Height:** 0.3 m
- **Dimensions (X × Y × Z):** 0.246 × 0.311 × 0.167 m
- **Bounding Box:**
  - Min: `[-0.1031, -0.0109, -0.0759]`
  - Max: `[0.1431, 0.3, 0.0908]`
- **Root Penetration ($y_{\min}$):** -0.0109 m (anchor into terrain)
- **Geometry:** 124 triangles (372 vertices, non-indexed, 62 double-sided pairs)
- **Triangle Areas:** min = 0.000022244 m², max = 0.00042516 m², total surface = 0.0175 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.8762$, max $n_y = 0.9997$, avg $n_y = 0.948$
- **Vertex Color Range:**
  - Min RGB: `[0.0142, 0.0343, 0.008]`
  - Max RGB: `[1, 0.6867, 0.1098]`
  - Avg RGB: `[0.5306, 0.4014, 0.0375]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 14 712 bytes

### 6. `grass_dry_straw_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.36 m
- **Dimensions (X × Y × Z):** 0.552 × 0.372 × 0.61 m
- **Bounding Box:**
  - Min: `[-0.2463, -0.0121, -0.3193]`
  - Max: `[0.3056, 0.36, 0.2906]`
- **Root Penetration ($y_{\min}$):** -0.0121 m (anchor into terrain)
- **Geometry:** 90 triangles (270 vertices, non-indexed, 45 double-sided pairs)
- **Triangle Areas:** min = 0.00027094 m², max = 0.00085145 m², total surface = 0.0456 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9007$, max $n_y = 0.9967$, avg $n_y = 0.9528$
- **Vertex Color Range:**
  - Min RGB: `[0.051, 0.0456, 0.0142]`
  - Max RGB: `[0.7949, 0.6272, 0.2563]`
  - Avg RGB: `[0.3521, 0.2631, 0.0847]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 11 060 bytes

### 7. `grass_forest_sparse_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.22 m
- **Dimensions (X × Y × Z):** 0.315 × 0.229 × 0.412 m
- **Bounding Box:**
  - Min: `[-0.145, -0.0095, -0.2149]`
  - Max: `[0.1704, 0.22, 0.1967]`
- **Root Penetration ($y_{\min}$):** -0.0095 m (anchor into terrain)
- **Geometry:** 60 triangles (180 vertices, non-indexed, 30 double-sided pairs)
- **Triangle Areas:** min = 0.00011193 m², max = 0.00041626 m², total surface = 0.014 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.8963$, max $n_y = 0.9905$, avg $n_y = 0.9362$
- **Vertex Color Range:**
  - Min RGB: `[0.0121, 0.0256, 0.0086]`
  - Max RGB: `[0.4465, 0.4144, 0.1284]`
  - Avg RGB: `[0.1416, 0.1653, 0.0445]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 7 832 bytes

### 8. `grass_meadow_thin_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.3 m
- **Dimensions (X × Y × Z):** 0.42 × 0.31 × 0.4 m
- **Bounding Box:**
  - Min: `[-0.2217, -0.0099, -0.2153]`
  - Max: `[0.1986, 0.3, 0.1843]`
- **Root Penetration ($y_{\min}$):** -0.0099 m (anchor into terrain)
- **Geometry:** 96 triangles (288 vertices, non-indexed, 48 double-sided pairs)
- **Triangle Areas:** min = 0.00019991 m², max = 0.00051478 m², total surface = 0.0306 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.8958$, max $n_y = 0.9857$, avg $n_y = 0.9357$
- **Vertex Color Range:**
  - Min RGB: `[0.016, 0.0361, 0.0104]`
  - Max RGB: `[0.4423, 0.6511, 0.1607]`
  - Avg RGB: `[0.1144, 0.2211, 0.0437]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 11 716 bytes

### 9. `grass_meadow_wide_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.34 m
- **Dimensions (X × Y × Z):** 0.566 × 0.352 × 0.531 m
- **Bounding Box:**
  - Min: `[-0.3058, -0.0116, -0.2405]`
  - Max: `[0.2602, 0.34, 0.2908]`
- **Root Penetration ($y_{\min}$):** -0.0116 m (anchor into terrain)
- **Geometry:** 90 triangles (270 vertices, non-indexed, 45 double-sided pairs)
- **Triangle Areas:** min = 0.00051522 m², max = 0.0013526 m², total surface = 0.0766 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.899$, max $n_y = 0.9942$, avg $n_y = 0.9482$
- **Vertex Color Range:**
  - Min RGB: `[0.0127, 0.0306, 0.0071]`
  - Max RGB: `[0.5152, 0.6707, 0.1549]`
  - Avg RGB: `[0.137, 0.2472, 0.0446]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 11 072 bytes

### 10. `grass_olive_tuft_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.26 m
- **Dimensions (X × Y × Z):** 0.613 × 0.273 × 0.518 m
- **Bounding Box:**
  - Min: `[-0.3037, -0.0129, -0.273]`
  - Max: `[0.3088, 0.26, 0.2454]`
- **Root Penetration ($y_{\min}$):** -0.0129 m (anchor into terrain)
- **Geometry:** 84 triangles (252 vertices, non-indexed, 42 double-sided pairs)
- **Triangle Areas:** min = 0.00062051 m², max = 0.0012521 m², total surface = 0.0706 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.936$, max $n_y = 0.9995$, avg $n_y = 0.9731$
- **Vertex Color Range:**
  - Min RGB: `[0.0221, 0.0288, 0.0086]`
  - Max RGB: `[0.4497, 0.4438, 0.1197]`
  - Avg RGB: `[0.1375, 0.1588, 0.0374]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 10 424 bytes

### 11. `grass_path_edge_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.22 m
- **Dimensions (X × Y × Z):** 0.411 × 0.233 × 0.277 m
- **Bounding Box:**
  - Min: `[-0.0648, -0.0125, -0.1057]`
  - Max: `[0.3466, 0.22, 0.1714]`
- **Root Penetration ($y_{\min}$):** -0.0125 m (anchor into terrain)
- **Geometry:** 90 triangles (270 vertices, non-indexed, 45 double-sided pairs)
- **Triangle Areas:** min = 0.00030591 m², max = 0.00096221 m², total surface = 0.0575 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9444$, max $n_y = 0.9995$, avg $n_y = 0.9762$
- **Vertex Color Range:**
  - Min RGB: `[0.0644, 0.0501, 0.0258]`
  - Max RGB: `[0.4097, 0.575, 0.1291]`
  - Avg RGB: `[0.1605, 0.2206, 0.0553]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 11 064 bytes

### 12. `grass_shade_dark_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.24 m
- **Dimensions (X × Y × Z):** 0.572 × 0.255 × 0.728 m
- **Bounding Box:**
  - Min: `[-0.3251, -0.0146, -0.4393]`
  - Max: `[0.2465, 0.24, 0.289]`
- **Root Penetration ($y_{\min}$):** -0.0146 m (anchor into terrain)
- **Geometry:** 70 triangles (210 vertices, non-indexed, 35 double-sided pairs)
- **Triangle Areas:** min = 0.000914 m², max = 0.002681 m², total surface = 0.1216 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9324$, max $n_y = 0.9995$, avg $n_y = 0.9707$
- **Vertex Color Range:**
  - Min RGB: `[0.0051, 0.0152, 0.0078]`
  - Max RGB: `[0.1254, 0.3029, 0.1145]`
  - Avg RGB: `[0.0362, 0.1082, 0.0439]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 8 908 bytes

### 13. `grass_short_dense_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.15 m
- **Dimensions (X × Y × Z):** 0.216 × 0.161 × 0.194 m
- **Bounding Box:**
  - Min: `[-0.1239, -0.0111, -0.0838]`
  - Max: `[0.0919, 0.15, 0.1102]`
- **Root Penetration ($y_{\min}$):** -0.0111 m (anchor into terrain)
- **Geometry:** 84 triangles (252 vertices, non-indexed, 42 double-sided pairs)
- **Triangle Areas:** min = 0.00047502 m², max = 0.0010196 m², total surface = 0.0522 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9013$, max $n_y = 0.9606$, avg $n_y = 0.9301$
- **Vertex Color Range:**
  - Min RGB: `[0.0078, 0.0228, 0.0061]`
  - Max RGB: `[0.2362, 0.4711, 0.0701]`
  - Avg RGB: `[0.0527, 0.1418, 0.0227]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 10 428 bytes

### 14. `grass_short_soft_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.17 m
- **Dimensions (X × Y × Z):** 0.284 × 0.181 × 0.297 m
- **Bounding Box:**
  - Min: `[-0.1366, -0.0105, -0.1334]`
  - Max: `[0.1474, 0.17, 0.1636]`
- **Root Penetration ($y_{\min}$):** -0.0105 m (anchor into terrain)
- **Geometry:** 60 triangles (180 vertices, non-indexed, 30 double-sided pairs)
- **Triangle Areas:** min = 0.00029635 m², max = 0.00062656 m², total surface = 0.0257 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9062$, max $n_y = 0.9894$, avg $n_y = 0.9437$
- **Vertex Color Range:**
  - Min RGB: `[0.0127, 0.0306, 0.0071]`
  - Max RGB: `[0.3702, 0.6147, 0.1139]`
  - Avg RGB: `[0.0879, 0.1989, 0.0328]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 7 832 bytes

### 15. `grass_tall_seeded_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.54 m
- **Dimensions (X × Y × Z):** 0.426 × 0.551 × 0.41 m
- **Bounding Box:**
  - Min: `[-0.2159, -0.0109, -0.1759]`
  - Max: `[0.2097, 0.54, 0.2341]`
- **Root Penetration ($y_{\min}$):** -0.0109 m (anchor into terrain)
- **Geometry:** 102 triangles (306 vertices, non-indexed, 51 double-sided pairs)
- **Triangle Areas:** min = 0.00025888 m², max = 0.00076627 m², total surface = 0.0457 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.8762$, max $n_y = 0.9934$, avg $n_y = 0.926$
- **Vertex Color Range:**
  - Min RGB: `[0.0191, 0.0407, 0.0089]`
  - Max RGB: `[0.7913, 0.6858, 0.3613]`
  - Avg RGB: `[0.2639, 0.3114, 0.0944]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 12 364 bytes

### 16. `grass_tall_wild_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.52 m
- **Dimensions (X × Y × Z):** 0.665 × 0.531 × 0.652 m
- **Bounding Box:**
  - Min: `[-0.2459, -0.0113, -0.2907]`
  - Max: `[0.4188, 0.52, 0.3614]`
- **Root Penetration ($y_{\min}$):** -0.0113 m (anchor into terrain)
- **Geometry:** 90 triangles (270 vertices, non-indexed, 45 double-sided pairs)
- **Triangle Areas:** min = 0.00044641 m², max = 0.0014043 m², total surface = 0.082 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.8881$, max $n_y = 0.9984$, avg $n_y = 0.9405$
- **Vertex Color Range:**
  - Min RGB: `[0.014, 0.0336, 0.0087]`
  - Max RGB: `[0.5816, 0.5298, 0.1554]`
  - Avg RGB: `[0.1515, 0.2171, 0.0463]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 11 064 bytes

### 17. `grass_wavy_broad_01` (Grass)
- **Status:** ✅ Validated
- **Height:** 0.3 m
- **Dimensions (X × Y × Z):** 0.574 × 0.313 × 0.77 m
- **Bounding Box:**
  - Min: `[-0.238, -0.013, -0.3967]`
  - Max: `[0.3359, 0.3, 0.3732]`
- **Root Penetration ($y_{\min}$):** -0.013 m (anchor into terrain)
- **Geometry:** 100 triangles (300 vertices, non-indexed, 50 double-sided pairs)
- **Triangle Areas:** min = 0.00077479 m², max = 0.0016329 m², total surface = 0.117 m²
- **Normal Y-Orientation (Hemisphere Bias):** min $n_y = 0.9172$, max $n_y = 0.9951$, avg $n_y = 0.9553$
- **Vertex Color Range:**
  - Min RGB: `[0.0082, 0.0267, 0.0107]`
  - Max RGB: `[0.2479, 0.5324, 0.1357]`
  - Avg RGB: `[0.0752, 0.2146, 0.0578]`
- **Material:** `vegetation` (doubleSided: false, roughness: 0.92, metallic: 0)
- **Binary Size:** 12 148 bytes

---

## 4. Verification Check Criteria

Every model passed the following 12 automated checks:
1. **GLB Header Check:** Magic `0x46546c67`, Version 2, Length matches file size.
2. **GLB Chunks Check:** Chunk 0 is `JSON` (`0x4e4f534a`), Chunk 1 is `BIN` (`0x004e4942`), 0 trailing bytes.
3. **No Unwanted Nodes:** 0 cameras, 0 punctual lights, 0 animations, 0 skins.
4. **Single Mesh & Primitive:** Exactly 1 mesh, 1 primitive with mode 4 (TRIANGLES).
5. **Attribute Conformance:** `POSITION`, `NORMAL`, `COLOR_0` present as `VEC3 Float32` (componentType 5126).
6. **Material Configuration:** Single material named `vegetation`, `FrontSide` (`doubleSided: false`), roughness `0.92`, metalness `0.0`.
7. **Numerical Integrity:** Zero `NaN` or `Infinity` in any attribute.
8. **Unit Normals & Soft Upward Bias:** All normals are unit length; all $n_y \ge 0$ for uniform hemispherical illumination.
9. **Color Range:** All vertex color values in $[0.0, 1.0]$.
10. **Non-Degenerate Geometry:** Zero zero-area triangles, zero collapsed edges.
11. **Two-Sided Winding Symmetry:** 100% of triangles exist in consecutive `(2k, 2k+1)` pairs with reversed vertex order and matched upward normals.
12. **Manifest Consistency:** Matches dimensions, bounding box, triangle counts, and height specs in `grass_asset_manifest.json`.

---

*Report automatically generated by `tools/grass-validation/validate-grass-assets.mjs`.*
