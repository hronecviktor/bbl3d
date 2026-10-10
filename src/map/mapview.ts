// The 3D scene: map layers, flight track, quad model and cameras.
import {
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  GeometryInstance,
  HeadingPitchRange,
  HeadingPitchRoll,
  Math as CMath,
  Matrix3,
  Matrix4,
  Model,
  PolylineColorAppearance,
  PolylineGeometry,
  Primitive,
  Transforms,
  Viewer,
  type Entity,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { Flight, Pose } from "../flight/flight";
import { applyMapMode, type ActiveLayers, type MapMode } from "./layers";
import { terrainHeightAt } from "./terrain";

export type CameraMode = "chase" | "fpv" | "orbit" | "top";

export interface ViewSettings {
  chaseDistance: number; // m
  chaseHeight: number; // degrees above the quad
  fpvUptilt: number; // degrees
  fpvFov: number; // degrees, horizontal
}

const TRAIL_SECONDS = 8;
const MODEL_CLEARANCE = 0.08; // m, model origin above the ground at rest

export class MapView {
  readonly viewer: Viewer;
  private flight: Flight | null = null;
  private layers: ActiveLayers | null = null;
  private ground = 0; // ellipsoid height of the home point, m
  private quad: Model | null = null;
  private track: Primitive | null = null;
  private trail: Entity | null = null;
  private chaseYaw: number | null = null;
  private lastCamera: CameraMode | null = null;
  private now = 0;

  camera: CameraMode = "chase";
  settings: ViewSettings = { chaseDistance: 6, chaseHeight: 15, fpvUptilt: 30, fpvFov: 118 };

  constructor(container: HTMLElement, private time: () => number) {
    this.viewer = new Viewer(container, {
      baseLayer: false,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
    });
    const scene = this.viewer.scene;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.enableLighting = false;
    scene.fog.enabled = true;
    scene.preUpdate.addEventListener(() => this.update(this.time()));
  }

  async setMapMode(mode: MapMode, ionToken: string): Promise<string | null> {
    this.removeFlightVisuals();
    this.layers = await applyMapMode(this.viewer, mode, ionToken);
    if (this.flight) await this.addFlightVisuals();
    return this.layers.note;
  }

  async setFlight(flight: Flight | null) {
    this.removeFlightVisuals();
    this.flight = flight;
    this.chaseYaw = null;
    this.lastCamera = null;
    if (flight) await this.addFlightVisuals();
  }

  private removeFlightVisuals() {
    const prims = this.viewer.scene.primitives;
    if (this.quad) prims.remove(this.quad);
    if (this.track) prims.remove(this.track);
    if (this.trail) this.viewer.entities.remove(this.trail);
    this.quad = this.track = null;
    this.trail = null;
  }

  private async addFlightVisuals() {
    const f = this.flight;
    if (!f?.home || !f.gps) return;
    this.ground = await this.sampleGround(f.home.lat, f.home.lon);
    if (f !== this.flight) return;

    this.track = this.viewer.scene.primitives.add(trackPrimitive(f, (t) => this.position(f.poseAt(t)!)));
    this.trail = this.viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(() => {
          const pts: Cartesian3[] = [];
          for (let t = Math.max(0, this.now - TRAIL_SECONDS); t <= this.now; t += 0.1) {
            const p = f.poseAt(t);
            if (p) pts.push(this.position(p));
          }
          return pts;
        }, false),
        width: 3,
        material: Color.WHITE.withAlpha(0.85),
      },
    });
    this.quad = this.viewer.scene.primitives.add(
      await Model.fromGltfAsync({ url: "models/quad.glb", minimumPixelSize: 40, maximumScale: 200 }),
    );
    this.update(this.time());
  }

  private async sampleGround(lat: number, lon: number): Promise<number> {
    const carto = Cartographic.fromDegrees(lon, lat);
    try {
      if (this.layers?.tileset) {
        // wait for the tileset to stream the home area before sampling it
        const [res] = await this.viewer.scene.sampleHeightMostDetailed([carto]);
        if (res?.height !== undefined) return res.height;
      }
      // CustomHeightmapTerrainProvider has no availability info, so Cesium's
      // sampleTerrainMostDetailed can't be used; read the source tile directly
      return (await terrainHeightAt(lat, lon)) ?? 0;
    } catch {
      return 0;
    }
  }

  private position(p: Pose) {
    return Cartesian3.fromDegrees(p.lon, p.lat, this.ground + MODEL_CLEARANCE + p.relAlt);
  }

  /** Called before every frame with the playback time. */
  update(t: number) {
    this.now = t;
    const f = this.flight;
    if (!f || !this.quad) return;
    const pose = f.poseAt(t);
    if (!pose) return;
    const pos = this.position(pose);
    // Cesium heading 0 points the model's nose east; our yaw is a compass heading
    const hpr = new HeadingPitchRoll(pose.yaw - Math.PI / 2, pose.pitch, pose.roll);
    this.quad.modelMatrix = Transforms.headingPitchRollToFixedFrame(pos, hpr);
    this.quad.show = this.camera !== "fpv";
    this.updateCamera(pos, pose, hpr);
  }

  private updateCamera(pos: Cartesian3, pose: Pose, hpr: HeadingPitchRoll) {
    const camera = this.viewer.scene.camera;
    const controller = this.viewer.scene.screenSpaceCameraController;
    const changed = this.camera !== this.lastCamera;
    this.lastCamera = this.camera;
    controller.enableInputs = this.camera === "orbit" || this.camera === "top";

    if (this.camera === "fpv") {
      camera.lookAtTransform(Matrix4.IDENTITY);
      // body axes in ECEF; the camera looks along the nose, tilted up toward body up
      const rot = Matrix3.fromQuaternion(Transforms.headingPitchRollQuaternion(pos, hpr));
      const fwd = Matrix3.getColumn(rot, 0, new Cartesian3());
      const up = Matrix3.getColumn(rot, 2, new Cartesian3());
      const a = CMath.toRadians(this.settings.fpvUptilt);
      const dir = Cartesian3.add(
        Cartesian3.multiplyByScalar(fwd, Math.cos(a), new Cartesian3()),
        Cartesian3.multiplyByScalar(up, Math.sin(a), new Cartesian3()),
        new Cartesian3(),
      );
      const camUp = Cartesian3.subtract(
        Cartesian3.multiplyByScalar(up, Math.cos(a), new Cartesian3()),
        Cartesian3.multiplyByScalar(fwd, Math.sin(a), new Cartesian3()),
        new Cartesian3(),
      );
      camera.setView({ destination: pos, orientation: { direction: dir, up: camUp } });
      setFov(this.viewer, this.settings.fpvFov);
      return;
    }
    setFov(this.viewer, 60);

    const enu = Transforms.eastNorthUpToFixedFrame(pos);
    if (this.camera === "chase") {
      // follow the heading with some lag so the camera doesn't jitter
      const target = pose.yaw;
      if (this.chaseYaw === null || changed) this.chaseYaw = target;
      const d = Math.atan2(Math.sin(target - this.chaseYaw), Math.cos(target - this.chaseYaw));
      this.chaseYaw += d * 0.08;
      camera.lookAtTransform(
        enu,
        new HeadingPitchRange(this.chaseYaw, -CMath.toRadians(this.settings.chaseHeight), this.settings.chaseDistance),
      );
    } else if (this.camera === "top") {
      if (changed) camera.lookAtTransform(enu, new HeadingPitchRange(0, -CMath.PI_OVER_TWO + 0.001, 120));
      else keepOffset(camera, enu);
    } else if (this.camera === "orbit") {
      if (changed) camera.lookAtTransform(enu, new HeadingPitchRange(pose.yaw + Math.PI / 4, -0.35, 25));
      else keepOffset(camera, enu);
    }
  }
}

