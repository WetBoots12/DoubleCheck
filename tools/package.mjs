// Builds the zip that is uploaded to the Chrome Web Store.
//
//   npm run package   ->   dist/double-check-<version>.zip
//
// The working folder is not the extension. It also holds 25 MB of training data,
// developer pages, the docs, a 4 MB QR image and forty test files, none of which
// belong in what users install. So the package is built from an explicit list rather
// than by zipping the folder, and before anything is written every file the manifest,
// the pages and the scripts refer to is checked to be in it: a missing file is the
// one mistake that loads fine here and breaks for everyone who installs it.
//
// No dependencies: the zip is written by hand (stored names, deflated data, CRC-32),
// which is a small, well-documented format.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What ships. Directories are walked; tests never ship.
const INCLUDE = [
  'manifest.json',
  'LICENSE',
  'ATTRIBUTION.md', // the ClaimBuster credit is a licence condition of the model
  'src',
  'classifier/inference/classifier.js',
  'classifier/inference/scorer.js',
  'classifier/inference/textprep.js',
  'classifier/model/model.json',
];
const EXCLUDE = [/\.test\.m?js$/, /(^|\/)\.[^/]+$/];

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`listed for packaging but missing: ${rel}`);
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((name) => walk(`${rel}/${name}`));
}

export function packageFiles() {
  return [...new Set(INCLUDE.flatMap(walk))]
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => !EXCLUDE.some((re) => re.test(f)))
    .sort();
}

// --- every reference must resolve inside the package ---------------------------

function referencesIn(file, text) {
  const refs = [];
  const dir = path.posix.dirname(file);
  const local = (ref) => ref && !/^(?:[a-z]+:|\/\/|#|data:)/i.test(ref);
  const add = (ref, base = dir) => { if (local(ref)) refs.push(path.posix.normalize(path.posix.join(base, ref.split(/[?#]/)[0]))); };

  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
    // chrome.runtime.getURL('path') is relative to the extension root.
    for (const m of text.matchAll(/getURL\(\s*['"]([^'"#?]+)/g)) add(m[1], '.');
  }
  if (file.endsWith('.html')) {
    for (const m of text.matchAll(/\s(?:src|href)=["']([^"']+)["']/g)) add(m[1]);
  }
  return refs;
}

function manifestReferences(manifest) {
  const refs = [manifest.background?.service_worker, manifest.side_panel?.default_path, manifest.options_page];
  for (const cs of manifest.content_scripts || []) refs.push(...(cs.js || []), ...(cs.css || []));
  refs.push(...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}));
  return refs.filter(Boolean);
}

export function missingReferences(files) {
  const have = new Set(files);
  const missing = [];
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const ref of manifestReferences(manifest)) if (!have.has(ref)) missing.push(`manifest.json -> ${ref}`);
  for (const file of files) {
    if (!/\.(m?js|html)$/.test(file)) continue;
    for (const ref of referencesIn(file, readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (!have.has(ref)) missing.push(`${file} -> ${ref}`);
    }
  }
  return missing;
}

// --- the zip itself --------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed timestamp, so the same sources always produce the same zip.
const DOS_TIME = 0;                                   // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);            // version made by
    entry.writeUInt16LE(20, 6);            // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// --- run ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = packageFiles();
  const missing = missingReferences(files);
  if (missing.length) {
    console.error('Not packaged: these references point at files that would not be in the zip:');
    for (const m of missing) console.error(`  ${m}`);
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entries = files.map((name) => ({ name, data: readFileSync(path.join(ROOT, name)) }));
  const out = path.join(ROOT, 'dist', `double-check-${version}.zip`);
  mkdirSync(path.dirname(out), { recursive: true });
  const buf = zip(entries);
  writeFileSync(out, buf);
  const raw = entries.reduce((n, e) => n + e.data.length, 0);
  console.log(`${files.length} files, ${(raw / 1024).toFixed(0)} KB -> ${path.relative(ROOT, out)} (${(buf.length / 1024).toFixed(0)} KB)`);
}
