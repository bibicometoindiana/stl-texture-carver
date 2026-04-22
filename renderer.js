'use strict';

const { ipcRenderer } = require('electron');
const THREE = require('three');
const { STLLoader } = require('three/addons/loaders/STLLoader.js');
const { OrbitControls } = require('three/addons/controls/OrbitControls.js');

// ─── State ────────────────────────────────────────────────────────────────────

let stlPath = null;
let pngPath = null;
let selectedFaceNormal = null;

// ─── UI elements ─────────────────────────────────────────────────────────────

const btnStl      = document.getElementById('btn-stl');
const btnPng      = document.getElementById('btn-png');
const btnBrowse   = document.getElementById('btn-browse-out');
const btnProcess  = document.getElementById('btn-process');
const stlPathEl   = document.getElementById('stl-path');
const pngPathEl   = document.getElementById('png-path');
const outNameEl   = document.getElementById('out-name');
const statusEl    = document.getElementById('status');
const faceInfoEl  = document.getElementById('face-info');

function setStatus(msg, color='#a6adc8') {
  statusEl.style.color = color;
  statusEl.textContent = msg;
}

function checkReady() {
  btnProcess.disabled = !(stlPath && pngPath && selectedFaceNormal);
}

// ─── Three.js viewport factory ───────────────────────────────────────────────

function makeViewport(containerId) {
  const container = document.getElementById(containerId);
  const w = container.clientWidth, h = container.clientHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11111b);

  const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 10000);
  camera.position.set(0, 0, 5);

  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const dir1 = new THREE.DirectionalLight(0xffffff, 1.0);
  dir1.position.set(1, 2, 3);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0x89b4fa, 0.4);
  dir2.position.set(-2, -1, -1);
  scene.add(dir2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const grid = new THREE.GridHelper(100, 50, 0x313244, 0x313244);
  scene.add(grid);

  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth, nh = container.clientHeight;
    renderer.setSize(nw, nh);
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  return { scene, camera, renderer, controls };
}

// ─── Load STL into a viewport ─────────────────────────────────────────────────

const loader = new STLLoader();

let inputMesh    = null;
let faceHighlight = null;

