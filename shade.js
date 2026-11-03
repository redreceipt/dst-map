// Shading worker: rasterizes zones for the current view, then paints the day/night overlay off the main thread.
import { geoAlbersUsa, geoPath } from "https://cdn.jsdelivr.net/npm/d3-geo@3/+esm";
import { feature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import { RAD, BASE, CENTER, zoneOf, fixZone, offsetOf, sun, hourAngle0, LUT } from "./sun.js";

const ready = fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json").then(r => r.json()).then(us => {
  const counties = feature(us, us.objects.counties).features, base = geoPath(geoAlbersUsa().scale(BASE).translate(CENTER));
  counties.forEach(f => f.box = base.bounds(f));
  return { counties, nation: feature(us, us.objects.nation) };
});
// A layer is the overlay for one view: `M` maps unzoomed units to CSS px, `dpr` CSS px to canvas px.
// Zones (R) and county index (G,B) plus land coverage are rasterized, and every land pixel gets lon/lat once per view.
function setup({ counties, nation }, { cssW, cssH, dpr, M }) {
  const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
  const view = geoAlbersUsa().scale(BASE * M.k).translate([CENTER[0] * M.k + M.x, CENTER[1] * M.k + M.y]);
  const c = new OffscreenCanvas(W, H), x = c.getContext("2d", { willReadFrequently: true }), p = geoPath(view, x);
  x.setTransform(dpr, 0, 0, dpr, 0, 0); x.lineWidth = 1.5 / dpr;
  // Skip counties outside the viewport (bounds are in unzoomed units).
  const vx = -M.x / M.k, vy = -M.y / M.k, vw = cssW / M.k, vh = cssH / M.k;
  counties.forEach((f, i) => {
    const [[x1, y1], [x2, y2]] = f.box;
    if (x2 < vx - 2 || x1 > vx + vw + 2 || y2 < vy - 2 || y1 > vy + vh + 2) return;
    x.fillStyle = x.strokeStyle = `rgb(${zoneOf(f.id) * 30},${(i + 1) >> 8},${(i + 1) & 255})`;
    x.beginPath(); p(f); x.fill(); x.stroke();
  });
  const ids = x.getImageData(0, 0, W, H).data;
  x.clearRect(0, 0, cssW, cssH); x.fillStyle = "#000"; x.beginPath(); p(nation); x.fill();
  const alpha = x.getImageData(0, 0, W, H).data;
  let count = 0;
  for (let i = 0; i < W * H; i++) if (alpha[i * 4 + 3] && ids[i * 4]) count++;
  const L = { W, H, ids, n: 0, pix: new Int32Array(count), zn: new Uint8Array(count), cov: new Uint8Array(count),
    P: new Float32Array(count), Q: new Float32Array(count), CL: new Float32Array(count), SL: new Float32Array(count) };
  // Invert on a coarse grid and interpolate; fall back to an exact invert where corners disagree (insets, antimeridian, off-map).
  const G = 4, GW = Math.floor(W / G) + 2, GH = Math.floor(H / G) + 2, grid = new Float64Array(GW * GH * 2).fill(NaN);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const ll = view.invert([gx * G / dpr, gy * G / dpr]);
    if (ll) grid.set(ll, (gy * GW + gx) * 2);
  }
  let n = 0;
  for (let y = 0; y < H; y++) for (let x0 = 0; x0 < W; x0++) {
    const i = y * W + x0, a = alpha[i * 4 + 3], z = Math.round(ids[i * 4] / 30);
    if (!a || !z) continue;
    const fx = (x0 + .5) / G, fy = (y + .5) / G, gx = fx | 0, gy = fy | 0, tx = fx - gx, ty = fy - gy, g = (gy * GW + gx) * 2, g2 = g + GW * 2;
    const o0 = grid[g], o1 = grid[g + 2], o2 = grid[g2], o3 = grid[g2 + 2];
    let lon, lat;
    if (Math.max(o0, o1, o2, o3) - Math.min(o0, o1, o2, o3) < 2) { // false if any corner is NaN
      lon = (o0 * (1 - tx) + o1 * tx) * (1 - ty) + (o2 * (1 - tx) + o3 * tx) * ty;
      lat = (grid[g + 1] * (1 - tx) + grid[g + 3] * tx) * (1 - ty) + (grid[g2 + 1] * (1 - tx) + grid[g2 + 3] * tx) * ty;
    } else {
      const ll = view.invert([(x0 + .5) / dpr, (y + .5) / dpr]);
      if (!ll) continue;
      [lon, lat] = ll;
    }
    L.pix[n] = i; L.zn[n] = fixZone(z, lon); L.cov[n] = a;
    L.P[n] = Math.sin(lat * RAD); L.Q[n] = Math.cos(lat * RAD); L.CL[n] = Math.cos(lon * RAD); L.SL[n] = Math.sin(lon * RAD);
    n++;
  }
  L.n = n; L.canvas = new OffscreenCanvas(W, H); L.ctx = L.canvas.getContext("2d");
  L.img = L.ctx.createImageData(W, H); L.buf = new Uint32Array(L.img.data.buffer);
  return L;
}

function draw({ n, pix, zn, cov, P, Q, CL, SL, canvas, ctx, img, buf }, { minutes, doy, mode }) {
  const s = sun(doy), sd = Math.sin(s.dec), cd = Math.cos(s.dec), cA = new Float32Array(9), sA = new Float32Array(9);
  for (let z = 1; z < 9; z++) { const a = hourAngle0(s, minutes, offsetOf(z, mode)); cA[z] = Math.cos(a) * cd; sA[z] = Math.sin(a) * cd; }
  // sin(elev) = sinφ·sinδ + cosφ·cosδ·cos(H0 + λ), with cos(H0 + λ) expanded so the per-pixel loop has no trig.
  for (let j = 0; j < n; j++) {
    const z = zn[j], e = P[j] * sd + Q[j] * (cA[z] * CL[j] - sA[z] * SL[j]);
    let c = LUT[((e + 1) * 1023.5) | 0];
    if (cov[j] !== 255) c = ((((c >>> 24) * cov[j] / 255) << 24) | (c & 0xffffff)) >>> 0;
    buf[pix[j]] = c;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.transferToImageBitmap();
}

// `lo` covers the whole country at modest resolution, so panning never reveals unshaded land; `hi` is sharp for the current view.
const LO = 2;
let lo, hi;
onmessage = async ({ data }) => {
  const geo = await ready;
  lo ??= setup(geo, { cssW: 975, cssH: 610, dpr: LO, M: { k: 1, x: 0, y: 0 } });
  if (data.setup) hi = setup(geo, data.setup);
  const loBitmap = draw(lo, data.state), hiBitmap = hi && draw(hi, data.state);
  const ids = data.setup && hi.ids;
  postMessage({ lo: loBitmap, hi: hiBitmap, setup: ids && { ...data.setup, ids, W: hi.W, H: hi.H } },
    [loBitmap, ...(hiBitmap ? [hiBitmap] : []), ...(ids ? [ids.buffer] : [])]);
};
