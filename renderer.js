import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const { ipcRenderer } = window.require('electron');
const path = window.require('path');

// ─── State ────────────────────────────────────────────────────────────────────
let stlPath   = null;
let pngPath   = null;
let lastProcessedStlPath = null;

let faceGroups      = [];
let selectedIds     = new Set();
let inputMesh       = null;
let highlightMeshes = {};

// UI
const btnStl     = document.getElementById('btn-stl');
const btnPng     = document.getElementById('btn-png');
const btnBrowse  = document.getElementById('btn-browse-out');
const btnProcess = document.getElementById('btn-process');
const btnClear   = document.getElementById('btn-clear-sel');
const chkPreview = document.getElementById('chk-preview');
const stlPathEl  = document.getElementById('stl-path');
const pngPathEl  = document.getElementById('png-path');
const outNameEl  = document.getElementById('out-name');
const statusEl   = document.getElementById('status');
const faceInfoEl = document.getElementById('face-info');
const faceListEl = document.getElementById('face-list');

// Mode + Sliders
const selMode   = document.getElementById('sel-mode');
const slSmooth  = document.getElementById('sl-smooth');
const valSmooth = document.getElementById('val-smooth');
const smoothGroup = document.getElementById('smooth-group');
const slScale   = document.getElementById('sl-scale');
const slRot     = document.getElementById('sl-rot');
const slOx      = document.getElementById('sl-ox');
const slOy      = document.getElementById('sl-oy');
const valScale  = document.getElementById('val-scale');
const valRot    = document.getElementById('val-rot');
const valOx     = document.getElementById('val-ox');
const valOy     = document.getElementById('val-oy');

// Show/hide smooth slider based on mode
function updateModeUI() {
  smoothGroup.style.display = selMode.value === 'vector' ? 'flex' : 'none';
}
updateModeUI();

selMode.addEventListener('change', () => { updateModeUI(); onParamChange(); });
slSmooth.addEventListener('input', () => { valSmooth.textContent = slSmooth.value; onParamChange(); });
slScale.addEventListener('input', () => { valScale.textContent = slScale.value + '%'; onParamChange(); });
slRot.addEventListener('input',   () => { valRot.textContent   = slRot.value + '\u00b0'; onParamChange(); });
slOx.addEventListener('input',    () => { valOx.textContent    = slOx.value + '%'; onParamChange(); });
slOy.addEventListener('input',    () => { valOy.textContent    = slOy.value + '%'; onParamChange(); });
chkPreview.addEventListener('change', () => rebuildHighlights());

function onParamChange() {
  if (chkPreview.checked) rebuildHighlights();
}

