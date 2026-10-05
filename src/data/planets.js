/**
 * Planetary data — JPL/IAU values, in real units.
 *
 * Sources
 *  - Masses, radii, densities, temperatures, gravity: NASA Planetary Fact Sheet.
 *  - Orbital elements (J2000 ecliptic): JPL "Keplerian Elements for Approximate
 *    Positions of the Major Planets", valid 1800–2050 AD.
 *  - Rotation periods: IAU Working Group on Cartographic Coordinates and
 *    Rotational Elements.
 *  - Axial tilts, moon counts and fun facts: NASA Solar System Exploration.
 *
 * UNITS — this file is unit-explicit and converts to scene units on load:
 *   `radiusKm`   kilometres            `orbit.a`  scene units (AU → units)
 *   `massKg`     kilograms             `orbit.period` SECONDS
 *   `dayHours`   hours                 `orbit.i/Ω/ω/M0` DEGREES
 *
 * @module data/planets
 */

import { SCALE } from '../config.js';
import { DAY, HOUR, JULIAN_YEAR } from '../utils/orbits.js';

/** Kilometres → scene units. */
const kmToUnits = (km) => km / SCALE.UNIT_KM;
/** Astronomical units → scene units. */
const auToUnits = (au) => (au * SCALE.AU_KM) / SCALE.UNIT_KM;
/** Radians → degrees. */
const rad2deg = (r) => (r * 180) / Math.PI;

/**
 * @typedef {Object} Planet
 * @property {string} id
 * @property {string} name
 * @property {string} [altName]
 * @property {string} type
 * @property {number} radiusKm
 * @property {number} massKg
 * @property {number} [densityGcc]
 * @property {number} [gravityMs2]
 * @property {number} [escapeKmS]
 * @property {number} [dayHours] Sidereal rotation period, hours.
 * @property {number} [yearDays] Sidereal orbital period, days.
 * @property {number} [obliquityDeg]
 * @property {number} [tempMeanC]
 * @property {number} [tempRangeC] `[mean, min, max]`
 * @property {number} [moons]
 * @property {string} [composition]
 * @property {string} [atmosphere]
 * @property {string} blurb
 * @property {string} funFact
 * @property {Object} orbit Kepler elements, already in scene units.
 * @property {Object} [visual] Renderer hints.
 * @property {string[]} [proceduralKeys] Surface-recipe keys for the fallback.
 */

