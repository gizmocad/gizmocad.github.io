#!/usr/bin/env node
// GizmoCAD MCP server: lets an AI assistant (Claude Desktop, Claude Code, or any
// MCP client) build and edit models in a running GizmoCAD.
//
// The assistant starts this file over stdio. It listens on ws://127.0.0.1:7473
// for GizmoCAD (the website or the desktop app) to connect, which it does once
// "Connect" is switched on in GizmoCAD's menu ▸ AI assistant (MCP). Each tool
// call is passed to the app, which applies it like a normal (undoable) edit.
//
// No dependencies: Node 18+ only. Settings (environment variables):
//   GIZMOCAD_MCP_PORT     port to listen on (default 7473)
//   GIZMOCAD_MCP_ORIGINS  extra comma-separated page origins allowed to connect

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

const VERSION = "1.0.0";
const PORT = Number(process.env.GIZMOCAD_MCP_PORT) || 7473;
const ORIGINS = [
  "https://gizmocad.github.io",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  ...(process.env.GIZMOCAD_MCP_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
];
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const log = (...args) => console.error("[gizmocad-mcp]", ...args); // stdout is the MCP channel.

// ---- WebSocket bridge to the app ------------------------------------------------

/** Open app connections, newest last; calls go to the newest. */
const apps = [];
let listenError = null;
const pending = new Map();
let nextId = 1;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`GizmoCAD MCP bridge ${VERSION}: ${apps.length ? "GizmoCAD is connected" : "waiting for GizmoCAD to connect"}.\n`);
});

server.on("upgrade", (req, socket) => {
  const origin = req.headers.origin ?? "";
  const key = req.headers["sec-websocket-key"];
  // Only GizmoCAD's own pages may connect (any web page could otherwise reach localhost).
  if (!key || req.headers.upgrade?.toLowerCase() !== "websocket" || !(ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin))) {
    log(`refused a connection from origin "${origin}"`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const app = { socket, info: null, buffer: Buffer.alloc(0), fragments: [], closed: false };
  apps.push(app);
  log(`GizmoCAD connected from ${origin}`);
  socket.on("data", (chunk) => readFrames(app, chunk));
  const drop = () => {
    if (app.closed) return;
    app.closed = true;
    apps.splice(apps.indexOf(app), 1);
    for (const [id, p] of pending) if (p.app === app) {
      pending.delete(id);
      p.reject(new Error("GizmoCAD disconnected before it answered."));
    }
    log("GizmoCAD disconnected");
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

server.on("error", (err) => {
  listenError = err.code === "EADDRINUSE"
    ? `Port ${PORT} is already in use (probably another GizmoCAD MCP server, e.g. from another AI app). Close that one, or set GIZMOCAD_MCP_PORT here and the same port in GizmoCAD's AI assistant settings.`
    : `The bridge couldn't start: ${err.message}`;
  log(listenError);
});
server.listen(PORT, "127.0.0.1", () => log(`waiting for GizmoCAD on ws://127.0.0.1:${PORT}`));

/** Parse incoming WebSocket frames (client frames are always masked). */
function readFrames(app, chunk) {
  app.buffer = Buffer.concat([app.buffer, chunk]);
  for (;;) {
    const b = app.buffer;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return;
      len = b.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return;
      len = Number(b.readBigUInt64BE(2));
      at = 10;
    }
    const maskAt = at;
    if (masked) at += 4;
    if (b.length < at + len) return;
    const payload = Buffer.from(b.subarray(at, at + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskAt + (i & 3)];
    app.buffer = b.subarray(at + len);

    if (opcode === 0x8) {
      sendFrame(app, 0x8, Buffer.alloc(0));
      app.socket.end();
      return;
    }
    if (opcode === 0x9) {
      sendFrame(app, 0xa, payload);
      continue;
    }
    if (opcode === 0xa) continue;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      app.fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(app.fragments).toString("utf8");
      app.fragments = [];
      onAppMessage(app, text);
    }
  }
}

function sendFrame(app, opcode, payload) {
  if (app.closed) return;
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  app.socket.write(Buffer.concat([head, payload]));
}

function onAppMessage(app, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    app.info = msg;
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error ?? "GizmoCAD couldn't do that."));
}

const NOT_CONNECTED =
  "GizmoCAD isn't connected. Open GizmoCAD (https://gizmocad.github.io or the desktop app), click the GizmoCAD menu (top left) ▸ AI assistant (MCP), and switch on Connect. Then try again.";

/** Send a command to the app and wait for its answer. Waits a few seconds for the app to (re)connect first. */
async function callApp(method, params = {}, timeoutMs = 120000) {
  if (listenError) throw new Error(listenError);
  for (let waited = 0; !apps.length && waited < 5000; waited += 250) await new Promise((r) => setTimeout(r, 250));
  const app = apps[apps.length - 1];
  if (!app) throw new Error(NOT_CONNECTED);
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("GizmoCAD didn't answer in time (a big rebuild can take a while; try get_model to see where it got to)."));
    }, timeoutMs);
    pending.set(id, { app, resolve: resolvePromise, reject, timer });
    sendFrame(app, 0x1, Buffer.from(JSON.stringify({ id, method, params }), "utf8"));
  });
}