function getTextureParams() {
  return {
    mode:     selMode.value,
    smooth:   parseInt(slSmooth.value, 10),
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
  const renderer  = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene  = new THREE.Scene();
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
  rem.forEach(o => {
    scene.remove(o);
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
    else o.material?.dispose();
  });
}

function frameTo(camera, controls, scene) {
  const box = new THREE.Box3();
  scene.children.filter(c => c.userData.isMesh).forEach(c => box.expandByObject(c));
  if (box.isEmpty()) return;
  const size   = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist   = maxDim * 2.2;
  camera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
  camera.near = Math.max(0.01, maxDim / 1000);
  camera.far  = Math.max(1000, maxDim * 20);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function saveCameraState(vp) {
  return {
    position: vp.camera.position.clone(),
    target:   vp.controls.target.clone(),
    near:     vp.camera.near,
    far:      vp.camera.far,
  };
}
function restoreCameraState(vp, state) {
  vp.camera.position.copy(state.position);
  vp.camera.near = state.near;
  vp.camera.far  = state.far;
  vp.camera.updateProjectionMatrix();
  vp.controls.target.copy(state.target);
  vp.controls.update();
}

// ─── Face group detection ─────────────────────────────────────────────────────
const NORMAL_SNAP = 0.2;
const PLANE_QUANT = 4;

function buildFaceGroups(geometry) {
  const pos    = geometry.attributes.position;
  const numTris = pos.count / 3;
  const groups  = new Map();

  for (let i = 0; i < numTris; i++) {
    const ai = i * 3, bi = ai + 1, ci = ai + 2;
    const a = new THREE.Vector3().fromBufferAttribute(pos, ai);
    const b = new THREE.Vector3().fromBufferAttribute(pos, bi);
    const c = new THREE.Vector3().fromBufferAttribute(pos, ci);

    const ab  = new THREE.Vector3().subVectors(b, a);
    const ac  = new THREE.Vector3().subVectors(c, a);
    const raw = new THREE.Vector3().crossVectors(ab, ac).normalize();

    const ax = Math.abs(raw.x), ay = Math.abs(raw.y), az = Math.abs(raw.z);
    let snapped;
    if (ax >= ay && ax >= az)      snapped = new THREE.Vector3(Math.sign(raw.x), 0, 0);
    else if (ay >= ax && ay >= az) snapped = new THREE.Vector3(0, Math.sign(raw.y), 0);
    else                           snapped = new THREE.Vector3(0, 0, Math.sign(raw.z));

    if (raw.dot(snapped) < NORMAL_SNAP) continue;

    const centroid = new THREE.Vector3().addVectors(a, b).add(c).divideScalar(3);
    const d    = centroid.dot(snapped);
    const dKey = d.toFixed(PLANE_QUANT);
    const key  = `${snapped.x},${snapped.y},${snapped.z}|${dKey}`;

    if (!groups.has(key)) groups.set(key, { id: key, normal: { x: snapped.x, y: snapped.y, z: snapped.z }, d, triIndices: [] });
    groups.get(key).triIndices.push(i);
  }
  return [...groups.values()].filter(g => g.triIndices.length >= 2);
}

// ─── Preview texture rendering ────────────────────────────────────────────────
const PREVIEW_SZ = 512;

function buildPreviewTexture(patternImgEl, params) {
  const { scale, rotation, offsetX, offsetY } = params;
  const cv  = document.createElement('canvas');
  cv.width  = PREVIEW_SZ;
  cv.height = PREVIEW_SZ;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = 'rgba(243,139,168,0.18)';
  ctx.fillRect(0, 0, PREVIEW_SZ, PREVIEW_SZ);

  const tileW = PREVIEW_SZ * scale;
  const tileH = PREVIEW_SZ * scale;

  ctx.save();
  ctx.translate(PREVIEW_SZ / 2 + offsetX * tileW, PREVIEW_SZ / 2 + offsetY * tileH);
  ctx.rotate(rotation * Math.PI / 180);
  const n = Math.ceil(Math.SQRT2 / scale) + 1;
  for (let row = -n; row <= n; row++) {
    for (let col = -n; col <= n; col++) {
      ctx.drawImage(patternImgEl, (col - 0.5) * tileW, (row - 0.5) * tileH, tileW, tileH);
    }
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

let _previewImg = null;
let _previewImgSrc = null;
async function getPreviewImg() {
  const src = pngPath ? toFileUrl(pngPath) : null;
  if (!src) return null;
  if (_previewImgSrc === src && _previewImg) return _previewImg;
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => { _previewImg = img; _previewImgSrc = src; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ─── Highlight overlays ───────────────────────────────────────────────────────
const MAT_SELECTED = new THREE.MeshBasicMaterial({
  color: 0xf38ba8, transparent: true, opacity: 0.50,
  side: THREE.DoubleSide, depthTest: false
});

function buildGroupOverlayGeo(group, posAttr, offsetLen) {
  const verts = [], uvs = [];
  const nrm    = new THREE.Vector3(group.normal.x, group.normal.y, group.normal.z);
  const offset = nrm.clone().multiplyScalar(offsetLen);

  const up  = Math.abs(nrm.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const uDir = new THREE.Vector3().crossVectors(nrm, up).normalize();
  const vDir = new THREE.Vector3().crossVectors(uDir, nrm).normalize();

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const ti of group.triIndices) {
    for (let k = 0; k < 3; k++) {
      const p = new THREE.Vector3().fromBufferAttribute(posAttr, ti * 3 + k);
      const u = p.dot(uDir), v = p.dot(vDir);
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
  }
  const uRange = (uMax - uMin) || 1, vRange = (vMax - vMin) || 1;

  for (const ti of group.triIndices) {
    for (let k = 0; k < 3; k++) {
      const p = new THREE.Vector3().fromBufferAttribute(posAttr, ti * 3 + k).add(offset);
      verts.push(p.x, p.y, p.z);
      uvs.push((p.dot(uDir) - uMin) / uRange, (p.dot(vDir) - vMin) / vRange);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,   2));
  return geo;
}

async function rebuildHighlights() {
  if (!inputMesh) return;
  const pos      = inputMesh.geometry.attributes.position;
  const bbLen    = inputMesh.geometry.boundingBox
    ? inputMesh.geometry.boundingBox.getSize(new THREE.Vector3()).length()
    : 1;
  const offsetLen = 0.002 * bbLen;

  Object.values(highlightMeshes).forEach(m => {
    vpInput.scene.remove(m);
    m.geometry.dispose();
    if (m.material !== MAT_SELECTED) m.material.dispose();
  });
  highlightMeshes = {};

  const usePreview = chkPreview.checked && pngPath;
  let previewImg = null;
  if (usePreview) previewImg = await getPreviewImg();

  for (const g of faceGroups) {
    if (!selectedIds.has(g.id)) continue;
    const geo = buildGroupOverlayGeo(g, pos, offsetLen);

    let mat;
    if (usePreview && previewImg) {
      const tex = buildPreviewTexture(previewImg, getTextureParams());
      mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthTest: false,
      });
    } else {
      mat = MAT_SELECTED;
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.managed = true;
    mesh.renderOrder = 1;
    vpInput.scene.add(mesh);
    highlightMeshes[g.id] = mesh;
  }
}

// ─── Face list sidebar ────────────────────────────────────────────────────────
const axisLabel = n => n.x ? `${n.x > 0 ? '+' : '-'}X` : n.y ? `${n.y > 0 ? '+' : '-'}Y` : `${n.z > 0 ? '+' : '-'}Z`;

function renderFaceList() {
  faceListEl.innerHTML = '';
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
    if (selectedIds.size === 1 && selectedIds.has(id)) selectedIds.clear();
    else { selectedIds.clear(); selectedIds.add(id); }
  } else {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
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
    const labels = [...selectedIds]
      .map(id => faceGroups.find(g => g.id === id)?.normal)
      .filter(Boolean)
      .map(axisLabel);
    faceInfoEl.textContent = `Selected: ${[...new Set(labels)].join(', ')} (${selectedIds.size} face${selectedIds.size > 1 ? 's' : ''})`;
  }
}

// ─── Load STL ─────────────────────────────────────────────────────────────────
function loadSTLIntoViewport(filePath, vp, pickable = false, preserveCamera = false) {
  return new Promise((resolve, reject) => {
    loader.load(toFileUrl(filePath), geometry => {
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      geometry.translate(-center.x, -center.y, -center.z);
      geometry.computeBoundingBox();

      const savedCam = preserveCamera ? saveCameraState(vp) : null;

      clearScene(vp.scene);

      const mat  = new THREE.MeshPhongMaterial({ color: 0x89b4fa, specular: 0x313244, shininess: 30, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.userData.isMesh  = true;
      mesh.userData.managed = true;
      vp.scene.add(mesh);

      if (preserveCamera && savedCam) {
        restoreCameraState(vp, savedCam);
      } else {
        frameTo(vp.camera, vp.controls, vp.scene);
      }

      if (pickable) {
        inputMesh    = mesh;
        faceGroups   = buildFaceGroups(geometry);
        selectedIds  = new Set();
        highlightMeshes = {};
        renderFaceList();
        updateFaceInfo();
        checkReady();
      }
      resolve(mesh);
    }, undefined, reject);
  });
}

// ─── Picking ──────────────────────────────────────────────────────────────────
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
    const group = faceGroups.find(g => g.triIndices.includes(hits[0].faceIndex));
    if (!group) return;
    toggleFaceGroup(group.id, e.shiftKey);
  });
}

setupPicking(vpInput);

// ─── Default paths ────────────────────────────────────────────────────────────
async function tryLoadDefaults() {
  try {
    const defaults = await ipcRenderer.invoke('get-defaults');
    if (defaults.stl) {
      stlPath = defaults.stl;
      stlPathEl.textContent = stlPath.split(/[\\/]/).pop();
      setStatus('Loading default STL...');
      await loadSTLIntoViewport(stlPath, vpInput, true);
      setStatus(`STL loaded — ${faceGroups.length} flat faces detected.`, '#a6e3a1');
    }
    if (defaults.png) {
      pngPath = defaults.png;
      pngPathEl.textContent = pngPath.split(/[\\/]/).pop();
      _previewImgSrc = null;
      checkReady();
    }
  } catch (_) { /* silently skip */ }
}

tryLoadDefaults();

// ─── Button handlers ──────────────────────────────────────────────────────────
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
    _previewImgSrc = null;
    checkReady();
    if (chkPreview.checked) rebuildHighlights();
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

  const persistCam = (lastProcessedStlPath === stlPath);

  btnProcess.disabled = true;
  setStatus('Processing...', '#fab387');

  const selectedGroups = faceGroups
    .filter(g => selectedIds.has(g.id))
    .map(g => ({ normal: g.normal, triIndices: g.triIndices }));

  try {
    const result = await ipcRenderer.invoke('run-carve', {
      stlPath, pngPath, outputPath,
      selectedGroups,
      textureParams: getTextureParams(),
    });
    if (!result.ok) { setStatus('Error: ' + result.error, '#f38ba8'); return; }

    lastProcessedStlPath = stlPath;
    await loadSTLIntoViewport(outputPath, vpOutput, false, persistCam);
    setStatus('\u2713 Saved: ' + outputPath, '#a6e3a1');
  } catch (err) {
    setStatus('Processing failed: ' + err.message, '#f38ba8');
  } finally {
    checkReady();
  }
});
