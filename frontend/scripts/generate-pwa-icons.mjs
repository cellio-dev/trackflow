import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const iconsDir = path.join(publicDir, "icons");

/** Opaque PWA background — flatten removes alpha; iOS often shows a blank/grey icon for transparent PNGs. */
const BG = { r: 10, g: 14, b: 23 };

async function pngFromSvg(svgPath, outPath, size) {
  const buf = await sharp(fs.readFileSync(svgPath))
    .resize(size, size)
    .flatten({ background: BG })
    .png()
    .toBuffer();
  fs.writeFileSync(outPath, buf);
}

await fs.promises.mkdir(iconsDir, { recursive: true });

const mark = path.join(publicDir, "trackflow-mark.svg");
const markMask = path.join(publicDir, "trackflow-mark-maskable.svg");

await pngFromSvg(mark, path.join(iconsDir, "icon-192.png"), 192);
await pngFromSvg(mark, path.join(iconsDir, "icon-512.png"), 512);
await pngFromSvg(markMask, path.join(iconsDir, "icon-maskable-512.png"), 512);
await pngFromSvg(mark, path.join(iconsDir, "apple-touch-icon.png"), 180);

console.log("Wrote PWA icons under public/icons/");
