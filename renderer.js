import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const { ipcRenderer } = window.require('electron');

let stlPath = null;
let pngPath = null;
let selectedFaceNormal = null;

const btnStl     = document.getElementById('btn-stl');
const btnPng     = document.getElementById('btn-png');
const btnBrowse  = document.getElementById('btn-browse-out');
const btnProcess = document.getElementById('btn-process');
const stlPathEl  = document.getElementById('stl-path');
const pngPathEl  = document.getElementById('png-path');
const outNameEl  = document.getElementById('out-name');
const statusEl   = document.getElementById('status');
const faceInfoEl = document.getElementById('face-info');

function setStatus(msg, color = '#a6adc8') {
  statusEl.style.color = color;
  statusEl.textContent = msg;
}

function checkReady() {
  btnProcess.disabled = !(stlPath && pngPath && selectedFaceNormal);
}

function toFileUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return encodeURI(
    normalized.startsWith('/')
      ? `file://${normalized}`
      : `file:///${normalized}`
  );
}

function clearSceneMeshes(scene) {
  const toRemove = scene.children.filter(c => c.userData.isMesh || c.userData.isHighlight);
  for (const obj of toRemove) {
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  }
}

function frameCameraToObject(camera, controls, object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 2.2;

  camera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
  camera.near = Math.max(0.01, maxDim / 1000);
  camera.far = Math.max(1000, maxDim * 20);
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

function makeViewport(containerId) {
  const container = document.getElementById(containerId);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11111b);

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.01,
    10000
  );
  camera.position.set(3, 3, 3);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir1 = new THREE.DirectionalLight(0xffffff, 1.1);
  dir1.position.set(3, 4, 5);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0x89b4fa, 0.45);
  dir2.position.set(-4, -2, -3);
  scene.add(dir2);

  const grid = new THREE.GridHelper(100, 50, 0x313244, 0x313244);
  grid.userData.helper = true;
  scene.add(grid);

  new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }).observe(container);

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  return { container, renderer, scene, camera, controls };
}

const vpInput  = makeViewport('vp-input');
const vpOutput = makeViewport('vp-output');

const loader    = new STLLoader();
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

let inputMesh    = null;
let faceHighlight = null;

function loadSTLIntoViewport(filePath, vp, pickable = false) {
  return new Promise((resolve, reject) => {
    loader.load(
      toFileUrl(filePath),
      geometry => {
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();

        const center = new THREE.Vector3();
        geometry.boundingBox.getCenter(center);
        geometry.translate(-center.x, -center.y, -center.z);
        geometry.computeBoundingBox();

        clearSceneMeshes(vp.scene);

        const material = new THREE.MeshPhongMaterial({
          color: 0x89b4fa,
          specular: 0x313244,
          shininess: 30,
          side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.isMesh = true;
        vp.scene.add(mesh);
        frameCameraToObject(vp.camera, vp.controls, mesh);

        if (pickable) {
          inputMesh = mesh;
          if (faceHighlight) {
            vp.scene.remove(faceHighlight);
            if (faceHighlight.geometry) faceHighlight.geometry.dispose();
            if (faceHighlight.material) faceHighlight.material.dispose();
            faceHighlight = null;
          }
        }

        resolve(mesh);
      },
      undefined,
      reject
    );
  });
}

function highlightFace(hit, vp) {
  if (faceHighlight) {
    vp.scene.remove(faceHighlight);
    if (faceHighlight.geometry) faceHighlight.geometry.dispose();
    if (faceHighlight.material) faceHighlight.material.dispose();
  }

  const pos = hit.object.geometry.attributes.position;
  const i   = hit.faceIndex * 3;
  const a   = new THREE.Vector3().fromBufferAttribute(pos, i);
  const b   = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
  const c   = new THREE.Vector3().fromBufferAttribute(pos, i + 2);

  const offsetLen = 0.0015 *
    hit.object.geometry.boundingBox.getSize(new THREE.Vector3()).length();
  const offset = hit.face.normal.clone().normalize().multiplyScalar(offsetLen);
  a.add(offset); b.add(offset); c.add(offset);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], 3
  ));

  faceHighlight = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: 0xf38ba8, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
  );
  faceHighlight.userData.isHighlight = true;
  vp.scene.add(faceHighlight);
}

