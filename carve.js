'use strict';

const fs    = require('fs');
const sharp = require('sharp');

// ─── STL parser ───────────────────────────────────────────────────────────────
function isBinarySTL(buf) {
  if (buf.length < 84) return false;
  const n = buf.readUInt32LE(80);
  return buf.length === 84 + n * 50;
}
function parseSTL(buf) {
  return isBinarySTL(buf) ? parseBinarySTL(buf) : parseASCIISTL(buf.toString('utf8'));
}
function parseBinarySTL(buf) {
  const n = buf.readUInt32LE(80);
  const v = new Float32Array(n * 9);
  let off = 84;
  for (let i = 0; i < n; i++) {
    off += 12;
    for (let k = 0; k < 9; k++, off += 4) v[i * 9 + k] = buf.readFloatLE(off);
    off += 2;
  }
  return v;
}
function parseASCIISTL(text) {
  const v = [], re = /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
  let m;
  while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
  return new Float32Array(v);
}
function bbox(p) {
  let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
  for (let i=0;i<p.length;i+=3) {
    if(p[i]<x0)x0=p[i]; if(p[i]>x1)x1=p[i];
    if(p[i+1]<y0)y0=p[i+1]; if(p[i+1]>y1)y1=p[i+1];
    if(p[i+2]<z0)z0=p[i+2]; if(p[i+2]>z1)z1=p[i+2];
  }
  return [x0,y0,z0,x1,y1,z1];
}

// ─── Voxelization ─────────────────────────────────────────────────────────────
function voxelizeShell(positions, GX, GY, GZ, x0,y0,z0, x1,y1,z1) {
  const W=x1-x0, D=y1-y0, H=z1-z0;
  const cx=W/GX, cy=D/GY, cz=H/GZ;
  const grid = new Uint8Array(GX*GY*GZ);
  function idx(ix,iy,iz){ return iz*GY*GX+iy*GX+ix; }
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  function w2v(wx,wy,wz){
    return [clamp(Math.floor((wx-x0)/cx),0,GX-1), clamp(Math.floor((wy-y0)/cy),0,GY-1), clamp(Math.floor((wz-z0)/cz),0,GZ-1)];
  }
  const n = positions.length/9;
  for (let i=0;i<n;i++) {
    const b=i*9;
    const ax=positions[b],ay=positions[b+1],az=positions[b+2];
    const bx=positions[b+3],by=positions[b+4],bz=positions[b+5];
    const cx2=positions[b+6],cy2=positions[b+7],cz2=positions[b+8];
    const lAB=Math.max(Math.abs(bx-ax)/cx,Math.abs(by-ay)/cy,Math.abs(bz-az)/cz);
    const lAC=Math.max(Math.abs(cx2-ax)/cx,Math.abs(cy2-ay)/cy,Math.abs(cz2-az)/cz);
    const steps=Math.ceil(Math.max(lAB,lAC)*2)+1;
    for (let si=0;si<=steps;si++) {
      const u=si/steps;
      for (let sj=0;sj<=steps-si;sj++) {
        const v=sj/steps, w=1-u-v;
        if(w<0) continue;
        const [ix,iy,iz]=w2v(ax*w+bx*u+cx2*v, ay*w+by*u+cy2*v, az*w+bz*u+cz2*v);
        grid[idx(ix,iy,iz)]=1;
      }
    }
  }
  return {grid,idx};
}

function floodFillExterior(grid, GX, GY, GZ) {
  const stack=[];
  function tryPush(ix,iy,iz){
    if(ix<0||iy<0||iz<0||ix>=GX||iy>=GY||iz>=GZ) return;
    const i=iz*GY*GX+iy*GX+ix;
    if(grid[i]===0){grid[i]=2;stack.push(ix,iy,iz);}
  }
  for(let iy=0;iy<GY;iy++) for(let ix=0;ix<GX;ix++){tryPush(ix,iy,0);tryPush(ix,iy,GZ-1);}
  for(let iz=0;iz<GZ;iz++) for(let ix=0;ix<GX;ix++){tryPush(ix,0,iz);tryPush(ix,GY-1,iz);}
  for(let iz=0;iz<GZ;iz++) for(let iy=0;iy<GY;iy++){tryPush(0,iy,iz);tryPush(GX-1,iy,iz);}
  const dx=[1,-1,0,0,0,0],dy=[0,0,1,-1,0,0],dz=[0,0,0,0,1,-1];
  while(stack.length){
    const iz=stack.pop(),iy=stack.pop(),ix=stack.pop();
    for(let d=0;d<6;d++) tryPush(ix+dx[d],iy+dy[d],iz+dz[d]);
  }
}