/** @type {Planet[]} */
export const PLANETS = [
  {
    id: 'sun',
    name: 'The Sun',
    altName: 'Sol',
    type: 'G2V main-sequence star',
    radiusKm: 695_700,
    massKg: 1.9885e30,
    densityGcc: 1.408,
    gravityMs2: 274,
    escapeKmS: 617.7,
    tempMeanC: 5_505,
    tempRangeC: [5_505, 5_400, 5_720],
    moons: null,
    composition: '73% hydrogen, 25% helium (by mass)',
    atmosphere: 'Photosphere → chromosphere → corona',
    blurb:
      'A middle-aged yellow dwarf holding 99.86% of the solar system\'s mass. Every '
      + 'second it fuses 600 million tonnes of hydrogen into helium, converting four '
      + 'million tonnes of that mass into the light that reaches your eye.',
    funFact:
      'Light leaving the photosphere takes about 170 000 years to random-walk out of '
      + 'the Sun\'s radiation zone — the energy you feel arrives with the "address" of '
      + 'the core only in a statistical sense.',
    orbit: { a: 0, e: 0, i: 0, 'Ω': 0, 'ω': 0, M0: 0, period: 1 },
    visual: { emissive: 0xffdf9a, lightIntensity: 3.6, lightColor: 0xfff3d6 },
    proceduralKeys: ['sun'],
  },

  {
    id: 'mercury',
    name: 'Mercury',
    type: 'Terrestrial planet',
    radiusKm: 2_439.7,
    massKg: 3.3011e23,
    densityGcc: 5.427,
    gravityMs2: 3.7,
    escapeKmS: 4.3,
    dayHours: 1_407.6,
    yearDays: 87.969,
    obliquityDeg: 0.034,
    tempMeanC: 167,
    tempRangeC: [167, -173, 427],
    moons: 0,
    composition: 'Iron core (85% of radius), silicate mantle',
    atmosphere: 'Exosphere — oxygen, sodium, hydrogen, helium',
    blurb:
      'The smallest planet and the fastest, sweeping around the Sun in 88 days while '
      + 'spinning three times for every two orbits. Its iron core fills 85% of its '
      + 'radius, and a 3:2 spin–orbit resonance stretches one solar day into two Mercurian years.',
    funFact:
      'Despite being closest to the Sun, Mercury is not the hottest planet — Venus is, '
      + 'because Mercury has almost no atmosphere to hold heat.',
    orbit: { a: auToUnits(0.38709927), e: 0.205630, i: 7.005, 'Ω': 48.331, 'ω': 29.124, M0: 174.796, period: 87.969 * DAY },
    visual: { color: 0x9a9188 },
    proceduralKeys: ['mercury'],
  },

  {
    id: 'venus',
    name: 'Venus',
    type: 'Terrestrial planet',
    radiusKm: 6_051.8,
    massKg: 4.8675e24,
    densityGcc: 5.243,
    gravityMs2: 8.87,
    escapeKmS: 10.36,
    dayHours: -5_832.5,          // retrograde
    yearDays: 224.701,
    obliquityDeg: 177.36,
    tempMeanC: 464,
    tempRangeC: [464, 420, 497],
    moons: 0,
    composition: 'Silicate rock over an iron–nickel core',
    atmosphere: '96.5% CO₂, 3.5% N₂, sulphuric-acid cloud deck',
    blurb:
      'Earth\'s twin by size and its opposite in every other respect. A 92-bar carbon-'
      + 'dioxide atmosphere produces a runaway greenhouse: 464 °C on the surface, hot '
      + 'enough to melt lead, with 90-bar super-rotating cloud winds.',
    funFact:
      'Venus rotates backwards and so slowly that its day (243 Earth days) is longer '
      + 'than its year (225).',
    orbit: { a: auToUnits(0.72333566), e: 0.00677672, i: 3.39467, 'Ω': 76.680, 'ω': 54.884, M0: 50.115, period: 224.701 * DAY },
    visual: { color: 0xe8c88a, atmosphere: { color: 0xffdca8, power: 2.6, strength: 0.9 } },
    proceduralKeys: ['venusSurface', 'venusAtmosphere'],
  },

  {
    id: 'earth',
    name: 'Earth',
    type: 'Terrestrial planet',
    radiusKm: 6_371.0,
    massKg: 5.97237e24,
    densityGcc: 5.514,
    gravityMs2: 9.807,
    escapeKmS: 11.186,
    dayHours: 23.9345,
    yearDays: 365.256,
    obliquityDeg: 23.44,
    tempMeanC: 15,
    tempRangeC: [15, -89, 57],
    moons: 1,
    composition: 'Iron–nickel core, silicate mantle, thin hydrosphere',
    atmosphere: '78% N₂, 21% O₂, 0.9% Ar, 0.04% CO₂',
    blurb:
      'The only world known to carry life, and the only one where water is stable as '
      + 'solid, liquid and vapour simultaneously. Its unusually large Moon stabilises '
      + 'the axial tilt, keeping the climate far steadier than it would otherwise be.',
    funFact:
      'Every atom heavier than helium in your body was manufactured inside a star and '
      + 'blown out in a supernova. You are made of stardust that is actively being '
      + 'recycled through your own body.',
    orbit: { a: auToUnits(1.00000261), e: 0.01671123, i: -0.00001531, 'Ω': 0, 'ω': 102.937, M0: 100.464, period: 365.256 * DAY },
    visual: {
      color: 0x2f6fb5,
      clouds: 0.94,
      nightLights: true,
      specular: 0.55,
      atmosphere: { color: 0x6fb4ff, power: 3.0, strength: 1.15 },
    },
    proceduralKeys: ['earthSurface', 'earthNight', 'earthClouds'],
  },

  {
    id: 'mars',
    name: 'Mars',
    type: 'Terrestrial planet',
    radiusKm: 3_389.5,
    massKg: 6.4171e23,
    densityGcc: 3.9335,
    gravityMs2: 3.721,
    escapeKmS: 5.027,
    dayHours: 24.6229,
    yearDays: 686.980,
    obliquityDeg: 25.19,
    tempMeanC: -63,
    tempRangeC: [-63, -143, 35],
    moons: 2,
    composition: 'Basaltic mantle, iron–sulphur core, thick regolith',
    atmosphere: '95% CO₂, 2.6% N₂, 1.9% Ar — 0.6% of Earth\'s pressure',
    blurb:
      'A cold desert with the largest volcano and deepest canyon in the solar system. '
      + 'Olympus Mons rises 22 km, and Valles Marineris runs 4 000 km — the length of '
      + 'the United States.',
    funFact:
      'The entire Martian atmosphere weighs less than a good thunderstorm on Earth, and '
      + 'liquid water boils away almost instantly at its surface pressure.',
    orbit: { a: auToUnits(1.52371034), e: 0.09339410, i: 1.84969, 'Ω': 49.558, 'ω': 286.502, M0: 19.373, period: 686.980 * DAY },
    visual: { color: 0xc1502e, atmosphere: { color: 0xd98a6a, power: 2.4, strength: 0.32 } },
    proceduralKeys: ['mars'],
  },

  {
    id: 'jupiter',
    name: 'Jupiter',
    type: 'Gas giant',
    radiusKm: 69_911,
    massKg: 1.8982e27,
    densityGcc: 1.326,
    gravityMs2: 24.79,
    escapeKmS: 59.5,
    dayHours: 9.9259,
    yearDays: 4_332.59,
    obliquityDeg: 3.13,
    tempMeanC: -110,
    tempRangeC: [-110, -145, -108],
    moons: 95,
    composition: '90% hydrogen, 10% helium by volume; metallic hydrogen mantle',
    atmosphere: '90% H₂, 10% He, traces of NH₃, CH₄, H₂O',
    blurb:
      'A failed star with 318 Earth masses. Its Great Red Spot is a storm wider than '
      + 'Earth that has been turning for at least 190 years, and its magnetosphere is '
      + 'the largest structure in the solar system after the heliosphere.',
    funFact:
      'Jupiter has no visible surface at all. Descend through the cloud tops and the '
      + '"surface" simply gets denser until hydrogen is compressed into a metallic '
      + 'liquid that would still float.',
    orbit: { a: auToUnits(5.20288700), e: 0.04838624, i: 1.30440, 'Ω': 100.474, 'ω': 273.867, M0: 20.020, period: 4_332.59 * DAY },
    visual: { color: 0xd8a878, banding: true },
    proceduralKeys: ['jupiter'],
  },

  {
    id: 'saturn',
    name: 'Saturn',
    type: 'Gas giant',
    radiusKm: 58_232,
    massKg: 5.6834e26,
    densityGcc: 0.687,
    gravityMs2: 10.44,
    escapeKmS: 35.5,
    dayHours: 10.656,
    yearDays: 10_759.2,
    obliquityDeg: 26.73,
    tempMeanC: -140,
    tempRangeC: [-140, -184, -122],
    moons: 274,
    composition: '96% hydrogen, 3% helium by volume; ammonia–methalane ices',
    atmosphere: '96% H₂, 3% He, traces of CH₄, NH₃',
    blurb:
      'The least dense planet — it would float in a sufficiently large ocean. Its ring '
      + 'system spans 282 000 km yet averages only about 10 metres thick, and is made '
      + 'of 99% water ice.',
    funFact:
      'The rings are geologically young. Cassini measured rainbows\' worth of ring '
      + 'material and concluded they may be no older than 100 million years — which '
      + 'means dinosaurs.',
    orbit: { a: auToUnits(9.53667594), e: 0.05386179, i: 2.48599, 'Ω': 113.665, 'ω': 339.392, M0: 317.020, period: 10_759.2 * DAY },
    visual: { color: 0xe0c98a, banding: true, rings: { innerKm: 74_500, outerKm: 140_220 } },
    proceduralKeys: ['saturn'],
  },

  {
    id: 'uranus',
    name: 'Uranus',
    type: 'Ice giant',
    radiusKm: 25_362,
    massKg: 8.6810e25,
    densityGcc: 1.27,
    gravityMs2: 8.87,
    escapeKmS: 21.3,
    dayHours: -17.24,             // retrograde
    yearDays: 30_685.4,
    obliquityDeg: 97.77,
    tempMeanC: -195,
    tempRangeC: [-195, -224, -214],
    moons: 28,
    composition: 'Water, methane and ammonia ices over a rocky core',
    atmosphere: '83% H₂, 15% He, 2% CH₄ — the methane absorbs red light',
    blurb:
      'The first planet found with a ring system, and the only one that rotates on its '
      + 'side. An obliquity of 98° means Uranus rolls along its orbit, giving each pole '
      + '42 years of continuous sunlight followed by 42 years of darkness.',
    funFact:
      'Uranus has the coldest measured atmosphere in the solar system — −224 °C, '
      + 'colder than Neptune despite being closer to the Sun, because its axial tilt '
      + 'means neither pole ever faces the Sun directly.',
    orbit: { a: auToUnits(19.18916464), e: 0.04725744, i: 0.77263, 'Ω': 74.006, 'ω': 96.999, M0: 142.238, period: 30_685.4 * DAY },
    visual: { color: 0x9fd8dc, banding: true },
    proceduralKeys: ['uranus'],
  },

  {
    id: 'neptune',
    name: 'Neptune',
    type: 'Ice giant',
    radiusKm: 24_622,
    massKg: 1.02413e26,
    densityGcc: 1.638,
    gravityMs2: 11.15,
    escapeKmS: 23.5,
    dayHours: 16.11,
    yearDays: 60_189,
    obliquityDeg: 28.32,
    tempMeanC: -200,
    tempRangeC: [-200, -223, -218],
    moons: 16,
    composition: 'Water, methane, ammonia ices; no solid surface at any depth',
    atmosphere: '80% H₂, 19% He, 1.5% CH₄',
    blurb:
      'Found with mathematics before it was ever seen: Le Verrier predicted its '
      + 'position from Uranus\'s orbital residuals, and Galle spotted it within one '
      + 'degree of the prediction on the first night of searching, in 1846.',
    funFact:
      'Neptune has the fastest winds in the solar system — 2 100 km/h, faster than the '
      + 'speed of sound on Earth, driven by an internal heat source nobody can fully '
      + 'account for.',
    orbit: { a: auToUnits(30.06992276), e: 0.00859048, i: 1.77004, 'Ω': 131.784, 'ω': 273.187, M0: 256.228, period: 60_189 * DAY },
    visual: { color: 0x4a72d8, banding: true },
    proceduralKeys: ['neptune'],
  },

  {
    id: 'pluto',
    name: 'Pluto',
    altName: '134340 Pluto',
    type: 'Dwarf planet · Kuiper belt',
    radiusKm: 1_188.3,
    massKg: 1.303e22,
    densityGcc: 1.854,
    gravityMs2: 0.62,
    escapeKmS: 1.21,
    dayHours: -153.29,
    yearDays: 90_560,
    obliquityDeg: 122.53,
    tempMeanC: -229,
    tempRangeC: [-229, -240, -218],
    moons: 5,
    composition: '~70% rock and 30% water ice',
    atmosphere: 'N₂ with CH₄ and CO — freezes out near aphelion',
    blurb:
      'A Kuiper belt world in a 3:2 resonance with Neptune, which is why the two can '
      + 'never collide despite crossing orbits. The 2019 New Horizons flyby revealed '
      + 'Sputnik Planitia — a 1 000 km glacier of nitrogen ice shaped like a heart.',
    funFact:
      'Pluto and its moon Charon are so close in mass that they orbit a point in empty '
      + 'space between them. They are the only true double system in the solar system.',
    orbit: { a: auToUnits(39.48211675), e: 0.24882730, i: 17.14001206, 'Ω': 110.376, 'ω': 224.068, M0: 238.901, period: 90_560 * DAY },
    visual: { color: 0xd8b8a0 },
    proceduralKeys: ['pluto'],
  },
];

