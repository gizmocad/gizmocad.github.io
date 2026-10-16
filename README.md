# GizmoCAD

3D CAD that's as easy as Tinkercad but precise enough for real parts. It runs in the browser and also as a desktop app.

- Drag shapes in (box, cylinder, sphere, cone, tube, ring, wedge, pyramid, polygon prism, hedron (4, 6, 8, 12 or 20 faces), thread, gear, spring, star, text, screw hole),
  then type exact sizes. A thread set to Hole makes a threaded hole (nut); gears have real involute teeth.
  Springs come as coils (round or square wire, open or flat ends) or flat zigzag springs (rounded or sharp bends) that print lying down.
  **Text** comes in sans, serif or mono (bold or not, any alignment, several lines); make it a Hole to engrave it.
  **Screw holes** (M2–M10) go down into the face you put them on, with a tap, close, normal or loose fit and an optional
  counterbore or countersink.
  Fields accept units and maths (`1in`, `2.5cm`, `40/3`).
- **Placing shapes:** click a shape button (or drag it into the view) and a preview follows the mouse. Click to put it
  on the face under the mouse, standing out from that face and snapped to its grid, centre and corners, or on the ground grid.
  Press F while placing to flip it into the face instead (hanging under it, or an axle pointing down). Right-click or Esc cancels.
- **Hinges, axles, orbits & sliders:** in an object's Connection section, click Hinge / axle, Orbit (circles an axis
  while staying upright) or Slider, then click a point on
  the object it attaches to, or on the object itself and then the object it attaches to (the face there sets the axis;
  the empty build plate is ignored). It's then attached to that object: Spin/Slide (J) moves it on the
  connection (drag the ring or arrow, or type the angle/distance, with optional limits), while Move and Rotate reposition
  it together with its connection, and Pivot (P) moves just the connection (it snaps to object points).
- **Onto face** (F): move the selected object onto another object's face (or the grid) the same way.
- **Show/hide** objects with the eye in the object list (or H). Hidden objects still count in the model and exports.
- **Select several objects:** Shift/Ctrl-click (in the view or the list), Shift-drag a box in the view, or Ctrl+A. Then move or
  turn them together with the gizmo, **align** their sides or centres, **space them evenly**, colour, mirror, duplicate,
  delete, or **group** them (Ctrl+G).
- **Copy and paste** (Ctrl+C / Ctrl+X / Ctrl+V), also between GizmoCAD windows.
- **Mirror** any object (or several) along X, Y or Z, in place.
- **Repeat:** copies in a row, a grid, or around a circle (e.g. holes round a flange), previewed before they're added.
- **Hollow:** turn a solid into walls of a set thickness, open at the top or bottom, or closed.
- **Tilt:** taper an object's sides in or out by an angle (the base keeps its size), or lean the whole shape over along X or Y.
- **Colours** per object, shown in the view and saved into 3MF exports.
- **Measure** (M): click two points (corners and edges snap) for the distance and its X/Y/Z parts; two faces also give their angle.
- Mark any shape as a **hole**. **Show result** shows the true boolean result, computed by the OpenCascade kernel.
- **Sketches:** points, guide lines, rectangles (rounded corners, any angle), circles, ellipses,
  regular polygons, slots, polygons with arc edges, smooth curves (closer points make tighter bends), and freehand brush strokes, on the XY/XZ/YZ plane or any
  tilted Plane object. Shapes can add to the profile, cut it, or just act as guides. Snap to existing
  points and the grid (hold Alt to place freely). Edit by dragging the dots, typing exact values, or right-clicking.
  A finished sketch stays flat (just a drawing) until you click Extrude (up, down or both ways) or Revolve in the 3D view.