// ---- Tools --------------------------------------------------------------------

const vec3 = (what) => ({
  type: "object",
  description: what,
  properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
});
const edgesSchema = {
  type: "array",
  description:
    "Edge finishes, applied in order (replaces any existing ones on update; [] removes them all). Not available on sculpt, plane, screw, thread or spring objects, and ignored on text.",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["fillet", "chamfer", "bevel"], description: "fillet = rounded, chamfer = 45° flat cut, bevel = flat cut at `angle`." },
      size: { type: "number", description: "Fillet radius or chamfer/bevel distance in mm. Too big for the shape: the largest safe size is used and reported." },
      edges: { type: "string", enum: ["all", "top", "bottom", "vertical"], description: "Which edges (default all)." },
      angle: { type: "number", description: "Bevel only: angle of the cut from the flatter face, 1–89° (default 30)." },
    },
    required: ["type", "size"],
  },
};
const objectFields = {
  name: { type: "string" },
  params: { type: "object", description: "Shape parameters (see list_shape_types). On update, only the keys given change." },
  position: vec3("Position in mm relative to the parent (or the world). Primitives: centre in X/Y, bottom face at Z. Default 0,0,0 (sitting on the floor at the centre)."),
  rotation: vec3("Rotation in degrees relative to the parent, applied about X, then Y, then Z."),
  mode: { type: "string", enum: ["solid", "hole"], description: "hole: cuts away from solids instead (see the server instructions for what it cuts)." },
  color: { type: "string", description: 'Display / 3MF colour such as "#e05252".' },
  parent: { type: ["string", "null"], description: "Id of the group or object to put it inside (null: top level). Its position is then relative to the parent." },
  edges: edgesSchema,
  hollow: {
    type: ["object", "null"],
    description: "Hollow it out: walls `thickness` mm thick, open at the top or bottom or closed (null removes it).",
    properties: { thickness: { type: "number" }, open: { type: "string", enum: ["none", "top", "bottom"] } },
  },
  tilt: {
    type: ["object", "null"],
    description: "Taper the sides in by `taper` degrees (negative: out), and/or lean the whole shape so its top shifts along X/Y (`leanX`, `leanY` degrees). null straightens it.",
    properties: { taper: { type: "number" }, leanX: { type: "number" }, leanY: { type: "number" } },
  },
  texture: {
    type: ["object", "null"],
    description:
      "A real, printable surface pattern on its finished shape (shown, and in STL/3MF exports; STEP gets the plain shape). pattern: knurl|ribs|rings|bumps|honeycomb|grid|bricks|waves|wood|rough; depth (mm, default 0.6); size (mm per repeat, default 2); faces: sides|all|top (default sides); wrap: auto|around|flat; raised (default false: pressed in). null removes it.",
    properties: {
      pattern: { type: "string", enum: ["knurl", "ribs", "rings", "bumps", "honeycomb", "grid", "bricks", "waves", "wood", "rough"] },
      depth: { type: "number" },
      size: { type: "number" },
      faces: { type: "string", enum: ["sides", "all", "top"] },
      wrap: { type: "string", enum: ["auto", "around", "flat"] },
      raised: { type: "boolean" },
    },
  },
  mirrored: { type: "boolean", description: "Mirror it across its own YZ plane (X → −X)." },
  hidden: { type: "boolean", description: "Hide it in the view (still part of the model)." },
  ghost: { type: "boolean", description: "Ghost it: see-through in the view, and clicks and placing go through it (still part of the model and exports)." },
};

