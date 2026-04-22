# STL Texture Carver

An Electron desktop app that carves PNG texture patterns into STL 3D models.

## How it works

1. **Load an STL** file — the model appears in the left 3D viewport
2. **Click a face** on the model to set the carve direction (perpendicular to that face)
3. **Load a texture** PNG/JPG — black pixels will be carved through, white pixels left untouched
4. Set an **output filename** (default: `output.stl`)
5. Click **Process** — the carved model appears in the right viewport

## Carving method

- The STL is voxelized using triangle surface rasterization
- Exterior voxels are identified via 3D flood fill from the bounding box surface
- The PNG texture is mapped onto the face perpendicular to the selected carve axis
- Black pixel columns are carved through the full depth of the object
- The resulting solid is re-meshed using a surface net algorithm
- Output is a valid binary STL

## Installation

```bash
npm install
npm start
```

## Dependencies

- [Electron](https://www.electronjs.org/) — desktop app shell
- [Three.js](https://threejs.org/) — 3D preview and face picking
- [sharp](https://sharp.pixelplumbing.com/) — image processing

## Resolution

Default voxel grid is 256×256. To change it, edit `GRID_UV` in `carve.js`.
