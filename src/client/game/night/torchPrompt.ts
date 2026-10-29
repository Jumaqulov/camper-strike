/**
 * "Tong otguncha" — gulxan yonidagi [E]/[F] prompti va har bir tugma nima qilishi (sof funksiyalar, testlar uchun).
 *
 * Spetsifikatsiya: mash'al gulxandan [E] bilan olinadi. Qo'lda o'tin bo'lmasa va gulxan yonib tursa E — "Mash'al
 * olish". O'tin bo'lsa E avvalo gulxanga o'tin tashlaydi (gulxan muhimroq) — u holda promptda mash'alni [F] olishi
 * aniq yoziladi. [F] — qo'shimcha tugma: yonib turgan gulxandan mash'al oladi, qo'ldagisini istalgan joyda tashlaydi.
 * Prompt yozuvi va E bosilgandagi amal bitta funksiyadan (firePromptUz) — ko'rsatilgan bilan bajariladigan ajralmaydi.
 */

/** [E] gulxan nishonida: o'tin tashlash, mash'al olish yoki "o'tin yo'q" xabari. */
export type FireEAction = 'feed' | 'takeTorch' | 'noWood';

/** [F]: mash'al olish (yonib turgan gulxan nishonda) yoki tashlash (qo'lda bo'lsa); null — hech narsa. */
export type TorchKeyAction = 'take' | 'drop' | null;

export interface FirePromptInput {
  /** Qo'ldagi o'tin soni. */
  wood: number;
  /** Nishondagi gulxan yonib turibdimi. */
  lit: boolean;
  /** Qo'lda mash'al bormi. */
  torchHeld: boolean;
}

/** Promptdagi bitta tugma qismi: "[E] Mash'al olish". */
export interface PromptKeyPart {
  key: 'E' | 'F';
  label: string;
}

export interface FirePrompt {
  /** [E] bosilganda nima bo'ladi. */
  e: FireEAction;
  /** [F] bosilganda nima bo'ladi (shu gulxan nishonda). */
  f: TorchKeyAction;
  /** Promptdagi tugma qismlari tartib bilan: avval [E], kerak bo'lsa keyin [F]. */
  parts: PromptKeyPart[];
  /** 'camp' — E amal bajaradi; 'empty' — E faqat "o'tin yo'q" deydi (kulrang prompt). */
  variant: 'camp' | 'empty';
}

export const TORCH_TAKE_LABEL_UZ = "Mash'al olish";
export const TORCH_DROP_LABEL_UZ = "Mash'alni tashlash";

/** [F] amali: qo'lda mash'al bo'lsa — istalgan joyda tashlash; yo'q bo'lsa — nishondagi gulxan yonib tursa olish. */
export function torchKeyAction(torchHeld: boolean, fireLit: boolean): TorchKeyAction {
  if (torchHeld) return 'drop';
  return fireLit ? 'take' : null;
}

/**
 * Gulxan prompti: o'tin bo'lsa "[E] Gulxanga o'tin tashlash (N ta) · [F] Mash'al olish"; qo'l bo'sh va gulxan
 * yonib tursa "[E] Mash'al olish" (F ham oladi, lekin asosiy tugma — E); aks holda "[E] Gulxan — o'tin yo'q".
 * Qo'lda mash'al bo'lsa [F] qismi "Mash'alni tashlash".
 */
export function firePromptUz(i: FirePromptInput): FirePrompt {
  const wood = Math.max(0, Math.floor(i.wood));
  const f = torchKeyAction(i.torchHeld, i.lit);
  const fPart: PromptKeyPart | null =
    f === 'take' ? { key: 'F', label: TORCH_TAKE_LABEL_UZ } : f === 'drop' ? { key: 'F', label: TORCH_DROP_LABEL_UZ } : null;
  if (wood > 0) {
    const parts: PromptKeyPart[] = [{ key: 'E', label: `Gulxanga o'tin tashlash (${wood} ta)` }];
    if (fPart) parts.push(fPart);
    return { e: 'feed', f, parts, variant: 'camp' };
  }
  if (f === 'take') return { e: 'takeTorch', f, parts: [{ key: 'E', label: TORCH_TAKE_LABEL_UZ }], variant: 'camp' };
  const parts: PromptKeyPart[] = [{ key: 'E', label: "Gulxan — o'tin yo'q" }];
  if (fPart) parts.push(fPart);
  return { e: 'noWood', f, parts, variant: 'empty' };
}

/** Prompt matni (LootUI `text`): "[E] Gulxanga o'tin tashlash (2 ta) · [F] Mash'al olish". */
export function firePromptText(p: FirePrompt): string {
  return p.parts.map((x) => `[${x.key}] ${x.label}`).join(' · ');
}

/** Prompt HTML (LootUI `html`, gulxan holati qatori chaqiruvchida qo'shiladi): tugma pill'lari "·" bilan ajratiladi. */
export function firePromptHtml(p: FirePrompt): string {
  return p.parts
    .map(
      (x, i) =>
        `${i > 0 ? ' <span class="prompt-sep">·</span> ' : ''}<span class="key-pill">${x.key}</span><span>${x.label}</span>`,
    )
    .join('');
}
