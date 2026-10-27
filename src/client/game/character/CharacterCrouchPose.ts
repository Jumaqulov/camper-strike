import * as THREE from 'three';
import { CROUCH_STRIDE_SCALE } from '../animation/locomotionState';
import type { CharacterBoneMap } from './CharacterAimPose';

/**
 * O'tirish (crouch) pozasi — Camper Buddy rig uchun protsedural qatlam (GLB da crouch klipi yo'q).
 *
 * Har kadrda `mixer.update()` dan KEYIN va `applyUpperBodyAimPose()` dan OLDIN chaqiriladi:
 *  - Hips character space'da `CROUCH_HIP_DROP` ga pastga va `CROUCH_HIP_BACK` ga orqaga (+Z) suriladi,
 *    tos `CROUCH_PELVIS_TILT` ga oldinga egiladi (Rx(−tilt): +Y o'qi −Z tomonga og'adi);
 *    klipning pastga "bob"i (Walk qadam chekkalarida Hips pasayadi) `CROUCH_HIP_BOB_CANCEL` ulushda
 *    bekor qilinadi — aks holda chuqur o'tirishda tos oyoqlar sig'maydigan darajada pastlab ketadi;
 *  - har bir oyoq analitik ikki-bo'g'inli IK bilan qayta yechiladi: to'piq (Foot bo'g'ini) klip
 *    balandligida qoladi (oyoq yerda), oldinga/orqaga qadam esa `CROUCH_STRIDE_SCALE` marta qisqaradi
 *    (Walk timeScale ham shunga moslangan — locomotionState); son (UpperLeg) oldinga ko'tariladi,
 *    boldir (LowerLeg) orqaga bukiladi; tizza tekisligi klipnikidan (amount 0) tos oldi +
 *    `CROUCH_KNEE_SPLAY` (amount 1) tomon aralashtiriladi — amount 0 atrofida sakrash yo'q. Orqadagi
 *    oyoq tizzasi yerga kirib ketadigan bo'lsa (`CROUCH_KNEE_MIN_Y`), tizza tashqariga buriladi;
 *  - Foot ning character space yo'nalishi klipnikidek saqlanadi (taglik yerga parallel, Toe tegilmaydi).
 *
 * Nega aim pozasidan OLDIN: u Spine/Chest/Neck ni haqiqiy (egilgan) Hips ga nisbatan stabillaydi —
 * qurolli holatda qo'llar/bosh nishonga qarab qoladi, tos egilishining faqat ~15 % i tanaga o'tadi
 * (yengil oldinga egilish). Keyin qo'llansa, egilgan Hips butun ustki tanani (qurolni ham) pastga
 * burib yuborardi. Bu modul faqat Hips va oyoq suyaklariga yozadi, aim pozasi esa ularga tegmaydi —
 * ikki qatlamning idempotentlik hisobi bir-biriga xalaqit bermaydi.
 *
 * Bind poza (GLB dan o'qilgan, testlar tekshiradi): barcha suyaklarning lokal o'qlari character space
 * bilan bir xil (q = I), oyoq zanjiri lokal −Y bo'ylab (UpperLeg→LowerLeg 0.355 m, LowerLeg→Foot
 * 0.335 m), oldinga −Z (Toe (0, −0.11, −0.095)). Burilishlar o'qni taxmin qilmasdan character space'da
 * hisoblanadi va `inv(parentC) · R · parentC` bilan lokalga o'tkaziladi.
 *
 * Idempotentlik: THREE.PropertyMixer qiymat o'zgarmasa trekni qayta yozmaydi (muzlagan mixer, doimiy
 * treklar) — suyakda bizning oldingi natijamiz qolgan bo'lsa (bone == lastOut), avval klip qiymati
 * tiklanadi (CharacterAimPose bilan bir xil usul). Amount 0 — sof klip pozasi (hech narsa yozilmaydi).
 * Rig masshtabi 1 deb hisoblanadi (GLB da shunday; klipda scale treki yo'q). Har chaqiruvda ajratish yo'q.
 */

