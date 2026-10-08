// Original geometric fixtures, deliberately labelled as tests rather than AI images.
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
await mkdir('output/test-media', { recursive: true });
for (const [name, background, accent, label] of [
  ['character', '#203536', '#a8cec0', 'CHARACTER / 01'],
  ['scene', '#342c24', '#d6b689', 'SCENE / 01'],
]) {
  const svg = `<svg width="960" height="640" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="640" fill="${background}"/><circle cx="740" cy="160" r="200" fill="${accent}" opacity=".12"/><path d="M0 500 L260 290 L530 530 L800 270 L960 400 V640 H0" fill="${accent}" opacity=".22"/><rect x="64" y="64" width="38" height="5" fill="${accent}"/><text x="64" y="128" font-family="Arial" font-size="26" fill="${accent}">${label}</text><text x="64" y="560" font-family="Arial" font-size="14" fill="${accent}">M2 LOCAL UPLOAD TEST</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(`output/test-media/${name}.png`);
}
