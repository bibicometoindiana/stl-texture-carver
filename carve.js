'use strict';

const fs    = require('fs');
const path  = require('path');
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
  const v = [];
  const re = /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
  let m;
  while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
  return new Float32Array(v);
}

function bbox(p) {
  let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i]   < x0) x0=p[i];   if (p[i]   > x1) x1=p[i];
    if (p[i+1] < y0) y0=p[i+1]; if (p[i+1] > y1) y1=p[i+1];
    if (p[i+2] < z0) z0=p[i+2]; if (p[i+2] > z1) z1=p[i+2];
  }
  return [x0,y0,z0,x1,y1,z1];
}

// ─── Voxel shell rasterization ────────────────────────────────────────────────

function voxelizeShell(positions, GX, GY, GZ, x0,y0,z0, x1,y1,z1) {
  const W=x1-x0, D=y1-y0, H=z1-z0;
  const cx=W/GX, cy=D/GY, cz=H/GZ;
  const grid = new Uint8Array(GX * GY * GZ);

  function idx(ix,iy,iz) { return iz*GY*GX + iy*GX + ix; }
  function clamp(v,lo,hi) { return Math.max(lo, Math.min(hi, v)); }
  function w2v(wx,wy,wz) {
    return [
      clamp(Math.floor((wx-x0)/cx), 0, GX-1),
      clamp(Math.floor((wy-y0)/cy), 0, GY-1),
      clamp(Math.floor((wz-z0)/cz), 0, GZ-1),
    ];
  }

  const numTris = positions.length / 9;
  for (let i = 0; i < numTris; i++) {
    const b = i*9;
    const ax=positions[b],   ay=positions[b+1], az=positions[b+2];
    const bx=positions[b+3], by=positions[b+4], bz=positions[b+5];
    const ccx=positions[b+6],ccy=positions[b+7],ccz=positions[b+8];

    const lenAB = Math.max(Math.abs(bx-ax)/cx, Math.abs(by-ay)/cy, Math.abs(bz-az)/cz);
    const lenAC = Math.max(Math.abs(ccx-ax)/cx, Math.abs(ccy-ay)/cy, Math.abs(ccz-az)/cz);
    const steps = Math.ceil(Math.max(lenAB, lenAC) * 2) + 1;

    for (let si = 0; si <= steps; si++) {
      const u = si / steps;
      for (let sj = 0; sj <= steps - si; sj++) {
        const v = sj / steps;
        const w = 1 - u - v;
        if (w < 0) continue;
        const [ix,iy,iz] = w2v(ax*w+bx*u+ccx*v, ay*w+by*u+ccy*v, az*w+bz*u+ccz*v);
        grid[idx(ix,iy,iz)] = 1;
      }
    }
  }
  return { grid, idx };
}

// ─── Flood fill exterior ──────────────────────────────────────────────────────

function floodFillExterior(grid, GX, GY, GZ) {
  const stack = [];
  function tryPush(ix,iy,iz) {
    if (ix<0||iy<0||iz<0||ix>=GX||iy>=GY||iz>=GZ) return;
    const i = iz*GY*GX+iy*GX+ix;
    if (grid[i]===0) { grid[i]=2; stack.push(ix,iy,iz); }
  }
  for (let iy=0;iy<GY;iy++) for (let ix=0;ix<GX;ix++) { tryPush(ix,iy,0); tryPush(ix,iy,GZ-1); }
  for (let iz=0;iz<GZ;iz++) for (let ix=0;ix<GX;ix++) { tryPush(ix,0,iz); tryPush(ix,GY-1,iz); }
  for (let iz=0;iz<GZ;iz++) for (let iy=0;iy<GY;iy++) { tryPush(0,iy,iz); tryPush(GX-1,iy,iz); }
  const dx=[1,-1,0,0,0,0],dy=[0,0,1,-1,0,0],dz=[0,0,0,0,1,-1];
  while (stack.length) {
    const iz=stack.pop(),iy=stack.pop(),ix=stack.pop();
    for (let d=0;d<6;d++) tryPush(ix+dx[d],iy+dy[d],iz+dz[d]);
  }
}

// ─── STL writer ───────────────────────────────────────────────────────────────

function writeBinarySTL(tris) {
  const hdr=Buffer.alloc(80,0), cnt=Buffer.alloc(4);
  cnt.writeUInt32LE(tris.length,0);
  const body=Buffer.alloc(tris.length*50);
  const dv=new DataView(body.buffer,body.byteOffset,body.byteLength);
  let off=0;
  const wf=(v)=>{ dv.setFloat32(off,v,true); off+=4; };
  for (const [nx,ny,nz,ax,ay,az,bx,by,bz,cx,cy,cz] of tris) {
    wf(nx);wf(ny);wf(nz); wf(ax);wf(ay);wf(az);
    wf(bx);wf(by);wf(bz); wf(cx);wf(cy);wf(cz);
    dv.setUint16(off,0,true); off+=2;
  }
  return Buffer.concat([hdr,cnt,body]);
}