/** Hips ning to'liq o'tirishdagi pastga siljishi (character space), m. Bosh ≈ 0.5 m pastga tushadi. */
export const CROUCH_HIP_DROP = 0.5;
/** Hips ning orqaga (+Z) siljishi, m — og'irlik markazi tovonlar ustida, orqadagi oyoqqa joy qoladi. */
export const CROUCH_HIP_BACK = 0.09;
/** GLB bind pozasidagi Hips balandligi (character space), m — klip "bob"ini o'lchash uchun. */
export const CROUCH_REST_HIPS_Y = 0.83;
/** Klip Hips ni shu balandlikdan pastga tushirgan qismining bekor qilinadigan ulushi (o'tirganda). */
export const CROUCH_HIP_BOB_CANCEL = 0.7;
/** Tizza bo'g'ini markazining eng past balandligi (character space; yer = 0), m. */
export const CROUCH_KNEE_MIN_Y = 0.07;
/** Tosning oldinga egilishi, rad. */
export const CROUCH_PELVIS_TILT = 0.25;
/** Tizzalarning tashqariga ochilishi (vertikal atrofida), rad — sonlar qorin ichiga kirmasin. */
export const CROUCH_KNEE_SPLAY = 0.3;

interface LegChain {
  upper: THREE.Bone;
  lower: THREE.Bone;
  foot: THREE.Bone;
  /** −1 chap (−X), +1 o'ng (+X). */
  side: number;
  thighLen: number;
  shinLen: number;
}

interface CrouchBoneSet {
  root: THREE.Bone | undefined;
  hips: THREE.Bone;
  legs: LegChain[];
  /** Kvaternioni yoziladigan suyaklar: Hips, so'ng har bir oyoq uchun UpperLeg, LowerLeg, Foot. */
  written: THREE.Bone[];
  lastClip: THREE.Quaternion[];
  lastOut: THREE.Quaternion[];
  lastClipHipsPos: THREE.Vector3;
  lastOutHipsPos: THREE.Vector3;
}

const boneCache = new WeakMap<CharacterBoneMap, CrouchBoneSet | null>();

function resolveBones(bones: CharacterBoneMap): CrouchBoneSet | null {
  const cached = boneCache.get(bones);
  if (cached !== undefined) return cached;
  const hips = bones.get('Hips');
  const legs: LegChain[] = [];
  for (const [suffix, side] of [['L', -1], ['R', 1]] as const) {
    const upper = bones.get('UpperLeg_' + suffix);
    const lower = bones.get('LowerLeg_' + suffix);
    const foot = bones.get('Foot_' + suffix);
    if (!upper || !lower || !foot) continue;
    const thighLen = lower.position.length();
    const shinLen = foot.position.length();
    if (thighLen < 1e-3 || shinLen < 1e-3) continue;
    legs.push({ upper, lower, foot, side, thighLen, shinLen });
  }
  let set: CrouchBoneSet | null = null;
  if (hips && legs.length === 2) {
    const written = [hips, ...legs.flatMap((l) => [l.upper, l.lower, l.foot])];
    set = {
      root: bones.get('Root'),
      hips,
      legs,
      written,
      lastClip: written.map((b) => b.quaternion.clone()),
      lastOut: written.map(() => new THREE.Quaternion(NaN, NaN, NaN, NaN)),
      lastClipHipsPos: hips.position.clone(),
      lastOutHipsPos: new THREE.Vector3(NaN, NaN, NaN),
    };
  }
  boneCache.set(bones, set);
  return set;
}

/** Mixer qayta yozmagan suyaklarda (bone == lastOut) klip qiymatini tiklaydi, aks holda yangi klip qiymatini eslaydi. */
function restoreClipInputs(b: CrouchBoneSet): void {
  const { written, lastClip, lastOut } = b;
  for (let i = 0; i < written.length; i++) {
    const q = written[i].quaternion;
    if (q.equals(lastOut[i])) q.copy(lastClip[i]);
    else lastClip[i].copy(q);
  }
  const p = b.hips.position;
  if (p.equals(b.lastOutHipsPos)) p.copy(b.lastClipHipsPos);
  else b.lastClipHipsPos.copy(p);
}

function recordOutputs(b: CrouchBoneSet): void {
  for (let i = 0; i < b.written.length; i++) b.lastOut[i].copy(b.written[i].quaternion);
  b.lastOutHipsPos.copy(b.hips.position);
}

// ---------------------------------------------------------------------------------------------
// Vaqtinchalik obyektlar (har chaqiruvda ajratish yo'q)
// ---------------------------------------------------------------------------------------------

