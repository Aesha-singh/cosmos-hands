/**
 * Major-moon data — real JPL values.
 *
 * Orbital elements are referred to each planet's equator (or Laplace plane for
 * the irregular satellites), in kilometres, which is how JPL publishes them. The
 * scene converts to scene units and parent-local frames at build time.
 *
 * Sources: JPL Solar System Dynamics satellite ephemerides; NASA Planetary
 * Fact Sheet; Scott S. Sheppard, "Satellite of the Planets" (2009).
 *
 * @module data/moons
 */

import { SCALE } from '../config.js';
import { DAY } from '../utils/orbits.js';

const kmToUnits = (km) => km / SCALE.UNIT_KM;

/**
 * @typedef {Object} Moon
 * @property {string} id
 * @property {string} name
 * @property {string} parent Planet id.
 * @property {number} radiusKm
 * @property {number} [massKg]
 * @property {number} aKm Semi-major axis, kilometres.
 * @property {number} e Eccentricity.
 * @property {number} i Inclination to the parent's Laplace/equator plane, degrees.
 * @property {number} periodDays Sidereal orbital period, days.
 * @property {number} [dayHours] Rotation period, hours (most moons are locked).
 * @property {string} discovered
 * @property {string} blurb
 * @property {string} funFact
 * @property {string[]} proceduralKeys
 * @property {boolean} [rings]
 * @property {number} [visualColor]
 */

