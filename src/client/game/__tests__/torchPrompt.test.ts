import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  TORCH_DROP_LABEL_UZ,
  TORCH_TAKE_LABEL_UZ,
  firePromptHtml,
  firePromptText,
  firePromptUz,
  torchKeyAction,
} from '../night/torchPrompt';
import { formatTorchPillUz } from '../survival/SurvivalUI';

// "Tong otguncha" mash'ali (6-band): gulxandan [E] bilan olinadi (qo'l bo'sh bo'lsa), o'tin bo'lsa E o'tin tashlaydi
// va promptda mash'alni [F] olishi yoziladi; F — qo'shimcha olish/tashlash tugmasi. Mash'al qo'lda ekan pill'da
// "[F] tashlash" ishorasi turadi; sozlamalardagi tugmalar ro'yxatida E (mash'al, turg'izish), F va X bor.

describe("Mash'al prompti — [E] asosiy, [F] qo'shimcha (6-band)", () => {
  it("1. Qo'l bo'sh, gulxan yonib turibdi: E — mash'al oladi, prompt \"[E] Mash'al olish\"; F ham oladi", () => {
    const p = firePromptUz({ wood: 0, lit: true, torchHeld: false });
    assert.equal(p.e, 'takeTorch');
    assert.equal(p.f, 'take');
    assert.equal(p.variant, 'camp');
    assert.equal(firePromptText(p), "[E] Mash'al olish");
    assert.deepEqual(p.parts, [{ key: 'E', label: TORCH_TAKE_LABEL_UZ }]);
  });

  it("2. O'tin bor, gulxan yonib turibdi: E — o'tin tashlaydi (ustun), promptda mash'alni F olishi aniq yozilgan", () => {
    const p = firePromptUz({ wood: 2, lit: true, torchHeld: false });
    assert.equal(p.e, 'feed');
    assert.equal(p.f, 'take');
    assert.equal(p.variant, 'camp');
    assert.equal(firePromptText(p), "[E] Gulxanga o'tin tashlash (2 ta) · [F] Mash'al olish");
  });

  it("3. Gulxan o'chgan: mash'al taklif qilinmaydi; o'tin bo'lsa E tashlaydi, bo'lmasa — kulrang \"o'tin yo'q\"", () => {
    const feed = firePromptUz({ wood: 1, lit: false, torchHeld: false });
    assert.equal(feed.e, 'feed');
    assert.equal(feed.f, null);
    assert.equal(firePromptText(feed), "[E] Gulxanga o'tin tashlash (1 ta)");
    const empty = firePromptUz({ wood: 0, lit: false, torchHeld: false });
    assert.equal(empty.e, 'noWood');
    assert.equal(empty.f, null);
    assert.equal(empty.variant, 'empty');
    assert.equal(firePromptText(empty), "[E] Gulxan — o'tin yo'q");
  });

  it("4. Mash'al qo'lda: E ikkinchisini olmaydi; F — tashlash (o'tin bo'lsa ham, bo'lmasa ham)", () => {
    const bare = firePromptUz({ wood: 0, lit: true, torchHeld: true });
    assert.equal(bare.e, 'noWood');
    assert.equal(bare.f, 'drop');
    assert.equal(bare.variant, 'empty');
    assert.equal(firePromptText(bare), `[E] Gulxan — o'tin yo'q · [F] ${TORCH_DROP_LABEL_UZ}`);
    const wood = firePromptUz({ wood: 3, lit: true, torchHeld: true });
    assert.equal(wood.e, 'feed');
    assert.equal(wood.f, 'drop');
    assert.equal(firePromptText(wood), `[E] Gulxanga o'tin tashlash (3 ta) · [F] ${TORCH_DROP_LABEL_UZ}`);
  });

  it("5. [F] amali gulxansiz ham: qo'lda mash'al — istalgan joyda tashlash; yo'q bo'lsa faqat yonib turgan gulxanda olish", () => {
    assert.equal(torchKeyAction(true, false), 'drop');
    assert.equal(torchKeyAction(true, true), 'drop');
    assert.equal(torchKeyAction(false, true), 'take');
    assert.equal(torchKeyAction(false, false), null);
  });

  it('6. HTML: tugma pill\'lari "·" ajratgich bilan, matn bilan bir xil tartibda', () => {
    const one = firePromptHtml(firePromptUz({ wood: 0, lit: true, torchHeld: false }));
    assert.equal(one, `<span class="key-pill">E</span><span>Mash'al olish</span>`);
    const two = firePromptHtml(firePromptUz({ wood: 2, lit: true, torchHeld: false }));
    assert.equal(
      two,
      `<span class="key-pill">E</span><span>Gulxanga o'tin tashlash (2 ta)</span> <span class="prompt-sep">·</span> <span class="key-pill">F</span><span>Mash'al olish</span>`,
    );
  });

  it("7. Kasr/manfiy o'tin soni pastga yaxlitlanadi: 0.5 o'tin — qo'l bo'sh (E mash'al oladi)", () => {
    assert.equal(firePromptUz({ wood: 0.5, lit: true, torchHeld: false }).e, 'takeTorch');
    assert.equal(firePromptUz({ wood: -1, lit: true, torchHeld: false }).e, 'takeTorch');
  });
});

describe("Mash'al ishorasi va tugmalar ro'yxati (6-band)", () => {
  it("1. Mash'al qo'lda ekan pill doim \"[F] tashlash\" ishorasini ko'rsatadi; oxirgi 8 s — 'low'; mash'al yo'q — null", () => {
    assert.deepEqual(formatTorchPillUz(32.2), { text: "🔥 Mash'al 33 s · [F] tashlash", cls: '' });
    assert.deepEqual(formatTorchPillUz(7.5), { text: "🔥 Mash'al 8 s · [F] tashlash", cls: 'low' });
    assert.deepEqual(formatTorchPillUz(0.2), { text: "🔥 Mash'al 1 s · [F] tashlash", cls: 'low' });
    assert.equal(formatTorchPillUz(0), null);
    assert.equal(formatTorchPillUz(Number.NaN), null);
  });

  it("2. Sozlamalardagi tugmalar ro'yxati: E — mash'al olish va turg'izish, F — mash'al olish/tashlash, X — signal raketasi", () => {
    const html = readFileSync(new URL('../../../../index.html', import.meta.url), 'utf8');
    const block = html.match(/<div class="controls-help">([\s\S]*?)<\/div>\s*<button/);
    assert.ok(block, 'controls-help bloki topildi');
    const lines = [...block![1].matchAll(/<div><b>([^<]+)<\/b>([^<]*)<\/div>/g)].map((m) => ({ key: m[1], text: m[2] }));
    const has = (key: string, re: RegExp) => lines.some((l) => l.key === key && re.test(l.text));
    assert.ok(has('E', /mash'al olish/), "E — mash'al olish qatori");
    assert.ok(has('E', /turg'izish/), "E — yiqilgan sherikni turg'izish qatori");
    assert.ok(has('F', /mash'al olish \/ tashlash/), "F — mash'al olish/tashlash qatori");
    assert.ok(has('X', /signal raketasi/), 'X — signal raketasi qatori');
  });
});
