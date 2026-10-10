// Copernicus GLO-30 surface model (30 m, includes trees and buildings; AWS Open
// Data, no key) cut to a box with GDAL in Docker, for planning sample flights.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GDAL_IMAGE } from "../ee-3d/common.mjs";

const WORK = path.resolve("scripts/samples/work");

function tileName(lat, lon) {
  const ns = lat < 0 ? "S" : "N";
  const ew = lon < 0 ? "W" : "E";
  const la = Math.abs(Math.floor(lat)).toString().padStart(2, "0");
  const lo = Math.abs(Math.floor(lon)).toString().padStart(3, "0");
  return `Copernicus_DSM_COG_10_${ns}${la}_00_${ew}${lo}_00_DEM`;
}

/** Surface height sampler (m above sea level) for a box around (lat, lon). */
export function copernicus(lat, lon, radiusM = 2000) {
  fs.mkdirSync(WORK, { recursive: true });
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const name = tileName(lat, lon);
  const file = path.join(WORK, `${name}_${lat.toFixed(4)}_${lon.toFixed(4)}_${radiusM}.asc`);
  if (!fs.existsSync(file)) {
    const url = `/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
    execFileSync("docker", [
      "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-v", `${WORK}:/out`, GDAL_IMAGE,
      "gdal_translate", "-q", "-projwin", lon - dLon, lat + dLat, lon + dLon, lat - dLat, "-of", "AAIGrid", url, `/out/${path.basename(file)}`,
    ].map(String));
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const hdr = {};
  let i = 0;
  while (/^[a-z_]+\s/i.test(lines[i])) {
    const [k, v] = lines[i].trim().split(/\s+/);
    hdr[k.toLowerCase()] = Number(v);
    i++;
  }
  const rows = lines.slice(i).filter((l) => l.trim()).map((l) => l.trim().split(/\s+/).map(Number));
  const cs = hdr.cellsize;
  const top = hdr.yllcorner + rows.length * cs;
  return (la, lo) => {
    const fy = (top - la) / cs - 0.5;
    const fx = (lo - hdr.xllcorner) / cs - 0.5;
    const y0 = Math.max(0, Math.min(rows.length - 2, Math.floor(fy)));
    const x0 = Math.max(0, Math.min(rows[0].length - 2, Math.floor(fx)));
    const ax = Math.min(1, Math.max(0, fx - x0));
    const ay = Math.min(1, Math.max(0, fy - y0));
    const a = rows[y0][x0] * (1 - ax) + rows[y0][x0 + 1] * ax;
    const b = rows[y0 + 1][x0] * (1 - ax) + rows[y0 + 1][x0 + 1] * ax;
    return a * (1 - ay) + b * ay;
  };
}
