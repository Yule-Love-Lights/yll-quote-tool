// Loads and caches image assets used by the canvas renderer (wreaths, bows,
// garland, custom uploads later). Drop your PNGs in `client/public/items/`.

const ASSETS: Record<string, string> = {
  "wreath-with-lights": "/items/wreath-with-lights.png",
  "wreath-without-lights": "/items/wreath-without-lights.png",
  "wreathbow-with-lights": "/items/wreathbow-with-lights.png",
  "wreathbow-without-lights": "/items/wreathbow-without-lights.png",
  "bow": "/items/bow.png",
  "garland-with-lights": "/items/garland-with-lights.png",
  "garland-without-lights": "/items/garland-without-lights.png",
};

const cache: Record<string, HTMLImageElement | null | "loading"> = {};
const waiters: Record<string, ((img: HTMLImageElement | null) => void)[]> = {};

export function getAssetSync(key: string): HTMLImageElement | null {
  const v = cache[key];
  if (v && v !== "loading") return v;
  return null;
}

export function isAssetAvailable(key: string): boolean {
  return cache[key] instanceof HTMLImageElement;
}

export function loadAsset(key: string): Promise<HTMLImageElement | null> {
  const url = ASSETS[key];
  if (!url) return Promise.resolve(null);
  const v = cache[key];
  if (v instanceof HTMLImageElement) return Promise.resolve(v);
  if (v === null) return Promise.resolve(null);
  if (v === "loading") {
    return new Promise((res) => {
      (waiters[key] ??= []).push(res);
    });
  }
  cache[key] = "loading";
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      cache[key] = img;
      res(img);
      (waiters[key] ?? []).forEach((w) => w(img));
      delete waiters[key];
    };
    img.onerror = () => {
      cache[key] = null;
      res(null);
      (waiters[key] ?? []).forEach((w) => w(null));
      delete waiters[key];
    };
    img.src = url;
  });
}

export async function preloadAssets(): Promise<void> {
  await Promise.all(Object.keys(ASSETS).map((k) => loadAsset(k)));
}
