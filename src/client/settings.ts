export type QualityLevel = 'low' | 'medium' | 'high';

export interface GameSettings {
  name: string;
  sens: number;
  sensitivity?: number;
  volume: number;
  fov: number;
  quality: QualityLevel;
  /** FPS past bo'lsa sifatni avtomatik pasaytirish (kuchsiz / integratsiyalangan GPU lar uchun). */
  autoQuality: boolean;
}

export type Settings = GameSettings;

const KEY = 'stickman-strike-settings';

export function loadSettings(): Settings {
  const def: Settings = {
    name: 'Sardor',
    sens: 1.0,
    sensitivity: 1.0,
    volume: 0.7,
    fov: 80,
    quality: 'medium',
    autoQuality: true,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const name =
        typeof parsed.name === 'string' && parsed.name.trim().length > 0
          ? parsed.name.trim().slice(0, 16)
          : 'Sardor';
      const rawSens =
        typeof parsed.sens === 'number' && !Number.isNaN(parsed.sens)
          ? parsed.sens
          : typeof parsed.sensitivity === 'number' && !Number.isNaN(parsed.sensitivity)
            ? parsed.sensitivity
            : 1.0;
      const sens = Math.max(0.1, Math.min(4.0, rawSens));
      const volume =
        typeof parsed.volume === 'number' && !Number.isNaN(parsed.volume)
          ? Math.max(0, Math.min(1.0, parsed.volume))
          : 0.7;
      const fov =
        typeof parsed.fov === 'number' && !Number.isNaN(parsed.fov)
          ? Math.max(60, Math.min(110, Math.round(parsed.fov)))
          : 80;
      let quality: QualityLevel = parsed.quality;
      if (quality !== 'low' && quality !== 'medium' && quality !== 'high') {
        quality = 'medium';
      }
      return {
        name,
        sens,
        sensitivity: sens,
        volume,
        fov,
        quality,
        autoQuality: parsed.autoQuality !== false,
      };
    }
  } catch {
    /* e'tibor bermaymiz */
  }
  return { ...def };
}

export function saveSettings(s: Settings): void {
  try {
    const rawSens = typeof s.sens === 'number' ? s.sens : (typeof s.sensitivity === 'number' ? s.sensitivity : 1.0);
    const sensVal = Math.max(0.1, Math.min(4.0, Number.isNaN(rawSens) ? 1.0 : rawSens));
    const nameVal = s.name && s.name.trim() ? s.name.trim().slice(0, 16) : 'Sardor';
    const volVal = typeof s.volume === 'number' && !Number.isNaN(s.volume) ? Math.max(0, Math.min(1.0, s.volume)) : 0.7;
    const fovVal = typeof s.fov === 'number' && !Number.isNaN(s.fov) ? Math.max(60, Math.min(110, Math.round(s.fov))) : 80;
    const qualityVal: QualityLevel = s.quality === 'low' || s.quality === 'high' ? s.quality : 'medium';
    const toSave = {
      name: nameVal,
      sens: sensVal,
      sensitivity: sensVal,
      volume: volVal,
      fov: fovVal,
      quality: qualityVal,
      autoQuality: s.autoQuality !== false,
    };
    localStorage.setItem(KEY, JSON.stringify(toSave));
  } catch {
    /* e'tibor bermaymiz */
  }
}

