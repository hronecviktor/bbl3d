// Builds the "Open data (EE)" 3D layers from Estonian Land Board open data:
//
//   npm run tiles:ee -- [--area Tallinn] [--only buildings|trees]
//
// --area is a municipality as named on the geoportal's "Download 3D data" page
// (e.g. Tallinn, Tartu_linn, Saue_vald). Needs Docker (for GDAL) and network
// access. Output goes to public/tiles/ee-buildings and public/tiles/ee-trees,
// which the app loads when present.
//
// Data: Maa- ja Ruumiamet (Estonian Land and Spatial Development Board),
// open data licence: https://geoportaal.maaruum.ee/opendata-licence
import path from "node:path";
import { buildBuildings } from "./buildings.mjs";
import { parseArgs } from "./common.mjs";
import { buildTrees } from "./trees.mjs";

const args = parseArgs(process.argv.slice(2));
const area = args.area ?? "Tallinn";
if (args.only !== "trees") await buildBuildings(area, path.resolve("public/tiles/ee-buildings"));
if (args.only !== "buildings") await buildTrees(area, path.resolve("public/tiles/ee-trees"));