const TOOLS = [
  {
    name: "get_model",
    description:
      "Everything in the open GizmoCAD model: each object's id, name, kind, solid/hole, parent, position, rotation, parameters, finishes, its world bounding box (mm), and any build error. Call this first to see what's there, and after changes to check them.",
    inputSchema: { type: "object", properties: { include_sketch_geometry: { type: "boolean", description: "Include every sketch's full entity list (default: just a count)." } } },
  },
  {
    name: "list_shape_types",
    description: "Reference for every object kind GizmoCAD can make, with its parameters, units and defaults, and how sketches are described. Read this before adding objects.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_object",
    description:
      "Add one object (a primitive shape, text, screw hole, sketch, group or plane). Missing parameters take their defaults. Returns its id, world bounding box and any build error. All sizes are millimetres.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["box", "cylinder", "sphere", "cone", "tube", "torus", "wedge", "pyramid", "prism", "hedron", "thread", "gear", "spring", "star", "text", "screw", "sketch", "group", "plane"],
        },
        ...objectFields,
      },
      required: ["kind"],
    },
  },
  {
    name: "update_object",
    description: "Change an existing object: any of its fields. `params` are merged into its current parameters. Returns the result and any build error.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...objectFields }, required: ["id"] },
  },
  {
    name: "delete_objects",
    description: "Delete objects (and everything inside them).",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
  {
    name: "group_objects",
    description:
      "Put objects into a new group, keeping where they are in the world. A group merges its solids into one part, and holes inside it cut only that group, so group a part with its holes. Fillets/chamfers on a group act on the merged result (e.g. a hole's rim).",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } }, name: { type: "string" }, mode: { type: "string", enum: ["solid", "hole"] } },
      required: ["ids"],
    },
  },
  {
    name: "screenshot",
    description:
      "A picture of the model as GizmoCAD shows it (the user's own view isn't moved). Use it to check your work. Shapes are shown with their holes already cut, and the hole objects drawn see-through red on top; show_result shows only the finished boolean result (holes hidden, parts merged).",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["iso", "front", "back", "left", "right", "top", "bottom", "current"], description: "Default iso (from the front-right, above)." },
        show_result: { type: "boolean", description: "Show the finished boolean result (holes cut) instead of the editable parts. Default false." },
        ids: { type: "array", items: { type: "string" }, description: "Frame just these objects (default: everything)." },
        width: { type: "number", description: "Pixels, up to 1600 (default 800)." },
        height: { type: "number", description: "Pixels, up to 1600 (default 600)." },
      },
    },
  },
  {
    name: "select_objects",
    description: "Select objects in GizmoCAD (highlights them for the user and shows them in the properties panel). [] clears the selection.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
  {
    name: "undo",
    description: "Undo the last change in GizmoCAD (yours or the user's). `steps` undoes several.",
    inputSchema: { type: "object", properties: { steps: { type: "number" } } },
  },
  {
    name: "redo",
    description: "Redo what undo took back.",
    inputSchema: { type: "object", properties: { steps: { type: "number" } } },
  },
  {
    name: "new_model",
    description: "Start a new, empty model (undoable). Ask the user first if the current model has work in it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_file",
    description:
      "Save the model to a file on this computer: .gizmocad (GizmoCAD's own format, re-openable), .stl (3D printing), .3mf (slicers, with colours) or .step (other CAD). The format follows the file extension. `path` must be absolute.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "import_files",
    description:
      "Import files from this computer into the current model (added side by side, centred on the floor; undoable). Reads STEP/.stp, FreeCAD .FCStd and BREP as exact solids; STL, 3MF, OBJ, PLY, OFF and glTF/GLB as meshes; DXF and SVG drawings as sketches; and other .gizmocad models. Include an OBJ's .mtl or a .gltf's .bin in the same call. Paths must be absolute.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
  },
  {
    name: "open_file",
    description: "Open a .gizmocad model file from this computer in GizmoCAD (replacing the current model; undoable). `path` must be absolute.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

const SHAPE_REFERENCE = `GizmoCAD object kinds. All lengths in mm, angles in degrees. Z is up; the floor (print bed) is Z = 0.
An object's position is its centre in X/Y and its bottom in Z (relative to its parent), so position {x:0,y:0,z:0} sits on the floor at the centre.
Round shapes store RADII (the app's panel shows diameters).

box       width (X), depth (Y), height (Z).                                   default 20, 20, 20
cylinder  radius (X radius), radiusY (Y radius; equal = round), height.        default 10, 10, 20
sphere    radius, radiusY, radiusZ (different = ellipsoid). Bottom at Z=0.     default 10, 10, 10
cone      radius (bottom), topRadius (0 = pointed), height.                   default 10, 0, 20
tube      radius (outer), wall (thickness), height.                           default 10, 2, 20
torus     (ring lying flat) radius (outer, to the outside of the ring), tube (radius of the ring's cross-section). default 15, 4
wedge     width, depth, height: full height at -X, sloping to nothing at +X. default 20, 20, 20
pyramid   width, depth, height (square-based, point on top).                  default 20, 20, 20
prism     radius (centre to corner), sides (3–64), height.                    default 10, 6, 20
hedron    faces (4, 6, 8, 12 or 20: tetra/cube/octa/dodeca/icosahedron), radius (centre to corner). Rests on a face. default 20, 12
thread    diameter (outside), pitch, length: a threaded rod; as a hole, a threaded hole/nut. default 10, 1.5, 20
gear      teeth, module (tooth size; outside Ø = module × (teeth + 2)), thickness, bore (centre hole Ø, 0 = none). default 20, 1.5, 6, 5
          Two gears mesh at centre distance (teeth1 + teeth2) × module / 2 with the same module.
spring    style "coil"|"flat", diameter (coil: outside Ø; flat: width X), wire (thickness), pitch, height (coil: Z; flat: length Y),
          section "round"|"square", ends (bool: flat ground ends / end plates), depth (flat: thickness Z), bends "round"|"sharp".
star      points, radius (outer), inner (inner radius), height.               default 5, 15, 7, 5
text      text (string, \\n for new lines), font "sans"|"serif"|"mono"|"rounded"|"condensed"|"poster"|"stencil"|"techno"|"cartoon"|"comic"|"script"|"handwriting"|"blackletter" (fonts the user imported show as "custom:<id>"), bold (bool), size (capital height), height (Z),
          spacing (extra mm between letters), align "left"|"center"|"right". As a hole it engraves.   default "Text", sans, bold, 10, 2, 0, center
screw     (a hole for a metric screw, going DOWN from its position into what it sits on) size "M2"|"M2.5"|"M3"|"M4"|"M5"|"M6"|"M8"|"M10",
          fit "tap"|"close"|"normal"|"loose", head "none"|"counterbore"|"countersink", depth. Put it on a top face, e.g. z = the part's top.
group     no params: a container. Its solids merge into one part; holes inside a group cut only that group.
plane     size: a reference plane (display only); sketches inside it are drawn on it.
imported  (made by import_files from STEP/FreeCAD/BREP, and from closed meshes up to 20,000 triangles) a solid; its only param is scale: a number (1 = as imported) or [x, y, z]. Uneven scales make curves faceted. Can be a hole and take fillets.
sketch    a 2D drawing made 3D:
          plane "XY"|"XZ"|"YZ" (U,V axes: XY→U=X,V=Y; XZ→U=X,V=Z; YZ→U=Y,V=Z), offset (shift along the plane's normal),
          operation "extrude"|"revolve"|"flat" (flat = drawing only), depth (extrude distance), direction "normal"|"reversed"|"both",
          angle (revolve degrees, around the sketch's V axis; keep revolve profiles on the +U side), entities: [...].
          Each entity has "type" and an optional "mode": "add" (default), "subtract" (cuts a hole in the sketch) or "construction" (guide only):
            {type:"rect", x, y (centre), width, height, angle?, radius? (corner rounding)}
            {type:"circle", x, y, radius}
            {type:"ellipse", x, y, rx, ry, angle?}
            {type:"ngon", x, y, radius (to corners), sides, angle?}
            {type:"slot", x1, y1, x2, y2, radius}   (a stadium / rounded slot between two centres)
            {type:"polygon", points:[[u,v],...], bends?:[...] (per edge: arc bulge in mm, 0 = straight)}
            {type:"spline", points:[[u,v],...]}   (smooth closed curve through the points)
            {type:"line", x1, y1, x2, y2}         (construction/reference; not a closed profile)
          Example: a 40×20 plate with two 4 mm holes, 3 mm thick:
            {plane:"XY", operation:"extrude", depth:3, entities:[{type:"rect",x:0,y:0,width:40,height:20,radius:3},
              {type:"circle",x:-14,y:0,radius:2,mode:"subtract"},{type:"circle",x:14,y:0,radius:2,mode:"subtract"}]}

Holes: an object with mode "hole" cuts the solids it shares a group/parent branch with (at the top level: all top-level solids).
To make a part with holes, either use hole objects (and group them with the part), or subtract shapes inside a sketch.
Edge finishes (fillet / chamfer / bevel) go on boxes, cylinders, spheres, cones, tubes, rings, wedges, pyramids, prisms, hedrons, gears, stars, sketches and groups.`;

const INSTRUCTIONS = `This server controls GizmoCAD, a parametric CAD app (aimed at 3D printing), running in the user's browser or desktop app.
Start with get_model and list_shape_types. Units are millimetres, Z is up, and objects sit on the floor (Z = 0) by default.
Every change is a normal undoable edit the user sees live. After building something, check it with screenshot (show_result: true shows holes cut).
If a tool says GizmoCAD isn't connected, ask the user to open GizmoCAD's menu ▸ AI assistant (MCP) and switch on Connect.`;

async function callTool(name, args = {}) {
  switch (name) {
    case "list_shape_types":
      return text(SHAPE_REFERENCE);
    case "screenshot": {
      const r = await callApp("screenshot", args);
      return { content: [{ type: "image", data: r.png, mimeType: "image/png" }, ...(r.note ? [{ type: "text", text: r.note }] : [])] };
    }
    case "save_file": {
      const path = checkPath(args.path);
      const ext = path.toLowerCase().split(".").pop();
      if (!["gizmocad", "stl", "3mf", "step", "stp"].includes(ext)) throw new Error("Use a .gizmocad, .stl, .3mf or .step file name.");
      const r = await callApp("export", { format: ext === "stp" ? "step" : ext });
      const bytes = Buffer.from(r.base64, "base64");
      await writeFile(path, bytes);
      return text(`Saved ${path} (${bytes.length.toLocaleString()} bytes).${r.note ? ` ${r.note}` : ""}`);
    }
    case "import_files": {
      if (!Array.isArray(args.paths) || !args.paths.length) throw new Error("Give one or more absolute file paths in `paths`.");
      const files = [];
      for (const p of args.paths) {
        const path = checkPath(p);
        files.push({ name: basename(path), base64: (await readFile(path)).toString("base64") });
      }
      return json_(await callApp("import", { files }));
    }
    case "open_file": {
      const path = checkPath(args.path);
      const json = await readFile(path, "utf8");
      return json_(await callApp("load", { json }));
    }
    default:
      if (!TOOLS.some((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);
      return json_(await callApp(name, args));
  }
}

function checkPath(path) {
  if (typeof path !== "string" || !path) throw new Error("Give a file path.");
  if (!isAbsolute(path)) throw new Error(`Use an absolute path (got "${path}"; e.g. ${resolve(path)}).`);
  return path;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const json_ = (value) => text(typeof value === "string" ? value : JSON.stringify(value, null, 2));

// ---- MCP over stdio (JSON-RPC 2.0, one message per line) --------------------------

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "gizmocad", title: "GizmoCAD", version: VERSION },
          instructions: INSTRUCTIONS,
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        try {
          result = await callTool(params?.name, params?.arguments ?? {});
        } catch (err) {
          result = { content: [{ type: "text", text: err.message ?? String(err) }], isError: true };
        }
        break;
      default:
        if (!isRequest) return; // Notifications (initialized, cancelled, …) need no answer.
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    if (isRequest) send({ jsonrpc: "2.0", id, result });
  } catch (err) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message ?? String(err) } });
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let nl;
  while ((nl = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, nl).trim();
    input = input.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m);
  }
});
process.stdin.on("end", () => process.exit(0));