// Re-anchor the user-controlled camera to the moving quad, keeping its offset.
function keepOffset(camera: Viewer["camera"], enu: Matrix4) {
  const offset = Cartesian3.clone(camera.position);
  camera.lookAtTransform(enu, offset);
}

function setFov(viewer: Viewer, deg: number) {
  const frustum = viewer.scene.camera.frustum as { fov?: number };
  if (frustum.fov !== undefined) frustum.fov = CMath.toRadians(deg);
}

function speedColor(v: number) {
  // 0 → blue, 10 → green, 20 → yellow, 30+ m/s → red
  const k = Math.min(1, Math.max(0, v / 30));
  return Color.fromHsl((1 - k) * 0.66, 0.9, 0.5, 0.9);
}

function trackPrimitive(f: Flight, at: (t: number) => Cartesian3) {
  const g = f.gps!;
  const positions: Cartesian3[] = [];
  const colors: Color[] = [];
  for (let k = 0; k < g.t.length; k++) {
    positions.push(at(g.t[k]));
    colors.push(speedColor(g.speed[k]));
  }
  return new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new PolylineGeometry({ positions, colors, colorsPerVertex: true, width: 2.5, arcType: 0 }),
    }),
    appearance: new PolylineColorAppearance({ translucent: true }),
    asynchronous: false,
  });
}
