# Bo'ri ovozlari — Google AI Studio uchun generatsiya promtlari

O'yindagi `Audio.ts` hozir barcha bo'ri ovozlarini WebAudio osilatorlari bilan sintez qiladi.
Quyidagi promtlar har bir sintez funksiyasining o'rniga haqiqiy ovoz fayli olish uchun yozilgan.
Har promt ingliz tilida (generativ modellar shunda aniqroq ishlaydi), sarlavha va izoh o'zbekcha.

## Umumiy talablar (har promt oldiga qo'shib yuboring)

```
Sound design brief for a game sound effect. Output requirements:
- A single dry sound effect, NO music, NO ambience, NO wind, NO birds, NO reverb, NO echo.
- Recorded "close-mic" perspective, as if the microphone is 1 metre from the animal's mouth.
  The game engine adds its own 3D position, distance falloff and room acoustics.
- Mono, 44.1 kHz, 16-bit WAV, peak-normalised to -1 dBFS, no fade-in, hard clean start.
- No human voice, no dog-like friendliness: this is a large wild grey wolf, feral and menacing.
- Keep the exact duration requested.
```

Agar model bir martada bir nechta variant bera olsa, har ovozdan 2–3 variant so'rang
(`Give me 3 different takes`) — o'yinda takrorlanish sezilmasligi uchun.

---

## 1. Uvlash — `wolfHowl` (~3 s, 160 m gacha eshitiladi)

Qachon: bo'ri o'yinchini ko'rib, lekin yeta olmay to'daga xabar beradi; to'lqin boshlanishida.

```
A lone adult grey wolf howling at night. One long, mournful howl, 3.0 seconds total:
starts low and breathy, rises smoothly in pitch over the first second, holds a strong
sustained note with a slight natural vibrato, then falls and tails off into a soft exhale.
Full-throated, powerful chest resonance, slightly hoarse edge. Single animal, no pack answering.
Dry close recording, no reverb or distance.
```

Variant (to'da boshlig'i — `alpha`):
```
Same howl, but from a very large, old alpha wolf: noticeably deeper and rougher,
more gravel in the throat, slower rise, 3.5 seconds.
```

## 2. Hurish — `wolfBark` (0.5 s, ov boshlanganini bildiradi)

Qachon: bo'ri o'yinchini birinchi marta ko'rganda (oddiy va chaqqon bo'rilar).

```
A wild wolf's aggressive alarm bark: two short, sharp, explosive barks in quick
succession ("WUF-WUF"), about 0.25 seconds apart, 0.5 seconds total. Deep chesty attack,
hoarse and raw, not a domestic dog bark — lower, rougher, more guttural. Cuts off cleanly
after the second bark with no trailing breath. Dry, close-mic.
```

## 3. Irillash — `wolfGrowl` (0.9 s, poylash / qorong'udan yaqinlashish)

Qachon: bo'ri o'yinchini sezib poylay boshlaganda; "Tun soyasi" hurish o'rniga shuni qiladi.

```
A menacing low wolf growl, 0.9 seconds: a continuous rumbling growl with a rough,
rattling vocal-fry texture, starting mid-low and sinking slightly lower by the end.
Teeth bared, lips vibrating, a faint wet rasp of breath under it. Threatening and
restrained, not yet attacking. Ends with a short snort. Dry close-mic recording.
```

Variant ("Tun soyasi" — `shadow`, jimroq, nafasli):
```
Same growl but quieter and more breathy, almost whispered through the throat,
as if the wolf is trying not to be heard. 0.9 seconds.
```

## 4. Tashlanish oldi irillashi — `wolfSnarl` (0.45 s)

Qachon: hujumga tashlanishdan bir lahza oldin.

```
A sudden violent wolf snarl right before a lunge, 0.45 seconds: an explosive,
rising snarl that bursts out of a growl, saliva and teeth, ending with a sharp
click-snap of the jaws closing on air at the very end. Fast attack, aggressive,
close and loud. Dry close-mic, no reverb.
```

## 5. Tishlash — tegdi — `wolfBite(hit=true)` (~0.4 s)

Qachon: tish o'yinchiga tegdi.

```
A wolf bite impact on a human body, 0.4 seconds: a sharp wet jaw-snap, immediately
followed by a muffled heavy thud of teeth hitting flesh and cloth, then a short
tearing, grinding, cloth-ripping texture as the wolf clamps and shakes. Visceral and
punchy, no scream, no blood splash, no music. Dry, close-mic.
```

## 6. Tishlash — tegmadi — `wolfBite(hit=false)` (~0.2 s)