function setupPicking(vp) {
  vp.renderer.domElement.addEventListener('click', e => {
    if (!inputMesh) return;

    const rect = vp.renderer.domElement.getBoundingClientRect();
    mouse.x =  ((e.clientX - rect.left)  / rect.width)  * 2 - 1;
    mouse.y = -((e.clientY - rect.top)   / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, vp.camera);
    const hits = raycaster.intersectObject(inputMesh, false);
    if (!hits.length) return;

    const hit = hits[0];
    const worldNormal = hit.face.normal.clone()
      .transformDirection(inputMesh.matrixWorld)
      .normalize();

    const ax = Math.abs(worldNormal.x);
    const ay = Math.abs(worldNormal.y);
    const az = Math.abs(worldNormal.z);

    let snapped;
    if (ax >= ay && ax >= az)      snapped = new THREE.Vector3(Math.sign(worldNormal.x) || 1, 0, 0);
    else if (ay >= ax && ay >= az) snapped = new THREE.Vector3(0, Math.sign(worldNormal.y) || 1, 0);
    else                           snapped = new THREE.Vector3(0, 0, Math.sign(worldNormal.z) || 1);

    selectedFaceNormal = { x: snapped.x, y: snapped.y, z: snapped.z };

    const axisName =
      snapped.x ? `X (${snapped.x > 0 ? '+' : '-'})` :
      snapped.y ? `Y (${snapped.y > 0 ? '+' : '-'})` :
                  `Z (${snapped.z > 0 ? '+' : '-'})`;

    faceInfoEl.textContent = `Carve axis: ${axisName}`;
    highlightFace(hit, vp);
    checkReady();
    setStatus(`Face selected — carve direction: ${axisName}.`, '#f5c2e7');
  });
}

setupPicking(vpInput);

// ─── Button handlers ──────────────────────────────────────────────────────────

btnStl.addEventListener('click', async () => {
  try {
    const p = await ipcRenderer.invoke('open-stl');
    if (!p) return;
    stlPath = p;
    stlPathEl.textContent = p.split(/[\\/]/).pop();
    selectedFaceNormal = null;
    faceInfoEl.textContent = 'No face selected';
    checkReady();
    setStatus('Loading STL...');
    await loadSTLIntoViewport(p, vpInput, true);
    setStatus('STL loaded. Click a face to choose the carve direction.', '#a6e3a1');
  } catch (e) {
    setStatus('Error loading STL: ' + e.message, '#f38ba8');
  }
});

btnPng.addEventListener('click', async () => {
  try {
    const p = await ipcRenderer.invoke('open-png');
    if (!p) return;
    pngPath = p;
    pngPathEl.textContent = p.split(/[\\/]/).pop();
    checkReady();
    setStatus('Texture loaded: ' + pngPathEl.textContent, '#a6e3a1');
  } catch (e) {
    setStatus('Error loading texture: ' + e.message, '#f38ba8');
  }
});

btnBrowse.addEventListener('click', async () => {
  try {
    const p = await ipcRenderer.invoke('save-stl', outNameEl.value || 'output.stl');
    if (p) outNameEl.value = p;
  } catch (e) {
    setStatus('Error choosing output path: ' + e.message, '#f38ba8');
  }
});

btnProcess.addEventListener('click', async () => {
  if (!stlPath || !pngPath || !selectedFaceNormal) {
    setStatus('Load STL, load texture, and select a face first.', '#fab387');
    return;
  }
  const outputPath = (outNameEl.value || '').trim();
  if (!outputPath) { setStatus('Please enter an output filename.', '#fab387'); return; }

  btnProcess.disabled = true;
  setStatus('Processing... this may take a moment.', '#fab387');

  try {
    const result = await ipcRenderer.invoke('run-carve', {
      stlPath, pngPath, outputPath, faceNormal: selectedFaceNormal,
    });

    if (!result.ok) {
      setStatus('Error: ' + result.error, '#f38ba8');
      return;
    }

    await loadSTLIntoViewport(outputPath, vpOutput, false);
    setStatus('✓ Saved and previewed: ' + outputPath, '#a6e3a1');
  } catch (e) {
    setStatus('Processing failed: ' + e.message, '#f38ba8');
  } finally {
    checkReady();
  }
});