/* -------------------------------------------------------------------------- */
/* Derived helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Fast id → planet lookup. */
export const PLANET_BY_ID = Object.fromEntries(PLANETS.map((p) => [p.id, p]));

/**
 * Default visual speed multiplier per planet.
 *
 * At 1×, Mercury's 88-day year is imperceptible and Neptune's 165-year year is
 * static. These values compress the range into something you can actually watch
 * while *preserving every relative ordering and the correct elliptical shapes*.
 * The REAL SCALE toggle sets every multiplier to 1 for a truthful simulation.
 *
 * @type {Record<string, number>}
 */
export const DEFAULT_SPEEDUP = {
  sun: 1,
  mercury: 260,
  venus: 150,
  earth: 100,
  mars: 70,
  jupiter: 12,
  saturn: 5,
  uranus: 2.4,
  neptune: 1.4,
  pluto: 1.0,
};

/**
 * Apply the default speed multipliers to every orbit.
 * @returns {Planet[]} The same array, mutated in place for hot-loop efficiency.
 */
export function applySpeedups(planets = PLANETS) {
  for (const p of planets) {
    p.orbit.speedup = DEFAULT_SPEEDUP[p.id] ?? 1;
  }
  return planets;
}

/** Apply REAL SCALE (speedup = 1) to every orbit. */
export function applyRealScale(planets = PLANETS) {
  for (const p of planets) {
    p.orbit.speedup = 1;
    p.rotationSpeedup = 1;
  }
  return planets;
}

