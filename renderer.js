import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const { ipcRenderer } = window.require('electron');

// ─── State ────────────────────────────────────────────────────────────────────
let stlPath = null;
let pngPath = null;

// Each entry: { id, normal:{x,y,z}, d:number, triIndices:[], mesh:THREE.Mesh|null }
let faceGroups   = [];
let selectedIds  = new Set(); // selected face-group IDs
let inputMesh    = null;
let highlightMeshes = {}; // id -> THREE.Mesh overlay

// UI
const btnStl     = document.getElementById('btn-stl');
const btnPng     = document.getElementById('btn-png');
const btnBrowse  = document.getElementById('btn-browse-out');
const btnProcess = document.getElementById('btn-process');
const btnClear   = document.getElementById('btn-clear-sel');
const stlPathEl  = document.getElementById('stl-path');
const pngPathEl  = document.getElementById('png-path');
const outNameEl  = document.getElementById('out-name');
const statusEl   = document.getElementById('status');
const faceInfoEl = document.getElementById('face-info');
const faceListEl = document.getElementById('face-list');

// Sliders
const slScale = document.getElementById('sl-scale');
const slRot   = document.getElementById('sl-rot');
const slOx    = document.getElementById('sl-ox');
const slOy    = document.getElementById('sl-oy');
const valScale = document.getElementById('val-scale');
const valRot   = document.getElementById('val-rot');
const valOx    = document.getElementById('val-ox');
const valOy    = document.getElementById('val-oy');

slScale.addEventListener('input', () => { valScale.textContent = slScale.value + '%'; });
slRot.addEventListener('input',   () => { valRot.textContent   = slRot.value + '°'; });
slOx.addEventListener('input',    () => { valOx.textContent    = slOx.value + '%'; });
slOy.addEventListener('input',    () => { valOy.textContent    = slOy.value + '%'; });

function getTextureParams() {
  return {
    scale:    parseFloat(slScale.value) / 100,
    rotation: parseFloat(slRot.value),
    offsetX:  parseFloat(slOx.value) / 100,
    offsetY:  parseFloat(slOy.value) / 100,
  };
}

function setStatus(msg, color = '#a6adc8') {
  statusEl.style.color = color;
  statusEl.textContent = msg;
}

function checkReady() {
  btnProcess.disabled = !(stlPath && pngPath && selectedIds.size > 0);
}

function toFileUrl(p) {
  const n = p.replace(/\\/g, '/');
  return encodeURI(n.startsWith('/') ? `file://${n}` : `file:///${n}`);
}

// ─── Viewports ────────────────────────────────────────────────────────────────
function makeViewport(containerId) {
  const container = document.getElementById(containerId);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11111b);

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 10000);
  camera.position.set(3, 3, 3);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const d1 = new THREE.DirectionalLight(0xffffff, 1.1); d1.position.set(3, 4, 5); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0x89b4fa, 0.45); d2.position.set(-4, -2, -3); scene.add(d2);
  scene.add(new THREE.GridHelper(100, 50, 0x313244, 0x313244));

  new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }).observe(container);

  (function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); })();
  return { container, renderer, scene, camera, controls };
}

const vpInput  = makeViewport('vp-input');
const vpOutput = makeViewport('vp-output');
const loader   = new STLLoader();

function clearScene(scene) {
  const rem = scene.children.filter(c => c.userData.managed);
  rem.forEach(o => { scene.remove(o); o.geometry?.dispose(); if (Array.isArray(o.material)) o.material.forEach(m=>m.dispose()); else o.material?.dispose(); });
}