function pushQuad(tris,nx,ny,nz,ax,ay,az,bx,by,bz,cx,cy,cz,dx,dy,dz) {
  tris.push([nx,ny,nz,ax,ay,az,bx,by,bz,cx,cy,cz]);
  tris.push([nx,ny,nz,ax,ay,az,cx,cy,cz,dx,dy,dz]);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {string} stlPath
 * @param {string} pngPath
 * @param {string} outputPath
 * @param {{ x: number, y: number, z: number }} faceNormal
 */
async function run(stlPath, pngPath, outputPath, faceNormal) {
  const stlBuf    = fs.readFileSync(stlPath);
  const positions = parseSTL(stlBuf);
  const [x0,y0,z0,x1,y1,z1] = bbox(positions);
  const W=x1-x0, D=y1-y0, H=z1-z0;

  const meta = await sharp(pngPath).metadata();
  const { data: pxData } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const IW=meta.width, IH=meta.height;

  const nx=faceNormal.x, ny=faceNormal.y, nz=faceNormal.z;
  const ax=Math.abs(nx), ay=Math.abs(ny), az=Math.abs(nz);

  let axis, sign;
  if (ax >= ay && ax >= az)      { axis=0; sign=Math.sign(nx); }
  else if (ay >= ax && ay >= az) { axis=1; sign=Math.sign(ny); }
  else                           { axis=2; sign=Math.sign(nz); }

  const GRID_UV = 256;
  let GU, GV, GD;
  let uAxis, vAxis, dAxis;

  if (axis === 0) {
    uAxis=1; vAxis=2; dAxis=0;
    GU=GRID_UV; GV=GRID_UV; GD=Math.max(16, Math.round(GRID_UV*W/Math.max(D,H)));
  } else if (axis === 1) {
    uAxis=0; vAxis=2; dAxis=1;
    GU=GRID_UV; GV=GRID_UV; GD=Math.max(16, Math.round(GRID_UV*D/Math.max(W,H)));
  } else {
    uAxis=0; vAxis=1; dAxis=2;
    GU=GRID_UV; GV=GRID_UV; GD=Math.max(16, Math.round(GRID_UV*H/Math.max(W,D)));
  }

  const GArr = [0, 0, 0];
  GArr[uAxis] = GU; GArr[vAxis] = GV; GArr[dAxis] = GD;
  const [GX, GY, GZ] = GArr;

  const blackMask = new Uint8Array(GU * GV);
  for (let gv=0; gv<GV; gv++) {
    for (let gu=0; gu<GU; gu++) {
      const ipx = Math.min(IW-1, Math.floor(((gu+0.5)/GU)*IW));
      const ipy = Math.min(IH-1, Math.floor(((gv+0.5)/GV)*IH));
      blackMask[gv*GU+gu] = pxData[ipy*IW+ipx] < 128 ? 1 : 0;
    }
  }

  const { grid, idx } = voxelizeShell(positions, GX, GY, GZ, x0,y0,z0, x1,y1,z1);
  floodFillExterior(grid, GX, GY, GZ);

  function getGCoord(gu, gv, gd) {
    const c = [0, 0, 0];
    c[uAxis] = gu; c[vAxis] = gv; c[dAxis] = gd;
    return c;
  }

  for (let gv=0; gv<GV; gv++) {
    for (let gu=0; gu<GU; gu++) {
      if (!blackMask[gv*GU+gu]) continue;
      for (let gd=0; gd<GD; gd++) {
        const [gx,gy,gz] = getGCoord(gu, gv, gd);
        grid[idx(gx,gy,gz)] = 2;
      }
    }
  }

  const tris = [];
  const cellW=W/GX, cellD=D/GY, cellH=H/GZ;

  function solid(ix,iy,iz) {
    if (ix<0||iy<0||iz<0||ix>=GX||iy>=GY||iz>=GZ) return false;
    return grid[idx(ix,iy,iz)] < 2;
  }

  for (let iz=0; iz<GZ; iz++) {
    for (let iy=0; iy<GY; iy++) {
      for (let ix=0; ix<GX; ix++) {
        if (!solid(ix,iy,iz)) continue;
        const ax_=x0+ix*cellW, bx_=ax_+cellW;
        const ay_=y0+iy*cellD, by_=ay_+cellD;
        const az_=z0+iz*cellH, bz_=az_+cellH;
        if (!solid(ix+1,iy,iz)) pushQuad(tris, 1,0,0, bx_,ay_,az_, bx_,by_,az_, bx_,by_,bz_, bx_,ay_,bz_);
        if (!solid(ix-1,iy,iz)) pushQuad(tris,-1,0,0, ax_,by_,az_, ax_,ay_,az_, ax_,ay_,bz_, ax_,by_,bz_);
        if (!solid(ix,iy+1,iz)) pushQuad(tris, 0,1,0, bx_,by_,az_, ax_,by_,az_, ax_,by_,bz_, bx_,by_,bz_);
        if (!solid(ix,iy-1,iz)) pushQuad(tris, 0,-1,0,ax_,ay_,az_, bx_,ay_,az_, bx_,ay_,bz_, ax_,ay_,bz_);
        if (!solid(ix,iy,iz+1)) pushQuad(tris, 0,0,1, ax_,ay_,bz_, bx_,ay_,bz_, bx_,by_,bz_, ax_,by_,bz_);
        if (!solid(ix,iy,iz-1)) pushQuad(tris, 0,0,-1,bx_,ay_,az_, ax_,ay_,az_, ax_,by_,az_, bx_,by_,az_);
      }
    }
  }

  fs.writeFileSync(outputPath, writeBinarySTL(tris));
}

module.exports = { run };