/**
 * Sidereal rotation period in seconds. Retrograde rotators (negative `dayHours`)
 * produce negative periods, which is exactly what the shader wants.
 *
 * @param {Planet} p
 * @returns {number} seconds per rotation (signed)
 */
export const rotationPeriodSeconds = (p) =>
  p.dayHours ? (p.dayHours * HOUR) / (p.rotationSpeedup ?? 1) : 0;

/**
 * Scene-unit radius for a body.
 * @param {Planet} p
 * @returns {number}
 */
export const planetRadiusUnits = (p) => kmToUnits(p.radiusKm);

/**
 * Display colour for the navigator rail.
 * @param {Planet} p
 * @returns {string} CSS hex
 */
export const planetCssColor = (p) =>
  '#' + (p.visual?.color ?? 0xffffff).toString(16).padStart(6, '0');

/** Sorted for the navigator: the Sun, then by semi-major axis, then Pluto. */
export const PLANETS_BY_ORBIT = [...PLANETS].sort((a, b) => a.orbit.a - b.orbit.a);

/** Orbital period in seconds, for the sonification mapping. */
export const orbitalPeriodSeconds = (p) => p.orbit.period;

/** A Julian year in days, for readability in data comments. */
export const YEAR_DAYS = JULIAN_YEAR / DAY;

export { rad2deg, kmToUnits, auToUnits };