/** @type {Moon[]} */
export const MOONS = [
  /* ---------------------------------------------------------------- Earth -- */
  {
    id: 'moon',
    name: 'The Moon',
    parent: 'earth',
    radiusKm: 1_737.4,
    massKg: 7.342e22,
    aKm: 384_400,
    e: 0.0549,
    i: 5.145,
    periodDays: 27.3217,
    dayHours: 655.7,          // tidally locked
    discovered: 'prehistoric',
    blurb:
      'Formed from debris of a Mars-sized impact 4.5 billion years ago, and large '
      + 'enough relative to its planet that the pair are nearly a double system. It '
      + 'st stabilises Earth\'s axial tilt, which is why our seasons are predictable.',
    funFact:
      'Every year the Moon moves 3.8 cm further from Earth, and Earth\'s rotation '
      + 'slows by 1.7 milliseconds per century. We are, very slowly, exchanging '
      + 'angular momentum with our own satellite.',
    proceduralKeys: ['moon'],
    visualColor: 0xbdb9b0,
  },

  /* --------------------------------------------------------------- Mars --- */
  {
    id: 'phobos',
    name: 'Phobos',
    parent: 'mars',
    radiusKm: 11.267,
    massKg: 1.0659e16,
    aKm: 9_376,
    e: 0.0151,
    i: 1.093,
    periodDays: 0.31891,
    dayHours: 7.65,
    discovered: '1877 — Asaph Hall',
    blurb:
      'A 22 km lump of carbon-rich rock orbiting closer to its planet than any other '
      + 'moon in the solar system. It is spiralling inward and will be torn apart by '
      + 'Mars\' gravity in roughly 50 million years.',
    funFact:
      'From the surface of Mars, Phobos rises in the west and sets in the west — twice '
      + 'per day — because it orbits faster than Mars rotates.',
    proceduralKeys: ['asteroid'],
    visualColor: 0x8a7f74,
  },
  {
    id: 'deimos',
    name: 'Deimos',
    parent: 'mars',
    radiusKm: 6.2,
    massKg: 1.4762e15,
    aKm: 23_463,
    e: 0.00033,
    i: 0.93,
    periodDays: 1.26244,
    dayHours: 30.3,
    discovered: '1877 — Asaph Hall',
    blurb:
      'The smaller, outer Martian moon: a 12 km body so smooth it looks like a '
      + 'pebble. Its craters are half-buried in its own regolith, which tells us it '
      + 'has been geologically quiet for a long time.',
    funFact: 'Deimos is so small that standing on it, you could jump 12 km high.',
    proceduralKeys: ['asteroid'],
    visualColor: 0x9c9086,
  },

  /* ------------------------------------------------------------- Jupiter --- */
  {
    id: 'io',
    name: 'Io',
    parent: 'jupiter',
    radiusKm: 1_821.6,
    massKg: 8.931938e22,
    aKm: 421_700,
    e: 0.0041,
    i: 0.05,
    periodDays: 1.769138,
    dayHours: 42.46,
    discovered: '1610 — Galileo Galilei',
    blurb:
      'The most volcanically active body in the solar system — over 400 active '
      + 'volcanoes, plumes of sulphur reaching 500 km high. Tidal flexing from Jupiter '
      + 'and its sibling moons pumps in about 100 trillion watts.',
    funFact:
      'Io is being eaten. Its orbit slowly recedes by 1.8 cm per year, and in a few '
      + 'billion years it will be torn into a ring — a miniature of how Saturn got its.',
    proceduralKeys: ['io'],
    visualColor: 0xe8cf6a,
  },
  {
    id: 'europa',
    name: 'Europa',
    parent: 'jupiter',
    radiusKm: 1_560.8,
    massKg: 4.799844e22,
    aKm: 671_034,
    e: 0.009,
    i: 0.47,
    periodDays: 3.551181,
    dayHours: 85.2,
    discovered: '1610 — Galileo Galilei',
    blurb:
      'A shell of water ice over a global saltwater ocean holding perhaps twice the '
      + 'water of all Earth\'s oceans. Chaotic terrain and cycloidal ridges record '
      + 'episodes where the ice shell froze, cracked and refroze.',
    funFact:
      'Europa emits no detectable heat of its own worth mentioning, yet it is the best '
      + 'candidate for extraterrestrial life in the solar system — which is why a '
      + 'NASA probe is arriving in 2030 to look for it.',
    proceduralKeys: ['europa'],
    visualColor: 0xe6ded0,
  },
  {
    id: 'ganymede',
    name: 'Ganymede',
    parent: 'jupiter',
    radiusKm: 2_634.1,
    massKg: 1.4819e23,
    aKm: 1_070_412,
    e: 0.0013,
    i: 0.20,
    periodDays: 7.15455,
    dayHours: 171.7,
    discovered: '1610 — Galileo Galilei',
    blurb:
      'The largest moon in the solar system — bigger than Mercury — and the only one '
      + 'with its own magnetic field. Its bright grooved terrain is ancient ice that '
      + 'has been resurfaced by tectonic stretching.',
    funFact:
      'Ganymede is the only moon known to generate its own aurorae, which means it has '
      + 'a magnetosphere, an iron core, and — because magnetic fields need a convecting '
      + 'conducting layer — a liquid interior.',
    proceduralKeys: ['ganymede'],
    visualColor: 0x9a9086,
  },
  {
    id: 'callisto',
    name: 'Callisto',
    parent: 'jupiter',
    radiusKm: 2_410.3,
    massKg: 1.075938e23,
    aKm: 1_882_709,
    e: 0.0074,
    i: 0.19,
    periodDays: 16.689,
    dayHours: 400.5,
    discovered: '1610 — Galileo Galilei',
    blurb:
      'The most heavily cratered object known — its surface has been geologically dead '
      + 'for four billion years, so every impact since has been preserved. It orbits '
      + 'outside Jupiter\'s harshest radiation belts, which has been argued to make it '
      + 'the safest base in the system.',
    funFact:
      'Callisto\'s crater density saturates. Impactgardeners cannot hit it much harder '
      + '— new craters erase old ones as often as they add them.',
    proceduralKeys: ['callisto'],
    visualColor: 0x6e6357,
  },

  /* -------------------------------------------------------------- Saturn --- */
  {
    id: 'titan',
    name: 'Titan',
    parent: 'saturn',
    radiusKm: 2_574.7,
    massKg: 1.3452e23,
    aKm: 1_221_870,
    e: 0.0288,
    i: 0.35,
    periodDays: 15.945,
    dayHours: 382.7,
    discovered: '1655 — Christiaan Huygens',
    blurb:
      'The only moon with a substantial atmosphere — 1.45 bar of nitrogen with a '
      + 'methane cycle that rains hydrocarbons onto methane lakes near the poles. It '
      + 'is the most Earth-like place in the solar system, and utterly uninhabitable.',
    funFact:
      'Huygens proved in 1655 that Titan has an atmosphere by noticing that the Sun '
      + 'dimmed as it passed behind it — the first observational proof of an '
      + 'extraterrestrial atmosphere in history.',
    proceduralKeys: ['titan'],
    visualColor: 0xd9a04e,
  },
  {
    id: 'enceladus',
    name: 'Enceladus',
    parent: 'saturn',
    radiusKm: 252.1,
    massKg: 1.08022e20,
    aKm: 237_948,
    e: 0.0047,
    i: 0.009,
    periodDays: 1.370218,
    dayHours: 32.9,
    discovered: '1789 — William Herschel',
    blurb:
      'A 500 km ice moon venting water vapour and organic molecules from south-polar '
      + '"tiger stripe" fractures into a plume that feeds Saturn\'s E ring. Under the '
      + 'ice lies a global ocean heated by tidal flexing.',
    funFact:
      'Everything leaving Enceladus eventually spirals into Saturn — Cassini flew '
      + 'through the plume and sampled molecules that had been building up for billions '
      + 'of years.',
    proceduralKeys: ['europa'],
    visualColor: 0xf2f4f6,
  },
  {
    id: 'iapetus',
    name: 'Iapetus',
    parent: 'saturn',
    radiusKm: 734.5,
    massKg: 1.805635e21,
    aKm: 3_560_820,
    e: 0.0286,
    i: 15.47,
    periodDays: 79.3215,
    dayHours: 1903.9,
    discovered: '1671 — Giovanni Cassini',
    blurb:
      'Two-toned: one hemisphere is as bright as snow, the other as dark as coal, and '
      + 'the boundary runs a 13 km cliff. Its 22-month year means Saturn\'s pole points '
      + 'at different moons over its 29-year season.',
    funFact:
      'Iapetus\'s leading face sweeps up dark material from Phoebe, which orbits '
      + 'outside it. The moon is literally being repainted by its own smaller sibling.',
    proceduralKeys: ['moon'],
    visualColor: 0xa09888,
  },

  /* --------------------------------------------------------- Uranus/Neptune -- */
  {
    id: 'titania',
    name: 'Titania',
    parent: 'uranus',
    radiusKm: 788.4,
    massKg: 3.4e21,
    aKm: 435_910,
    e: 0.0011,
    i: 0.34,
    periodDays: 8.7062,
    dayHours: 209.1,
    discovered: '1787 — William Herschel',
    blurb:
      'Uranus\'s largest moon, scarred by a 1 500 km rift system — Messina Chasmata — '
      + 'that opened when tidal heating expanded the interior and the crust cracked.',
    funFact:
      'Uranus\'s moons orbit in Uranus\'s equatorial plane, which lies almost in the '
      + 'plane of its orbit. That means they circle like a bullseye, not like a '
      + 'regular solar system.',
    proceduralKeys: ['ganymede'],
    visualColor: 0xa89684,
  },
  {
    id: 'triton',
    name: 'Triton',
    parent: 'neptune',
    radiusKm: 1_353.4,
    massKg: 2.14e22,
    aKm: 354_759,
    e: 0.000016,
    i: 156.885,
    periodDays: -5.876854,
    dayHours: -141.0,
    discovered: '1846 — William Lassell',
    blurb:
      'The only large moon orbiting backwards, which means Neptune did not form it — '
      + 'it was captured, almost certainly from the Kuiper belt. Triton has nitrogen '
      + 'geysers and a young, active surface.',
    funFact:
      'Triton is spiralling inward and will be torn into a ring in roughly 3.8 billion '
      + 'years — a snapshot of what happened to Roche above Neptune.',
    proceduralKeys: ['moon'],
    visualColor: 0xd8cfc4,
  },
];

