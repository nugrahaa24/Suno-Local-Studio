// download_tracks.js (no external deps)
const https = require('https');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = [
  { url: 'https://musicfile.kie.ai/NGRmZjRjZmQtNGE5Yy00MDg5LWE1YjctYjNhOGNlMWRiNzEx.mp3', name: 'GuildOfStars_1.mp3' },
  { url: 'https://musicfile.kie.ai/MTFiMTZkNjgtYjJiMi00OGE3LTlkM2QtZTI1N2E5NTg3OTA2.mp3', name: 'GuildOfStars_2.mp3' }
];

function download(file) {
  return new Promise((res, rej) => {
    const outPath = path.join(outDir, file.name);
    const fileStream = fs.createWriteStream(outPath);
    https.get(file.url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        // follow redirect
        https.get(r.headers.location, (r2) => r2.pipe(fileStream).on('finish', () => res(outPath)));
        return;
      }
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode));
      r.pipe(fileStream).on('finish', () => res(outPath));
    }).on('error', rej);
  });
}

(async () => {
  try {
    for (const f of files) {
      console.log('Downloading', f.name);
      const p = await download(f);
      console.log('Saved to', p);
    }
    console.log('All done.');
  } catch (e) {
    console.error('Download failed:', e.message);
  }
})();