Qachon: bo'ri havoni tishladi.

```
A wolf's jaws snapping shut on empty air, 0.2 seconds: a quick "whuff" of air
displaced by the lunge and a hard dry teeth-clack at the end. Fast, clean, no growl,
no reverb. Close-mic.
```

## 7. Nafas looplari — `wolfVoice` (uzluksiz, har bo'ri uchun)

Bu looplar har kadr masofa va kayfiyatga qarab aralashtiriladi. Har biri 3–4 s,
**boshi va oxiri bir-biriga seamless ulanadigan** bo'lishi shart.

Tinch (`calm`, bo'ri tentirab yuribdi):
```
Seamless loop, 4.0 seconds, of a large wolf breathing calmly through its nose while
walking: slow, deep, relaxed breaths, about 1.5 breaths per second, soft nasal air
with a faint low chest rumble. Must loop perfectly with no click at the join.
Dry close-mic, no footsteps, no reverb.
```

Hushyor (`alert`, hidlayapti):
```
Seamless loop, 3.0 seconds, of a wolf sniffing and breathing alertly: quick short
sniffs through the nose, about 2.5 per second, with occasional slightly longer
inhales, and a very faint uneasy throat rumble. Perfect loop, no click. Dry, close-mic.
```

Ov (`threat`, quvib kelayapti — eng muhimi):
```
Seamless loop, 3.0 seconds, of a wolf panting hard while sprinting after prey:
fast, heavy, open-mouthed panting, about 3.5 pants per second, wet tongue and
saliva texture, aggressive and excited, with a continuous low angry growl
underneath every exhale. Perfect loop, no click at the join. Dry, close-mic,
no footsteps, no reverb.
```

Qochish (`flee`, tong otdi — tez nafas, irillashsiz):
```
Seamless loop, 3.0 seconds, of a frightened wolf panting while running away:
fast shallow panting, about 3 pants per second, nervous and whimpery, NO growl,
a faint high whine on some exhales. Perfect loop, no click. Dry, close-mic.
```

## 8. Uzluksiz irillash loopi — `wolfVoice` growl qatlami (ovda)

```
Seamless loop, 3.0 seconds, of a continuous low wolf growl held steady: deep,
rumbling, rattling vocal-fry, teeth bared, no barks, no breaks, constant intensity
so it can be faded in and out by the game. Perfect loop with no click at the join.
Dry close-mic, no reverb.
```

## 9. Qo'shimcha (hozircha kodda yo'q, keyin qo'shish mumkin)

O'q tegdi — jarohat:
```
A wolf's sharp pain yelp when hit, 0.5 seconds: a sudden high "KYIP" yelp that
cracks and drops into a short angry snarl. Raw and startled. Dry close-mic.
```

O'lim:
```
A wolf dying, 1.8 seconds: a choked gurgling snarl that collapses into a weak,
rattling whine and two shallow final breaths, then silence. Not cartoonish, grim and
quiet at the end. Dry close-mic, no music.
```

Bo'rini olov qo'rqitdi (gulxanga yaqinlashganda):
```
A wolf startled by fire, 0.7 seconds: a sharp surprised snort, a short frightened
whine and a quick scramble-away snarl. Dry close-mic, no fire crackle.
```

---

## Fayl nomlari (o'yinga qo'shishda shu nomlar bilan `public/sfx/wolf/` ga qo'ying)

| Funksiya | Fayl |
|---|---|
| wolfHowl | howl_01.wav, howl_02.wav, howl_alpha_01.wav |
| wolfBark | bark_01.wav, bark_02.wav |
| wolfGrowl | growl_01.wav, growl_02.wav, growl_shadow_01.wav |
| wolfSnarl | snarl_01.wav, snarl_02.wav |
| wolfBite hit | bite_hit_01.wav, bite_hit_02.wav |
| wolfBite miss | bite_miss_01.wav |
| wolfVoice calm | loop_breath_calm.wav |
| wolfVoice alert | loop_breath_alert.wav |
| wolfVoice threat | loop_breath_threat.wav |
| wolfVoice flee | loop_breath_flee.wav |
| wolfVoice growl | loop_growl.wav |
| (yangi) hit / death / fire | yelp_01.wav, death_01.wav, fire_scare_01.wav |

Olingan fayllarni shu papkaga tashlang — keyin `Audio.ts` dagi sintezni fayl
pleybekiga (AudioBuffer + mavjud `wolfDest` panner/so'nish) almashtiramiz,
masofa va kayfiyat mantig'i o'zgarmaydi.
