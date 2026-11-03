// Time zones, solar position and overlay colors, shared by the page and the shading worker.
export const RAD = Math.PI / 180, RISE = -0.833;
// Unzoomed map: geoAlbersUsa().scale(BASE).translate(CENTER), in a 975×610 box.
export const BASE = 1300, CENTER = [487.5, 305];

// [name, standard UTC offset, follows the DST toggle]
export const ZONES = [["", 0, 0], ["Eastern", -5, 1], ["Central", -6, 1], ["Mountain", -7, 1], ["Mountain (Arizona)", -7, 0],
  ["Pacific", -8, 1], ["Alaska", -9, 1], ["Hawaii", -10, 0], ["Hawaii–Aleutian", -10, 1]];
const BY_STATE = {
  1: "09 10 11 12 13 18 21 23 24 25 26 33 34 36 37 39 42 44 45 50 51 54",
  2: "01 05 17 19 20 22 27 28 29 31 38 40 46 47 48 55", 3: "08 16 30 35 49 56", 4: "04", 5: "06 32 41 53", 6: "02", 7: "15" };
// Counties whose zone differs from their state's (county-level approximation of the official boundaries).
const BY_COUNTY = {
  1: "47001 47009 47011 47013 47019 47025 47029 47057 47059 47063 47065 47067 47073 47089 47091 47093 47105 47107 47121 47123 47129 47139 47143 47145 47151 47155 47163 47171 47173 47179",
  2: "12005 12013 12033 12045 12059 12063 12091 12113 12131 12133 18051 18073 18089 18091 18111 18123 18127 18129 18147 18149 18163 18173 26043 26053 26071 26109 " +
     "21001 21003 21007 21009 21027 21031 21033 21035 21039 21047 21053 21055 21057 21059 21061 21075 21083 21085 21087 21091 21099 21101 21105 21107 21139 21141 21143 21145 21149 21157 21169 21171 21177 21183 21207 21213 21219 21221 21225 21227 21233",
  3: "38001 38007 38011 38033 38037 38041 38085 38087 38089 46007 46019 46031 46033 46041 46047 46055 46063 46071 46081 46093 46102 46103 46105 46113 46117 46137 " +
     "31005 31007 31013 31029 31033 31045 31049 31057 31069 31075 31091 31101 31105 31123 31135 31157 31161 31165 20071 20075 20181 20199 48141 48229 41045",
  5: "16009 16017 16021 16035 16049 16055 16057 16061 16069 16079" };
const zoneById = new Map();
for (const [z, ids] of Object.entries(BY_STATE)) for (const id of ids.split(" ")) zoneById.set(id, +z);
for (const [z, ids] of Object.entries(BY_COUNTY)) for (const id of ids.split(" ")) zoneById.set(id, +z);
export const zoneOf = id => zoneById.get(id) ?? zoneById.get(id.slice(0, 2)) ?? 0;
// Aleutians west of 169°30'W are on Hawaii–Aleutian time.
export const fixZone = (z, lon) => z === 6 && (lon < -169.5 || lon > 0) ? 8 : z;
export const offsetOf = (z, mode) => ZONES[z][1] + (mode === "dst" && ZONES[z][2] ? 1 : 0);

// NOAA fractional-year approximation: declination (rad) and equation of time (min).
export function sun(d) {
  const g = 2 * Math.PI / 365 * (d - 1);
  return {
    dec: 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g),
    eqt: 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g)) };
}
// Hour angle (rad) at longitude 0 for local clock `m` in a zone at UTC offset `off`; add lon for the place.
export const hourAngle0 = (s, m, off) => ((m - off * 60 + s.eqt) / 4 - 180) * RAD;

// Overlay color by sun elevation (deg): clear by day, warm at the horizon, deep blue at night. Indexed by sin(elevation).
const KEYS = [[10, 255, 196, 120, 0], [4, 255, 178, 96, .1], [0, 252, 128, 84, .28], [-3, 168, 76, 112, .46],
  [-6, 52, 44, 112, .62], [-12, 16, 20, 56, .8], [-18, 8, 11, 32, .87]];
export const LUT = new Uint32Array(2048);
for (let b = 0; b < 2048; b++) {
  const e = Math.asin(Math.min(1, b / 1023.5 - 1)) / RAD;
  const j = KEYS.findIndex(k => k[0] <= e), hi = KEYS.at(j), lo = j <= 0 ? hi : KEYS[j - 1];
  const t = lo === hi ? 0 : (lo[0] - e) / (lo[0] - hi[0]);
  const c = [1, 2, 3, 4].map(i => lo[i] + (hi[i] - lo[i]) * t);
  LUT[b] = ((Math.round(c[3] * 255) << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
}
