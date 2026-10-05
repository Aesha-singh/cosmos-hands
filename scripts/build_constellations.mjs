#!/usr/bin/env node
/* =============================================================================
 *  COSMOS HANDS — constellation dataset builder
 * =============================================================================
 *  Produces  src/data/constellations.json  from three public, freely licensed
 *  astronomical catalogues:
 *
 *    1. HYG v4.1 database  (astronexus/HYG-Database, CC BY-SA 4.0)
 *       → star positions, magnitudes, distances, B-V colours, spectral types,
 *         proper names, Bayer / Flamsteed designations.
 *    2. d3-celestial constellation figures  (ofrohn/d3-celestial, BSD-3)
 *       → the 88 IAU constellation stick figures as RA/Dec polylines.
 *    3. d3-celestial constellation metadata  (ofrohn/d3-celestial, BSD-3)
 *       → Latin names, genitives, centres, English names.
 *
 *  Every figure vertex is *snapped to the nearest real catalogue star* so the
 *  line art and the point stars are guaranteed to coincide — that is what
 *  makes "point at a star to identify it" work in CONSTELLATION MODE.
 *
 *  Output format (compact, columnar to keep the bundle small):
 *    { stars: { ra[], dec[], mag[], dist[], bv[], spec[], name[], hip[] },
 *      names: [...], spectralTypes: [...],
 *      constellations: [ { abbr, name, genitive, meaning, brightest,
 *                          ra, dec, size, lines: [[i0,i1,i2,…], …] } ] }
 *
 *  Usage:  node scripts/build_constellations.mjs [--offline]
 *  Offline mode uses whatever is already in .cache/catalogues/.
 * ============================================================================= */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE = resolve(ROOT, '.cache/catalogues');
const OUT = resolve(ROOT, 'src/data/constellations.json');

/** Hard cut on naked-eye limiting magnitude — 6.6 is a realistic dark-sky floor. */
const MAG_LIMIT = 6.6;
/** Max angular snap error, degrees (figure data is derived from this catalogue). */
const SNAP_TOLERANCE_DEG = 0.35;

const SOURCES = {
  hyg: 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
  lines: 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json',
  meta: 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.json',
  starnames: 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/starnames.json',
};

const OFFLINE = process.argv.includes('--offline');

/* -------------------------------------------------------------------------- */
/* tiny helpers                                                               */
/* -------------------------------------------------------------------------- */

const log = (...a) => console.log('[catalog]', ...a);
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const grn = (s) => `\x1b[32m${s}\x1b[0m`;
const ylw = (s) => `\x1b[33m${s}\x1b[0m`;

const exists = (p) => access(p).then(() => true, () => false);

/** Minimal RFC-4180 field splitter (handles quotes + doubled escapes). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Cosine of the angular separation between two equatorial positions, degrees. */
function angularSep(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const d = (dec1 - dec2) * r;
  const a = (ra1 - ra2) * r;
  const cosD = Math.sin(d / 2) ** 2 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(a / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(cosD))) / r;
}

/**
 * Normalise right ascension to [0, 360).
 * Essential: HYG stores 0..24h, d3-celestial stores -180..+180. Without this
 * every figure vertex west of the vernal equinox fails to match any star.
 */
const norm360 = (ra) => ((ra % 360) + 360) % 360;

/* -------------------------------------------------------------------------- */
/* download + cache                                                           */
/* -------------------------------------------------------------------------- */