// ─── STL writer ───────────────────────────────────────────────────────────────
function writeBinarySTL(tris) {
  const hdr=Buffer.alloc(80,0), cnt=Buffer.alloc(4);
  cnt.writeUInt32LE(tris.length,0);
  const body=Buffer.alloc(tris.length*50);
  const dv=new DataView(body.buffer,body.byteOffset,body.byteLength);
  let off=0;
  const wf=v=>{dv.setFloat32(off,v,true);off+=4;};
  for(const [nx,ny,nz,ax,ay,az,bx,by,bz,cx,cy,cz] of tris){
    wf(nx);wf(ny);wf(nz);wf(ax);wf(ay);wf(az);wf(bx);wf(by);wf(bz);wf(cx);wf(cy);wf(cz);
    dv.setUint16(off,0,true);off+=2;
  }
  return Buffer.concat([hdr,cnt,body]);
}
function pushQuad(tris,nx,ny,nz,ax,ay,az,bx,by,bz,cx,cy,cz,dx,dy,dz){
  tris.push([nx,ny,nz,ax,ay,az,bx,by,bz,cx,cy,cz]);
  tris.push([nx,ny,nz,ax,ay,az,cx,cy,cz,dx,dy,dz]);
}

// ─── PNG tiling with transform ────────────────────────────────────────────────
/**
 * Build a 2D black mask (Uint8Array, row-major, GU×GV) by tiling the PNG
 * with scale, rotation (degrees), offsetX/Y (0–1 fractions of tile size).
 */
async function buildTiledMask(pngPath, GU, GV, textureParams) {
  const { scale, rotation, offsetX, offsetY } = textureParams;
  const meta = await sharp(pngPath).metadata();
  const { data: px } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const IW = meta.width, IH = meta.height;

  const mask = new Uint8Array(GU * GV);
  const rad  = rotation * Math.PI / 180;
  const cosA = Math.cos(rad), sinA = Math.sin(rad);

  // Effective tile size in grid cells (scale=1 → tile fills GU×GV once)
  const tileW = GU * scale;
  const tileH = GV * scale;

  for (let gv = 0; gv < GV; gv++) {
    for (let gu = 0; gu < GU; gu++) {
      // Normalised coords [0,1]
      const u = gu / GU - 0.5;
      const v = gv / GV - 0.5;

      // Apply rotation
      const ru = cosA * u - sinA * v;
      const rv = sinA * u + cosA * v;

      // Back to [0,1] then apply offset + tile
      const su = (((ru + 0.5) / scale + offsetX) % 1 + 1) % 1;
      const sv = (((rv + 0.5) / scale + offsetY) % 1 + 1) % 1;

      const ipx = Math.min(IW - 1, Math.floor(su * IW));
      const ipy = Math.min(IH - 1, Math.floor(sv * IH));
      mask[gv * GU + gu] = px[ipy * IW + ipx] < 128 ? 1 : 0;
    }
  }
  return mask;
}

// ─── Main export ──────────────────────────────────────────────────────────────
/**
 * @param {string} stlPath
 * @param {string} pngPath
 * @param {string} outputPath
 * @param {Array<{normal:{x,y,z}, triIndices:number[]}>} selectedGroups
 * @param {{scale,rotation,offsetX,offsetY}} textureParams
 */