const AXIS_X = new THREE.Vector3(1, 0, 0);
const _rootQ = new THREE.Quaternion();
const _rootQInv = new THREE.Quaternion();
const _rootP = new THREE.Vector3();
const _hipsC = new THREE.Quaternion();
const _hipsP = new THREE.Vector3();
const _tilt = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _upperC = new THREE.Quaternion();
const _lowerC = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _des = new THREE.Vector3();
const _g = new THREE.Vector3();
const _out = new THREE.Vector3();
const _center = new THREE.Vector3();
/** Har bir oyoq uchun klip qiymatlari (character space): son bo'g'ini, tizza, to'piq va Foot yo'nalishi. */
const _clipHip = [new THREE.Vector3(), new THREE.Vector3()];
const _clipKnee = [new THREE.Vector3(), new THREE.Vector3()];
const _clipAnkle = [new THREE.Vector3(), new THREE.Vector3()];
const _clipFootC = [new THREE.Quaternion(), new THREE.Quaternion()];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Root (bo'lsa) va Hips ning character space transformi → `_hipsC`, `_hipsP` (va `_rootQ`). */
function hipsFrame(b: CrouchBoneSet): void {
  if (b.root) {
    _rootQ.copy(b.root.quaternion);
    _rootP.copy(b.root.position);
  } else {
    _rootQ.identity();
    _rootP.set(0, 0, 0);
  }
  _hipsC.multiplyQuaternions(_rootQ, b.hips.quaternion);
  _hipsP.copy(b.hips.position).applyQuaternion(_rootQ).add(_rootP);
}

/** Klip pozasidagi oyoq: son bo'g'ini, tizza, to'piq nuqtalari va Foot yo'nalishi (character space). */
function captureClipLeg(leg: LegChain, i: number): void {
  _clipHip[i].copy(leg.upper.position).applyQuaternion(_hipsC).add(_hipsP);
  _upperC.multiplyQuaternions(_hipsC, leg.upper.quaternion);
  _clipKnee[i].copy(leg.lower.position).applyQuaternion(_upperC).add(_clipHip[i]);
  _lowerC.multiplyQuaternions(_upperC, leg.lower.quaternion);
  _clipAnkle[i].copy(leg.foot.position).applyQuaternion(_lowerC).add(_clipKnee[i]);
  _clipFootC[i].multiplyQuaternions(_lowerC, leg.foot.quaternion);
}

/**
 * Ikki-bo'g'inli IK (Hips allaqachon siljigan/egilgan — `_hipsC`, `_hipsP` yangilangan): to'piq
 * `_clipAnkle[i]` nishoniga, tizza `amount` bo'yicha klip tekisligi va o'tirish qutbi orasidagi tekislikda.
 */
function solveLeg(leg: LegChain, i: number, amount: number): void {
  const l1 = leg.thighLen;
  const l2 = leg.shinLen;
  const target = _clipAnkle[i];
  _hip.copy(leg.upper.position).applyQuaternion(_hipsC).add(_hipsP);

  _v.subVectors(target, _hip);
  const distRaw = _v.length();
  if (distRaw < 1e-5) return;
  _u.copy(_v).divideScalar(distRaw);
  const dist = Math.min(Math.max(distRaw, Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);

  // O'tirish qutbi: tos oldi (−Z), vertikal atrofida tashqariga ochilgan (chap −X, o'ng +X)
  const splay = CROUCH_KNEE_SPLAY * amount;
  _pole.set(leg.side * Math.sin(splay), 0, -Math.cos(splay)).applyQuaternion(_hipsC);
  _pole.addScaledVector(_u, -_pole.dot(_u));
  if (_pole.lengthSq() < 1e-8) _pole.set(0, 0, -1).addScaledVector(_u, _u.z);
  _pole.normalize();
  // Klip tizzasi tekisligi (amount 0 da aynan klip pozasi chiqadi)
  _w.subVectors(_clipKnee[i], _clipHip[i]);
  _w.addScaledVector(_u, -_w.dot(_u));
  if (_w.lengthSq() > 1e-8) {
    _w.normalize();
    _f.copy(_w).multiplyScalar(1 - amount).addScaledVector(_pole, amount);
    if (_f.lengthSq() < 1e-8) _f.copy(_pole);
    else _f.normalize();
  } else {
    _f.copy(_pole);
  }

  // Kosinuslar teoremasi: son va (son bo'g'ini → to'piq) chizig'i orasidagi burchak.
  // Tizza aylanada yotadi: markaz C = H + u·l1·cos(A), radius r = l1·sin(A), yo'nalish f.
  const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const r = l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _center.copy(_hip).addScaledVector(_u, l1 * cosA);
  if (_center.y + _f.y * r < CROUCH_KNEE_MIN_Y && r > 1e-4) {
    // Tizza yerga kirib ketadi (orqadagi oyoq, past tos): aylana bo'ylab tashqariga (g) buramiz —
    // 0..90° oralig'idagi eng kichik burchak, bunda tizza CROUCH_KNEE_MIN_Y dan past emas.
    _g.crossVectors(_u, _f);
    if (_g.lengthSq() > 1e-10) {
      _g.normalize();
      _out.set(leg.side, 0, 0).applyQuaternion(_hipsC);
      if (_g.dot(_out) < 0) _g.negate();
      const m = (CROUCH_KNEE_MIN_Y - _center.y) / r;
      const amp = Math.hypot(_f.y, _g.y);
      let phi = Math.PI / 2;
      if (amp > 1e-6 && m <= amp) {
        // f.y·cos φ + g.y·sin φ = amp·cos(φ − φ0) ≥ m  ⇔  |φ − φ0| ≤ acos(m / amp)
        const enter = Math.atan2(_g.y, _f.y) - Math.acos(Math.max(-1, m / amp));
        const e = ((enter % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        phi = Math.min(e, Math.PI / 2);
      }
      _f.multiplyScalar(Math.cos(phi)).addScaledVector(_g, Math.sin(phi)).normalize();
    }
  }
  _knee.copy(_center).addScaledVector(_f, r);

  // Son: joriy yo'nalishni yangi tizza tomon eng qisqa yoy bilan buramiz (klip twist saqlanadi)
  _upperC.multiplyQuaternions(_hipsC, leg.upper.quaternion);
  _cur.copy(leg.lower.position).applyQuaternion(_upperC).normalize();
  _des.subVectors(_knee, _hip).normalize();
  _delta.setFromUnitVectors(_cur, _des);
  _upperC.premultiply(_delta);
  leg.upper.quaternion.copy(_qInv.copy(_hipsC).invert()).multiply(_upperC).normalize();
  _upperC.multiplyQuaternions(_hipsC, leg.upper.quaternion);

  // Boldir: tizzadan to'piq nuqtasiga
  _lowerC.multiplyQuaternions(_upperC, leg.lower.quaternion);
  _cur.copy(leg.foot.position).applyQuaternion(_lowerC).normalize();
  _des.subVectors(target, _knee);
  if (_des.lengthSq() > 1e-10) {
    _des.normalize();
    _delta.setFromUnitVectors(_cur, _des);
    _lowerC.premultiply(_delta);
    leg.lower.quaternion.copy(_qInv.copy(_upperC).invert()).multiply(_lowerC).normalize();
    _lowerC.multiplyQuaternions(_upperC, leg.lower.quaternion);
  }

  // Foot: character space yo'nalishi klipnikidek (taglik yerga parallel qoladi)
  leg.foot.quaternion.copy(_qInv.copy(_lowerC).invert()).multiply(_clipFootC[i]).normalize();
}

/**
 * O'tirish pozasi. `amount` 0 (tik — sof klip) .. 1 (to'liq o'tirish); oraliq qiymatlar chiziqli
 * (yumshatish chaqiruvchida). Har kadrda mixer.update() dan keyin chaqirilsin — amount 0 bo'lsa ham:
 * mixer qayta yozmagan suyaklardagi eski natija shunda tozalanadi.
 */
export function applyCrouchPose(bones: CharacterBoneMap, amount: number): void {
  const b = resolveBones(bones);
  if (!b) return;
  restoreClipInputs(b);
  const a = clamp01(Number.isFinite(amount) ? amount : 0);
  if (a > 1e-4) {
    hipsFrame(b);
    // To'piq nishoni: klip balandligi, oldinga/orqaga qadam qisqartirilgan (character space, ildiz — oyoq nuqtasi)
    const stride = 1 - (1 - CROUCH_STRIDE_SCALE) * a;
    for (let i = 0; i < b.legs.length; i++) {
      captureClipLeg(b.legs[i], i);
      _clipAnkle[i].z *= stride;
    }

    // Hips: character space'da pastga/orqaga siljish va oldinga egilish (Root lokal fazosiga o'tkaziladi)
    const bobBelow = Math.max(0, CROUCH_REST_HIPS_Y - _hipsP.y);
    const dropY = (CROUCH_HIP_DROP - CROUCH_HIP_BOB_CANCEL * bobBelow) * a;
    _rootQInv.copy(_rootQ).invert();
    _v.set(0, -dropY, CROUCH_HIP_BACK * a).applyQuaternion(_rootQInv);
    b.hips.position.add(_v);
    _tilt.setFromAxisAngle(AXIS_X, -CROUCH_PELVIS_TILT * a);
    _q.copy(_hipsC).premultiply(_tilt);
    b.hips.quaternion.copy(_rootQInv).multiply(_q).normalize();
    hipsFrame(b);

    for (let i = 0; i < b.legs.length; i++) solveLeg(b.legs[i], i, a);
  }
  recordOutputs(b);
}