- **Split & dividers:** cut any shape or sketch into pieces along X, Y or Z, tilted at any angle, with as many parallel
  cuts as you like (drag each cut's arrow or type it, or space them evenly; all pieces stay editable),
  or add evenly spaced divider walls (count, thickness, height), e.g. inside a tray.
  In sketches, the Trim tool (T) merges shapes where you click an edge inside another shape, trims off the part of a shape sticking out
  of another when you click its outside edge, cuts a shape along a guide line (dropping the side you click), or trims a guide line back
  to its crossings, and "Trim overlaps" merges all selected overlapping shapes. The Split tool (X) cuts a line or brush stroke in two, or adds a corner to a shape's edge.
- **Sketch constraints:** with the Constrain tool (K), click one or two points, edges or circles and pick horizontal,
  vertical, parallel, perpendicular, equal, tangent, coincident or fixed, or a length, distance, diameter or angle
  dimension. The drawing then keeps to them as you edit it, and the values can be changed in the panel.
- **Fillets & chamfers:** round or bevel all, top, bottom or vertical edges, or edges you click.
  On a group they act on the merged result (e.g. the rim of a hole). A size that's too big for
  the shape is automatically reduced to the largest safe size, and the panel shows the size used.
- **Sculpting:** free-form clay (start from a sphere or cube, or turn any shape, sketch or group
  into clay with "Sculpt this object") shaped with Draw, Inflate, Smooth,
  Flatten and Grab brushes, with optional X mirroring and "Add detail" to refine the mesh. Sculpts are meshes: they export to STL
  (not STEP) and don't take part in holes or fillets.
- **Parent/child objects:** drag objects onto each other in the list (or use the Parent dropdown).
  Children move with their parent, and a child hole only cuts its own parent's branch. Groups are empty containers.
- **Move / Rotate / Resize** gizmo (W / E / R). Resizing changes the object's real dimensions,
  snapped to the grid, rather than stretching it. **Keep ratio** (or Shift while dragging) resizes
  evenly, and a 3D ruler shows the size along each axis as you drag. **One side** resizes only the end whose handle you drag, keeping the opposite
  face where it is. Spheres stretch into ellipsoids and cylinders into ovals.
- **Points**: while moving, every object shows snap points (corners, edge middles, face centres).
  Drag an object near another's point and it snaps there, so faces and edges line up exactly.
  The Points menu can hide the dots (snapping still works) or turn point snapping off.
- **View cube** in the corner of the 3D view turns with the camera; click a face, edge or corner to look from that side.
  Below it: fit everything in view (Home), zoom to the selection (.), a **section view**
  that cuts the model open along X, Y or Z, and Measure.
- **History** along the bottom: every object is a step. Roll back to see (and edit) the model as it was at any step;
  new objects go in at the marker, and changes flow through to the later steps. Right-click a step to switch it off.
- **Autosave:** your work is kept in the browser/app and comes back next time you open GizmoCAD.
- **Print bed:** pick your printer in the GizmoCAD menu to see its bed and get a warning when the model doesn't fit.
- Snap to the grid, undo/redo. New, Open, Save, Export and Theme are in the menu under the GizmoCAD logo.
- Export **STEP** (for other CAD programs), **STL** (for 3D printing) and **3MF** (for slicers, one object per part,
  with colours). **Import** STL meshes and SVG drawings (closed shapes become a sketch, holes included).

## Development

```bash
npm install
npm run dev            # website at http://localhost:5173
npm run tauri dev      # desktop app (needs Rust + system WebKit)
```

## Releasing

- **Website:** every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`).
  Enable it once under *Settings → Pages → Source: GitHub Actions*.
- **Installers:** push a version tag (`git tag v0.1.0 && git push --tags`). GitHub builds
  Windows (`.msi`/`.exe`), macOS (`.dmg`) and Linux (`.deb`/`.AppImage`) installers and
  attaches them to a draft Release (`.github/workflows/release.yml`). Bump the version in
  `package.json` and `src-tauri/tauri.conf.json` first.

## How it's built

| File | Role |
|---|---|
| `src/model.ts` | The document: a list of operations (shapes with exact parameters). |
| `src/kernel.worker.ts` | Rebuilds geometry with replicad/OpenCascade in a Web Worker. |
| `src/kernel.ts` | Promise API the UI uses to talk to the worker. |
| `src/viewport.ts` | Three.js view: Z-up workplane, orbit, picking, move gizmo, sketch-mode camera. |
| `src/sketcher.ts` | Sketch tools, selection, handles, snapping, context menu. |
| `src/sculpt.ts` | Sculpt meshes, brushes, and adding them to STL exports. |
| `src/sketchGeometry.ts` | Exact outlines of sketch shapes, shared by the kernel and the editor. |
| `src/constraints.ts` | Sketch constraints and the solver that keeps drawings to them. |
| `src/fileFormats.ts` | 3MF export, STL and SVG import, autosave. |
| `src/viewCube.ts` | The view orientation cube. |
| `src/main.ts` | UI: panels, undo/redo, commands, keyboard shortcuts. |
| `src/storage.ts` | Save/open: native dialogs in the desktop app, downloads on the web. |
| `src-tauri/` | Desktop wrapper and installer config. |

## Roadmap

1. ~~Primitives, exact dimensions, snapping, holes, STEP/STL export~~
2. ~~Sketches (extrude/revolve) and parent/child objects~~
3. ~~Sketch constraints (equal, parallel, tangent, dimensions)~~
4. ~~Multi-select, alignment and measuring tools~~
5. ~~Editable history (roll back, switch steps off)~~

## Credits

Text uses the Roboto, Roboto Slab (SIL Open Font License 1.1) and Roboto Mono (Apache 2.0) fonts, bundled via Fontsource.
