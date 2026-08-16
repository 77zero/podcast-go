'use strict';

// 由 build/icon.svg 生成：
//   build/icon.png  (512x512 主图)
//   build/icon.ico  (多尺寸，Windows)
// 依赖 sharp（仅构建期使用，不打进应用）。

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngs, sizes) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;
  for (let i = 0; i < count; i++) {
    const size = sizes[i];
    const w = size >= 256 ? 0 : size;
    const o = i * 16;
    dir.writeUInt8(w, o + 0);       // width
    dir.writeUInt8(w, o + 1);       // height
    dir.writeUInt8(0, o + 2);       // palette
    dir.writeUInt8(0, o + 3);       // reserved
    dir.writeUInt16LE(1, o + 4);    // planes
    dir.writeUInt16LE(32, o + 6);   // bpp
    dir.writeUInt32LE(pngs[i].length, o + 8); // bytes in resource
    dir.writeUInt32LE(offset, o + 12);        // image offset
    offset += pngs[i].length;
  }
  return Buffer.concat([header, dir, ...pngs]);
}

async function main() {
  const svg = fs.readFileSync(svgPath, 'utf8');
  fs.mkdirSync(buildDir, { recursive: true });

  // 512 主图
  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(path.join(buildDir, 'icon.png'));

  // 各尺寸 PNG（供 ICO）
  const pngs = [];
  for (const s of SIZES) {
    pngs.push(await sharp(Buffer.from(svg)).resize(s, s).png().toBuffer());
  }

  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(pngs, SIZES));
  console.log('generated: build/icon.png (512) + build/icon.ico (' + SIZES.join('/') + ')');
}

main().catch((err) => {
  console.error('icon generation failed:', err);
  process.exit(1);
});