function frameTo(camera, controls, scene) {
  const box = new THREE.Box3();
  scene.children.filter(c => c.userData.isMesh).forEach(c => box.expandByObject(c));
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 2.2;
  camera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
  camera.near = Math.max(0.01, maxDim / 1000);
  camera.far  = Math.max(1000, maxDim * 20);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// ─── Face group detection ─────────────────────────────────────────────────────
// Groups triangles that share the same snapped axis-aligned normal AND
// the same plane offset (dot(centroid, normal) quantized).
const NORMAL_SNAP  = 0.2;  // cos threshold for "same direction"
const PLANE_QUANT  = 4;    // decimal places for plane offset key

function buildFaceGroups(geometry) {
  const pos = geometry.attributes.position;
  const numTris = pos.count / 3;
  const groups  = new Map(); // key -> { id, normal, d, triIndices }

  for (let i = 0; i < numTris; i++) {
    const ai = i * 3, bi = ai + 1, ci = ai + 2;
    const a = new THREE.Vector3().fromBufferAttribute(pos, ai);
    const b = new THREE.Vector3().fromBufferAttribute(pos, bi);
    const c = new THREE.Vector3().fromBufferAttribute(pos, ci);

    // Raw face normal
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const raw = new THREE.Vector3().crossVectors(ab, ac).normalize();

    // Snap to nearest axis
    const ax = Math.abs(raw.x), ay = Math.abs(raw.y), az = Math.abs(raw.z);
    let snapped;
    if (ax >= ay && ax >= az)      snapped = new THREE.Vector3(Math.sign(raw.x), 0, 0);
    else if (ay >= ax && ay >= az) snapped = new THREE.Vector3(0, Math.sign(raw.y), 0);
    else                           snapped = new THREE.Vector3(0, 0, Math.sign(raw.z));

    // Only group if the triangle is reasonably aligned (not highly oblique)
    if (raw.dot(snapped) < NORMAL_SNAP) continue;

    // Plane offset: centroid · snapped_normal
    const centroid = new THREE.Vector3().addVectors(a, b).add(c).divideScalar(3);
    const d = centroid.dot(snapped);
    const dKey = d.toFixed(PLANE_QUANT);
    const key  = `${snapped.x},${snapped.y},${snapped.z}|${dKey}`;

    if (!groups.has(key)) {
      groups.set(key, { id: key, normal: { x: snapped.x, y: snapped.y, z: snapped.z }, d, triIndices: [] });
    }
    groups.get(key).triIndices.push(i);
  }

  // Filter tiny groups (< 2 triangles)
  return [...groups.values()].filter(g => g.triIndices.length >= 2);
}

// ─── Highlight overlays ───────────────────────────────────────────────────────
const MAT_HOVER    = new THREE.MeshBasicMaterial({ color: 0x89b4fa, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false });
const MAT_SELECTED = new THREE.MeshBasicMaterial({ color: 0xf38ba8, transparent: true, opacity: 0.50, side: THREE.DoubleSide, depthTest: false });

function buildGroupOverlayGeo(group, posAttr, offsetLen) {
  const verts = [];
  const nrm   = new THREE.Vector3(group.normal.x, group.normal.y, group.normal.z);
  const offset = nrm.clone().multiplyScalar(offsetLen);

  for (const ti of group.triIndices) {
    const ai = ti * 3;
    for (let k = 0; k < 3; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(posAttr, ai + k).add(offset);
      verts.push(v.x, v.y, v.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return geo;
}

function rebuildHighlights() {
  if (!inputMesh) return;
  const pos = inputMesh.geometry.attributes.position;
  const bbSize = inputMesh.geometry.boundingBox
    ? inputMesh.geometry.boundingBox.getSize(new THREE.Vector3()).length()
    : 1;
  const offsetLen = 0.002 * bbSize;

  // Remove old
  Object.values(highlightMeshes).forEach(m => {
    vpInput.scene.remove(m); m.geometry.dispose();
  });
  highlightMeshes = {};

  for (const g of faceGroups) {
    if (!selectedIds.has(g.id)) continue;
    const geo  = buildGroupOverlayGeo(g, pos, offsetLen);
    const mesh = new THREE.Mesh(geo, MAT_SELECTED);
    mesh.userData.managed = true;
    mesh.renderOrder = 1;
    vpInput.scene.add(mesh);
    highlightMeshes[g.id] = mesh;
  }
}

// ─── Face list sidebar ────────────────────────────────────────────────────────
function renderFaceList() {
  faceListEl.innerHTML = '';
  const axisLabel = n => {
    if (n.x) return `${n.x > 0 ? '+' : '-'}X`;
    if (n.y) return `${n.y > 0 ? '+' : '-'}Y`;
    return `${n.z > 0 ? '+' : '-'}Z`;
  };

  for (const g of faceGroups) {
    const el = document.createElement('div');
    el.className = 'face-item' + (selectedIds.has(g.id) ? ' selected' : '');
    el.innerHTML = `<span class="face-dot"></span>${axisLabel(g.normal)} &mdash; ${g.triIndices.length} tris`;
    el.dataset.id = g.id;
    el.addEventListener('click', e => toggleFaceGroup(g.id, e.shiftKey));
    faceListEl.appendChild(el);
  }
}

function toggleFaceGroup(id, shift = false) {
  if (!shift) {
    // Without shift: if already the only selection, deselect; else select only this
    if (selectedIds.size === 1 && selectedIds.has(id)) {
      selectedIds.clear();
    } else {
      selectedIds.clear();
      selectedIds.add(id);
    }
  } else {
    // Shift: toggle
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  }
  rebuildHighlights();
  renderFaceList();
  updateFaceInfo();
  checkReady();
}

function updateFaceInfo() {
  if (selectedIds.size === 0) {
    faceInfoEl.textContent = 'No face selected';
  } else {
    const normals = [...selectedIds].map(id => faceGroups.find(g => g.id === id)?.normal).filter(Boolean);
    const labels  = normals.map(n => n.x ? `${n.x>0?'+':'-'}X` : n.y ? `${n.y>0?'+':'-'}Y` : `${n.z>0?'+':'-'}Z`);
    faceInfoEl.textContent = `Selected: ${[...new Set(labels)].join(', ')} (${selectedIds.size} face${selectedIds.size>1?'s':''})`;
  }
}

// ─── Load STL ─────────────────────────────────────────────────────────────────
function loadSTLIntoViewport(filePath, vp, pickable = false) {
  return new Promise((resolve, reject) => {
    loader.load(toFileUrl(filePath), geometry => {
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      geometry.translate(-center.x, -center.y, -center.z);
      geometry.computeBoundingBox();

      clearScene(vp.scene);

      const mat  = new THREE.MeshPhongMaterial({ color: 0x89b4fa, specular: 0x313244, shininess: 30, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.userData.isMesh   = true;
      mesh.userData.managed  = true;
      vp.scene.add(mesh);
      frameTo(vp.camera, vp.controls, vp.scene);

      if (pickable) {
        inputMesh = mesh;
        faceGroups  = buildFaceGroups(geometry);
        selectedIds = new Set();
        highlightMeshes = {};
        renderFaceList();
        updateFaceInfo();
        checkReady();
      }
      resolve(mesh);
    }, undefined, reject);
  });
}

// ─── Raycaster picking ────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

function setupPicking(vp) {
  vp.renderer.domElement.addEventListener('click', e => {
    if (!inputMesh) return;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, vp.camera);
    const hits = raycaster.intersectObject(inputMesh, false);
    if (!hits.length) return;

    const triIndex = hits[0].faceIndex; // one triangle index
    // Find which face group owns this triangle
    const group = faceGroups.find(g => g.triIndices.includes(triIndex));
    if (!group) return;

    toggleFaceGroup(group.id, e.shiftKey);
  });
}

setupPicking(vpInput);

// ─── Buttons ──────────────────────────────────────────────────────────────────
btnStl.addEventListener('click', async () => {
  try {
    const p = await ipcRenderer.invoke('open-stl');
    if (!p) return;
    stlPath = p;
    stlPathEl.textContent = p.split(/[\\/]/).pop();
    setStatus('Loading STL...');
    await loadSTLIntoViewport(p, vpInput, true);
    setStatus(`STL loaded — ${faceGroups.length} flat faces detected. Click to select.`, '#a6e3a1');
  } catch (err) { setStatus('Error loading STL: ' + err.message, '#f38ba8'); }
});

btnPng.addEventListener('click', async () => {
  try {
    const p = await ipcRenderer.invoke('open-png');
    if (!p) return;
    pngPath = p;
    pngPathEl.textContent = p.split(/[\\/]/).pop();
    checkReady();
    setStatus('Texture loaded: ' + pngPathEl.textContent, '#a6e3a1');
  } catch (err) { setStatus('Error: ' + err.message, '#f38ba8'); }
});

btnBrowse.addEventListener('click', async () => {
  try {
    const p = await ipcRenderer.invoke('save-stl', outNameEl.value || 'output.stl');
    if (p) outNameEl.value = p;
  } catch (err) { setStatus('Error: ' + err.message, '#f38ba8'); }
});

btnClear.addEventListener('click', () => {
  selectedIds.clear();
  rebuildHighlights();
  renderFaceList();
  updateFaceInfo();
  checkReady();
});

btnProcess.addEventListener('click', async () => {
  if (!stlPath || !pngPath || selectedIds.size === 0) {
    setStatus('Load STL, load texture, and select at least one face.', '#fab387');
    return;
  }
  const outputPath = (outNameEl.value || '').trim();
  if (!outputPath) { setStatus('Enter an output filename.', '#fab387'); return; }

  btnProcess.disabled = true;
  setStatus('Processing...', '#fab387');

  // Collect selected face group data (normal + triangle indices)
  const selectedGroups = faceGroups
    .filter(g => selectedIds.has(g.id))
    .map(g => ({ normal: g.normal, triIndices: g.triIndices }));

  try {
    const result = await ipcRenderer.invoke('run-carve', {
      stlPath,
      pngPath,
      outputPath,
      selectedGroups,
      textureParams: getTextureParams(),
    });
    if (!result.ok) { setStatus('Error: ' + result.error, '#f38ba8'); return; }
    await loadSTLIntoViewport(outputPath, vpOutput, false);
    setStatus('✓ Saved: ' + outputPath, '#a6e3a1');
  } catch (err) {
    setStatus('Processing failed: ' + err.message, '#f38ba8');
  } finally {
    checkReady();
  }
});