async function run(stlPath, pngPath, outputPath, selectedGroups, textureParams) {
  const stlBuf    = fs.readFileSync(stlPath);
  const positions = parseSTL(stlBuf);
  const [x0,y0,z0,x1,y1,z1] = bbox(positions);
  const W=x1-x0, D=y1-y0, H=z1-z0;

  // Determine carve axis from first selected group's normal
  // (all selected faces should share the same entry direction;
  //  if multiple normals, we carve along the most common one)
  const normalCounts = new Map();
  for (const g of selectedGroups) {
    const key = `${g.normal.x},${g.normal.y},${g.normal.z}`;
    normalCounts.set(key, (normalCounts.get(key) || 0) + g.triIndices.length);
  }
  let bestKey = null, bestCount = 0;
  for (const [k, c] of normalCounts) { if (c > bestCount) { bestCount = c; bestKey = k; } }
  const [nx, ny, nz] = bestKey.split(',').map(Number);
  const ax2 = Math.abs(nx), ay2 = Math.abs(ny), az2 = Math.abs(nz);

  let uAxis, vAxis, dAxis;
  if (ax2 >= ay2 && ax2 >= az2)      { uAxis=1; vAxis=2; dAxis=0; }
  else if (ay2 >= ax2 && ay2 >= az2) { uAxis=0; vAxis=2; dAxis=1; }
  else                               { uAxis=0; vAxis=1; dAxis=2; }

  const worldDims = [W, D, H];
  const GRID_UV = 256;
  const GU = GRID_UV, GV = GRID_UV;
  const GD = Math.max(16, Math.round(GRID_UV * worldDims[dAxis] / Math.max(worldDims[uAxis], worldDims[vAxis])));

  const GArr = [0,0,0];
  GArr[uAxis]=GU; GArr[vAxis]=GV; GArr[dAxis]=GD;
  const [GX,GY,GZ] = GArr;

  // ── Build the face-bounded 2D mask ────────────────────────────────────────
  // 1. Find which GU×GV cells are covered by the selected face triangles
  const worldMins = [x0,y0,z0];
  const worldSizes = [W,D,H];
  const cellU = worldSizes[uAxis] / GU;
  const cellV = worldSizes[vAxis] / GV;

  const faceMask = new Uint8Array(GU * GV); // 1 = covered by selected faces
  const allTriSet = new Set();
  for (const g of selectedGroups) g.triIndices.forEach(i => allTriSet.add(i));

  for (const ti of allTriSet) {
    const b = ti * 9;
    const verts = [
      [positions[b],   positions[b+1], positions[b+2]],
      [positions[b+3], positions[b+4], positions[b+5]],
      [positions[b+6], positions[b+7], positions[b+8]],
    ];
    // Bounding box of this triangle in UV space
    let uMin=Infinity,uMax=-Infinity,vMin=Infinity,vMax=-Infinity;
    for (const v of verts) {
      const u = (v[uAxis] - worldMins[uAxis]) / worldSizes[uAxis] * GU;
      const vv = (v[vAxis] - worldMins[vAxis]) / worldSizes[vAxis] * GV;
      if(u<uMin)uMin=u; if(u>uMax)uMax=u;
      if(vv<vMin)vMin=vv; if(vv>vMax)vMax=vv;
    }
    const gu0=Math.max(0,Math.floor(uMin)), gu1=Math.min(GU-1,Math.ceil(uMax));
    const gv0=Math.max(0,Math.floor(vMin)), gv1=Math.min(GV-1,Math.ceil(vMax));
    for (let gv=gv0;gv<=gv1;gv++) for (let gu=gu0;gu<=gu1;gu++) faceMask[gv*GU+gu]=1;
  }

  // 2. Build tiled PNG mask over the whole grid
  const tiledMask = await buildTiledMask(pngPath, GU, GV, textureParams);

  // 3. Combined: carve only where face is selected AND texture is black
  const blackMask = new Uint8Array(GU * GV);
  for (let i=0; i<GU*GV; i++) blackMask[i] = (faceMask[i] && tiledMask[i]) ? 1 : 0;

  // ── Voxelize + flood fill ─────────────────────────────────────────────────
  const { grid, idx } = voxelizeShell(positions, GX, GY, GZ, x0,y0,z0, x1,y1,z1);
  floodFillExterior(grid, GX, GY, GZ);

  // Apply carve mask
  function getGCoord(gu, gv, gd) {
    const c=[0,0,0]; c[uAxis]=gu; c[vAxis]=gv; c[dAxis]=gd; return c;
  }
  for (let gv=0;gv<GV;gv++) {
    for (let gu=0;gu<GU;gu++) {
      if (!blackMask[gv*GU+gu]) continue;
      for (let gd=0;gd<GD;gd++) {
        const [gx,gy,gz]=getGCoord(gu,gv,gd);
        grid[idx(gx,gy,gz)]=2;
      }
    }
  }

  // ── Surface net ───────────────────────────────────────────────────────────
  const tris=[];
  const cW=W/GX, cD=D/GY, cH=H/GZ;
  function solid(ix,iy,iz){
    if(ix<0||iy<0||iz<0||ix>=GX||iy>=GY||iz>=GZ) return false;
    return grid[idx(ix,iy,iz)]<2;
  }
  for (let iz=0;iz<GZ;iz++) for (let iy=0;iy<GY;iy++) for (let ix=0;ix<GX;ix++) {
    if(!solid(ix,iy,iz)) continue;
    const ax_=x0+ix*cW,bx_=ax_+cW;
    const ay_=y0+iy*cD,by_=ay_+cD;
    const az_=z0+iz*cH,bz_=az_+cH;
    if(!solid(ix+1,iy,iz)) pushQuad(tris, 1,0,0, bx_,ay_,az_, bx_,by_,az_, bx_,by_,bz_, bx_,ay_,bz_);
    if(!solid(ix-1,iy,iz)) pushQuad(tris,-1,0,0, ax_,by_,az_, ax_,ay_,az_, ax_,ay_,bz_, ax_,by_,bz_);
    if(!solid(ix,iy+1,iz)) pushQuad(tris, 0,1,0, bx_,by_,az_, ax_,by_,az_, ax_,by_,bz_, bx_,by_,bz_);
    if(!solid(ix,iy-1,iz)) pushQuad(tris, 0,-1,0,ax_,ay_,az_, bx_,ay_,az_, bx_,ay_,bz_, ax_,ay_,bz_);
    if(!solid(ix,iy,iz+1)) pushQuad(tris, 0,0,1, ax_,ay_,bz_, bx_,ay_,bz_, bx_,by_,bz_, ax_,by_,bz_);
    if(!solid(ix,iy,iz-1)) pushQuad(tris, 0,0,-1,bx_,ay_,az_, ax_,ay_,az_, ax_,by_,az_, bx_,by_,az_);
  }

  fs.writeFileSync(outputPath, writeBinarySTL(tris));
}

module.exports = { run };