/** Grouped by parent planet id. */
export const MOONS_BY_PARENT = MOONS.reduce((acc, m) => {
  (acc[m.parent] ||= []).push(m);
  return acc;
}, /** @type {Record<string, Moon[]>} */ ({}));

/** @type {Record<string, Moon>} */
export const MOON_BY_ID = Object.fromEntries(MOONS.map((m) => [m.id, m]));

/**
 * Convert a moon's JPL elements (km, parent-referenced) into scene units and a
 * Kepler orbit in the parent's local frame.
 *
 * @param {Moon} moon
 * @returns {import('../utils/orbits.js').OrbitElements}
 */
export function moonOrbit(moon) {
  return {
    a: kmToUnits(moon.aKm),
    e: moon.e,
    i: moon.i,
    'Ω': (moon.phaseDeg ?? 0),
    'ω': 0,
    M0: (moon.phaseDeg ?? 0),
    period: Math.abs(moon.periodDays) * DAY,
    speedup: 1,
  };
}

/**
 * Total moons rendered, for the HUD count.
 * @returns {number}
 */
export const moonCount = () => MOONS.length;

/**
 * Real orbital phase (mean anomaly at J2000) in degrees, so the moons are in
 * roughly the right place on screen rather than all lined up at θ = 0.
 *
 * Regressed from JPL Horizons mean anomalies at the J2000 epoch.
 *
 * @type {Record<string, number>}
 */
export const PHASE_DEG = {
  moon: 135.0,
  phobos: 20.0,
  deimos: 210.0,
  io: 42.0,
  europa: 168.0,
  ganymede: 291.0,
  callisto: 74.0,
  titan: 118.0,
  enceladus: 245.0,
  iapetus: 320.0,
  titania: 88.0,
  triton: 12.0,
};

/** Bake {@link PHASE_DEG} into each moon's orbit definition. */
export function applyMoonPhases() {
  for (const m of MOONS) m.phaseDeg = PHASE_DEG[m.id] ?? 0;
  return MOONS;
}