async function loadSource(key, url, { json = false } = {}) {
  await mkdir(CACHE, { recursive: true });
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const file = resolve(CACHE, `${key}.${hash}${json ? '.json' : '.csv'}`);

  if (await exists(file)) {
    const size = (await readFile(file)).length;
    log(dim(`cache hit  ${key} ${dim(`(${size} bytes)`)}`));
    return readFile(file, 'utf8');
  }

  if (OFFLINE) throw new Error(`offline and no cache for ${key}`);

  log(`fetching    ${key} …`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  await writeFile(file, text);
  log(grn(`cached     ${key} ${dim(`(${(text.length / 1048576).toFixed(1)} MB)`)}`));
  return text;
}

/* -------------------------------------------------------------------------- */
/* 1. HYG star catalogue                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parse HYG into a compact star list.
 *
 * NOTE: the magnitude filter is deliberately NOT applied here. Constellation
 * figures draw on stars fainter than naked-eye limit (e.g. Aql, Cyg, Sgr), and
 * we must snap *those* vertices onto real catalogue entries too — otherwise the
 * figure simply disappears. Trimming to MAG_LIMIT happens later, once we know
 * which stars are actually referenced.
 *
 * @param {string} csv
 * @returns {{stars: Array<object>, maxHip: number, faint: number}}
 */
function parseHyg(csv) {
  const nl = csv.indexOf('\n');
  const header = splitCsvLine(csv.slice(0, nl)).map((h) => h.replace(/"/g, '').trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const need = ['ra', 'dec', 'mag', 'dist', 'ci', 'spect', 'proper', 'hip', 'bayer', 'flam', 'con'];
  for (const n of need) if (col[n] === undefined) throw new Error(`HYG: missing column "${n}"`);

  const stars = [];
  let maxHip = 0;
  let faint = 0;
  let pos = nl + 1;
  const len = csv.length;

  while (pos < len) {
    let end = csv.indexOf('\n', pos);
    if (end === -1) end = len;
    const line = csv.slice(pos, end);
    pos = end + 1;
    if (line.length < 32) continue;

    const f = splitCsvLine(line);
    const mag = parseFloat(f[col.mag]);
    if (!Number.isFinite(mag)) continue;

    // HYG stores right ascension in HOURS; the rest of the pipeline (and the
    // d3-celestial figures we snap against) works in degrees.
    const ra = parseFloat(f[col.ra]) * 15;
    const dec = parseFloat(f[col.dec]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;

    const hipRaw = (f[col.hip] ?? '').trim();
    const hip = hipRaw ? parseInt(hipRaw, 10) : 0;
    if (Number.isFinite(hip)) maxHip = Math.max(maxHip, hip);
    if (mag > MAG_LIMIT) faint++;

    stars.push({
      ra, dec, mag,
      dist: parseFloat(f[col.dist]) || 0,
      ci: parseFloat(f[col.ci]) || 0,
      spect: (f[col.spect] ?? '').trim(),
      proper: (f[col.proper] ?? '').trim(),
      hip,
      bayer: (f[col.bayer] ?? '').trim(),
      flam: (f[col.flam] ?? '').trim(),
      con: (f[col.con] ?? '').trim(),
    });
  }
  log(grn(`HYG        ${stars.length} stars parsed (${faint} fainter than mag ${MAG_LIMIT})`));
  return { stars, maxHip, faint };
}

/* -------------------------------------------------------------------------- */
/* 2. spatial index for snapping                                               */
/* -------------------------------------------------------------------------- */

/** Uniform dec/ra grid over the unit sphere for O(1) nearest-neighbour queries. */
function buildIndex(stars) {
  const DEC_BINS = 180;              // 1° tall bins
  const RA_BINS = 180;               // 2° wide bins
  const bins = new Map();
  const key = (db, rb) => db * 4096 + rb;
  /** Bin coordinates for an equatorial position, RA normalised to [0,360). */
  const cell = (ra, dec) => [
    Math.min(DEC_BINS - 1, Math.max(0, Math.floor((dec + 90) / 180 * DEC_BINS))),
    Math.min(RA_BINS - 1, Math.max(0, Math.floor(norm360(ra) / 360 * RA_BINS))),
  ];

  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    const k = key(...cell(s.ra, s.dec));
    let b = bins.get(k);
    if (!b) bins.set(k, (b = []));
    b.push(i);
  }
  return {
    /** @returns {number} index of nearest star to (ra, dec) within tolerance, else -1 */
    nearest(ra, dec, tol = SNAP_TOLERANCE_DEG) {
      const [db, rb] = cell(ra, dec);
      let best = -1;
      let bestD = tol;
      for (let dd = -1; dd <= 1; dd++) {
        for (let dr = -1; dr <= 1; dr++) {
          // RA wraps, so wrap the bin index rather than clamping it.
          const b = bins.get(key(db + dd, (rb + dr + RA_BINS) % RA_BINS));
          if (!b) continue;
          for (const i of b) {
            const s = stars[i];
            const d = angularSep(ra, dec, s.ra, s.dec);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      return best;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 3. spectral type lookup                                                     */
/* -------------------------------------------------------------------------- */

const SPECTRAL_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T', 'Y', 'C', 'S', 'W', 'D', '?', 'E'];

function spectralIndex(type) {
  if (!type) return SPECTRAL_CLASSES.indexOf('?');
  const c = type[0].toUpperCase();
  const i = SPECTRAL_CLASSES.indexOf(c);
  return i === -1 ? SPECTRAL_CLASSES.indexOf('?') : i;
}

/* -------------------------------------------------------------------------- */
/* 4. build                                                                   */
/* -------------------------------------------------------------------------- */

async function main() {
  log('COSMOS HANDS · catalogue build');

  const [hygCsv, linesJson, metaJson, starnamesJson] = await Promise.all([
    loadSource('hyg', SOURCES.hyg),
    loadSource('lines', SOURCES.lines, { json: true }),
    loadSource('meta', SOURCES.meta, { json: true }),
    loadSource('starnames', SOURCES.starnames, { json: true }),
  ]);

  const { stars: hygStars, maxHip } = parseHyg(hygCsv);
  const index = buildIndex(hygStars);

  const figures = JSON.parse(linesJson).features;
  const metaByAbbr = new Map();
  for (const f of JSON.parse(metaJson).features) {
    if (!metaByAbbr.has(f.id)) metaByAbbr.set(f.id, f);
  }
  const snByHip = JSON.parse(starnamesJson);
  log(dim(`figures    ${figures.length} (Serpens arrives split → 88 IAU constellations)`));

  /* ---- 4a. snap every figure vertex to a catalogue star ------------------ */
  const outConstellations = [];
  const used = new Set();
  let totalVerts = 0;
  let totalSnapped = 0;

  for (const fig of figures) {
    const abbr = fig.id;
    const coords = fig.geometry.coordinates;         // MultiLineString
    const lines = [];
    let snappedHere = 0;
    let vertsHere = 0;

    for (const poly of coords) {
      // Split the polyline wherever a vertex cannot be matched to a star:
      // that gracefully degrades an open figure instead of dropping it.
      let run = [];
      for (const [ra, dec] of poly) {
        vertsHere++;
        const i = index.nearest(ra, dec);
        if (i === -1) {
          if (run.length > 1) lines.push(run);
          run = [];
        } else {
          snappedHere++;
          used.add(i);
          run.push(i);
        }
      }
      // Flush the trailing run for THIS polyline. Pushing inside the loop would
      // push the same mutable array once per vertex, duplicating every segment.
      if (run.length > 1) lines.push(run);
    }

    totalVerts += vertsHere;
    totalSnapped += snappedHere;

    const meta = metaByAbbr.get(abbr);
    let ra = meta?.geometry?.coordinates?.[0] ?? 0;
    let dec = meta?.geometry?.coordinates?.[1] ?? 0;

    // Let the HUD label sit at the geometric centre of the actual line art,
    // falling back to the catalogue centre for empty figures.
    if (lines.length) {
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const poly of lines) {
        for (const i of poly) {
          const s = hygStars[i];
          const r = (s.ra * Math.PI) / 180, d = (s.dec * Math.PI) / 180;
          sx += Math.cos(d) * Math.cos(r); sy += Math.cos(d) * Math.sin(r); sz += Math.sin(d);
          n++;
        }
      }
      if (n) {
        const R = Math.hypot(sx, sy, sz) || 1;
        ra = (Math.atan2(sy / R, sx / R) * 180) / Math.PI;
        dec = (Math.asin(Math.max(-1, Math.min(1, sz / R))) * 180) / Math.PI;
      }
    }

    // Angular extent, for HUD scale-framing.
    let size = 10;
    if (lines.length) {
      let maxD = 0;
      for (const poly of lines) {
        const a = hygStars[poly[0]], b = hygStars[poly[poly.length - 1]];
        maxD = Math.max(maxD, angularSep(a.ra, a.dec, b.ra, b.dec));
      }
      size = Math.max(6, Math.round(maxD));
    }

    outConstellations.push({
      abbr,
      name: meta?.properties?.name ?? abbr,
      genitive: meta?.properties?.gen ?? abbr,
      meaning: meta?.properties?.en && meta.properties.en !== meta.properties.name
        ? meta.properties.en
        : meta?.properties?.name ?? '',
      ra: +ra.toFixed(4),
      dec: +dec.toFixed(4),
      size,
      lines,
      // brightest star resolved later, once indices are stable
      _starIdx: [],
    });
  }

  /* ---- 4a-bis. merge figures the source splits --------------------------- */
  // d3-celestial ships Serpens as two features that share the IAU abbreviation
  // `Ser` (Caput and Cauda). They are one constellation, so merge them: the
  // figure is discontinuous in the sky, and the IAU list has 88 entries.
  const byAbbr = new Map();
  for (const c of outConstellations) {
    const existing = byAbbr.get(c.abbr);
    if (!existing) { byAbbr.set(c.abbr, c); continue; }
    existing.lines.push(...c.lines);
    // "Serpens Caput" + "Serpens Cauda" -> "Serpens": keep the shared head word.
    const [a, b] = [existing.name, c.name].sort();
    const shared = a.split(' ').find((word, i) => b.split(' ')[i] === word);
    existing.name = shared && shared.length > 3 ? shared : a;
  }
  const merged = [...byAbbr.values()];
  if (merged.length !== outConstellations.length) {
    log(dim(`merge      ${outConstellations.length} figures -> ${merged.length} constellations `
      + `(${outConstellations.length - merged.length} split figure(s) joined)`));
    outConstellations.length = 0;
    outConstellations.push(...merged);
  }

  log(grn(`snap       ${totalSnapped}/${totalVerts} figure vertices matched to catalogue stars`));

  /* ---- 4b. compact the star table ---------------------------------------- */
  // Keep every star referenced by a figure, plus the brightest `MAG_LIMIT` set.
  const keep = new Set(used);
  for (let i = 0; i < hygStars.length; i++) if (hygStars[i].mag <= MAG_LIMIT) keep.add(i);

  // Sort by magnitude so index 0 is the brightest — the renderer can then draw
  // the first N stars first for cheap level-of-detail. The remap MUST be built
  // from this final order: deriving it before sorting silently re-points every
  // constellation vertex at an unrelated star.
  const order = [...keep].sort((a, b) => hygStars[a].mag - hygStars[b].mag || hygStars[a].hip - hygStars[b].hip);
  const remap = new Map();
  const kept = order.map((oldIdx, newIdx) => { remap.set(oldIdx, newIdx); return hygStars[oldIdx]; });
  log(dim(`table      ${kept.length} stars kept (${used.size} referenced by figures)`));

  const nameIndex = new Map();
  const names = [];
  const nameOf = (n) => {
    if (!n) return -1;
    if (!nameIndex.has(n)) { nameIndex.set(n, names.length); names.push(n); }
    return nameIndex.get(n);
  };

  const raA = [], decA = [], magA = [], distA = [], bvA = [], specA = [], nameA = [], hipA = [];
  const conA = [], bayerA = [], flamA = [];

  for (const s of kept) {
    raA.push(+s.ra.toFixed(4));
    decA.push(+s.dec.toFixed(4));
    magA.push(+s.mag.toFixed(2));
    distA.push(s.dist > 0 ? +s.dist.toFixed(2) : -1);
    bvA.push(+Math.max(-0.5, Math.min(3.5, s.ci || 0)).toFixed(3));
    specA.push(spectralIndex(s.spect));
    nameA.push(nameOf(s.proper));
    hipA.push(s.hip || 0);
    conA.push(s.con ? s.con.charCodeAt(0) : 0);
    bayerA.push(s.bayer ? s.bayer.charCodeAt(0) : 0);
    flamA.push(s.flam ? parseInt(s.flam, 10) || 0 : 0);
  }

  /* ---- 4c. re-index the line art + resolve brightest stars ---------------- */
  for (const c of outConstellations) {
    c.lines = c.lines.map((poly) => poly.map((i) => remap.get(i)).filter((v) => v !== undefined));
    c.lines = c.lines.filter((poly) => poly.length > 1);

    // brightest star actually drawn in this figure, else overall brightest
    let bestIdx = -1;
    let bestMag = Infinity;
    for (const poly of c.lines) {
      for (const i of poly) {
        const m = magA[i];
        if (m < bestMag) { bestMag = m; bestIdx = i; }
      }
    }
    if (bestIdx === -1) {
      for (let i = 0; i < kept.length; i++) {
        if (conA[i] === (c.abbr.charCodeAt(0) | 0) && magA[i] < bestMag) { bestMag = magA[i]; bestIdx = i; }
      }
    }
    c.brightest = bestIdx;
    c.brightestName = bestIdx >= 0 && nameA[bestIdx] >= 0 ? names[nameA[bestIdx]] : '';
    c.brightestMag = bestIdx >= 0 ? magA[bestIdx] : 99;
    delete c._starIdx;
  }

  /* ---- 4d. emit ---------------------------------------------------------- */
  const payload = {
    version: 4,
    built: new Date().toISOString().slice(0, 10),
    magLimit: MAG_LIMIT,
    attribution: {
      catalogue: 'HYG Database v4.1 (astronexus) — CC BY-SA 4.0',
      figures: 'd3-celestial (ofrohn) — BSD-3-Clause',
    },
    spectralTypes: SPECTRAL_CLASSES,
    spectralNotes: [
      'O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T', 'Y', 'C', 'S', 'W', 'D', '?', 'E',
    ],
    names,
    stars: {
      count: kept.length,
      hipMax: maxHip,
      ra: raA, dec: decA, mag: magA, dist: distA, bv: bvA,
      spec: specA, name: nameA, hip: hipA,
      con: conA, bayer: bayerA, flam: flamA,
    },
    // RA hours 0..24 for the HUD readout
    constellations: outConstellations.sort((a, b) => a.abbr.localeCompare(b.abbr)),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));

  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);
  const uniqueAbbr = new Set(outConstellations.map((c) => c.abbr)).size;
  const totalSegs = outConstellations.reduce((n, c) => n + c.lines.reduce((m, l) => m + l.length - 1, 0), 0);

  log(grn(`wrote      src/data/constellations.json ${dim(`(${kb} KB)`)}`));
  log(`           ${uniqueAbbr} constellations · ${kept.length} stars · ${totalSegs} line segments`);

  /* ---- 4e. self-check ---------------------------------------------------- */
  const problems = [];
  if (uniqueAbbr !== 88) problems.push(`expected 88 IAU constellations, got ${uniqueAbbr}`);
  for (const c of outConstellations) {
    if (!c.lines.length) problems.push(`${c.abbr}: no line art survived snapping`);
    if (c.lines.length && c.brightest < 0) problems.push(`${c.abbr}: no brightest star`);
  }
  if (problems.length) {
    log(ylw(`warnings (${problems.length}):`));
    for (const p of problems.slice(0, 12)) log(`   ${p}`);
    if (problems.length > 12) log(dim(`   … and ${problems.length - 12} more`));
  } else {
    log(grn('self-check passed: 88 constellations, all with line art + brightest star'));
  }
}

main().catch((err) => {
  console.error(ylw('[catalog] build failed:'), err.message);
  process.exitCode = 1;
});