function loadSTLIntoViewport(filePath, vp, pickable = false) {
  return new Promise((resolve, reject) => {
    loader.load('file://' + filePath, (geometry) => {
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      geometry.translate(-center.x, -center.y, -center.z);

      const size = new THREE.Vector3();
      geometry.boundingBox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      vp.camera.position.set(maxDim, maxDim * 0.8, maxDim * 1.5);
      vp.controls.target.set(0, 0, 0);
      vp.controls.update();

      vp.scene.children
        .filter(c => c.userData.isMesh)
        .forEach(c => { vp.scene.remove(c); c.geometry.dispose(); });

      const mat = new THREE.MeshPhongMaterial({
        color: 0x89b4fa,
        specular: 0x313244,
        shininess: 30,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.userData.isMesh = true;
      vp.scene.add(mesh);

      if (pickable) inputMesh = mesh;
      resolve(mesh);
    }, undefined, reject);
  });
}

// ─── Face picking ─────────────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

function setupPicking(vp) {
  const canvas = vp.renderer.domElement;
  canvas.addEventListener('click', (e) => {
    if (!inputMesh) return;
    const rect = canvas.getBoundingClientRect();
    mouse.x =  ((e.clientX - rect.left)  / rect.width)  * 2 - 1;
    mouse.y = -((e.clientY - rect.top)   / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, vp.camera);
    const hits = raycaster.intersectObject(inputMesh, false);
    if (!hits.length) return;

    const hit  = hits[0];
    const face = hit.face;

    const worldNormal = face.normal.clone()
      .transformDirection(inputMesh.matrixWorld)
      .normalize();

    const ax=Math.abs(worldNormal.x), ay=Math.abs(worldNormal.y), az=Math.abs(worldNormal.z);
    let snapped;
    if (ax>=ay && ax>=az)      snapped = new THREE.Vector3(Math.sign(worldNormal.x),0,0);
    else if (ay>=ax && ay>=az) snapped = new THREE.Vector3(0,Math.sign(worldNormal.y),0);
    else                       snapped = new THREE.Vector3(0,0,Math.sign(worldNormal.z));

    selectedFaceNormal = { x: snapped.x, y: snapped.y, z: snapped.z };

    const axName = snapped.x ? `X (${snapped.x>0?'+':'-'})` :
                   snapped.y ? `Y (${snapped.y>0?'+':'-'})` :
                               `Z (${snapped.z>0?'+':'-'})`;
    faceInfoEl.textContent = `Carve axis: ${axName}`;
    highlightFace(hit, vp);
    checkReady();
    setStatus(`Face selected — carve direction: ${axName}. Click Process when ready.`, '#f5c2e7');
  });
}

function highlightFace(hit, vp) {
  if (faceHighlight) { vp.scene.remove(faceHighlight); faceHighlight.geometry.dispose(); }

  const faceGeo = new THREE.BufferGeometry();
  const pos = hit.object.geometry.attributes.position;
  const fi  = hit.faceIndex * 3;

  const vA = new THREE.Vector3().fromBufferAttribute(pos, fi);
  const vB = new THREE.Vector3().fromBufferAttribute(pos, fi + 1);
  const vC = new THREE.Vector3().fromBufferAttribute(pos, fi + 2);

  const offset = hit.face.normal.clone().multiplyScalar(
    0.002 * hit.object.geometry.boundingBox.getSize(new THREE.Vector3()).length()
  );
  vA.add(offset); vB.add(offset); vC.add(offset);

  faceGeo.setAttribute('position', new THREE.Float32BufferAttribute(
    [vA.x,vA.y,vA.z, vB.x,vB.y,vB.z, vC.x,vC.y,vC.z], 3
  ));

  const hlMat = new THREE.MeshBasicMaterial({ color: 0xf38ba8, side: THREE.DoubleSide });
  faceHighlight = new THREE.Mesh(faceGeo, hlMat);
  faceHighlight.userData.isMesh = false;
  vp.scene.add(faceHighlight);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const vpInput  = makeViewport('vp-input');
const vpOutput = makeViewport('vp-output');
setupPicking(vpInput);

// ─── Button handlers ──────────────────────────────────────────────────────────

btnStl.addEventListener('click', async () => {
  const p = await ipcRenderer.invoke('open-stl');
  if (!p) return;
  stlPath = p;
  stlPathEl.textContent = p.split(/[\\/]/).pop();
  setStatus('Loading STL…');
  try {
    await loadSTLIntoViewport(p, vpInput, true);
    setStatus('STL loaded. Click a face to choose the carve direction.');
    selectedFaceNormal = null;
    faceInfoEl.textContent = 'No face selected';
    checkReady();
  } catch(e) {
    setStatus('Error loading STL: ' + e.message, '#f38ba8');
  }
});

btnPng.addEventListener('click', async () => {
  const p = await ipcRenderer.invoke('open-png');
  if (!p) return;
  pngPath = p;
  pngPathEl.textContent = p.split(/[\\/]/).pop();
  setStatus('Texture loaded: ' + pngPathEl.textContent, '#a6e3a1');
  checkReady();
});

btnBrowse.addEventListener('click', async () => {
  const p = await ipcRenderer.invoke('save-stl', outNameEl.value);
  if (p) outNameEl.value = p;
});

btnProcess.addEventListener('click', async () => {
  if (!stlPath || !pngPath || !selectedFaceNormal) return;
  const outputPath = outNameEl.value;
  if (!outputPath) { setStatus('Please enter an output filename.', '#fab387'); return; }

  btnProcess.disabled = true;
  setStatus('Processing… (this may take a moment)', '#fab387');

  const result = await ipcRenderer.invoke('run-carve', {
    stlPath, pngPath, outputPath, faceNormal: selectedFaceNormal,
  });

  if (!result.ok) {
    setStatus('Error: ' + result.error, '#f38ba8');
    btnProcess.disabled = false;
    return;
  }

  setStatus('Done! Loading output preview…', '#a6e3a1');
  try {
    await loadSTLIntoViewport(outputPath, vpOutput, false);
    setStatus(`✓ Saved to ${outputPath}`, '#a6e3a1');
  } catch(e) {
    setStatus('Carve done but could not preview output: ' + e.message, '#fab387');
  }

  btnProcess.disabled = false;
});
