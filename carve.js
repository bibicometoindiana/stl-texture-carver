'use strict';

const fs    = require('fs');
const sharp = require('sharp');
const path  = require('path');

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
async function buildTiledMask(pngPath, GU, GV, textureParams) {
  const { scale, rotation, offsetX, offsetY } = textureParams;
  const meta = await sharp(pngPath).metadata();
  const { data: px } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const IW = meta.width, IH = meta.height;

  const mask = new Uint8Array(GU * GV);
  const rad  = rotation * Math.PI / 180;
  const cosA = Math.cos(rad), sinA = Math.sin(rad);

  const tileW = GU * scale;
  const tileH = GV * scale;

  for (let gv = 0; gv < GV; gv++) {
    for (let gu = 0; gu < GU; gu++) {
      const u = gu / GU - 0.5;
      const v = gv / GV - 0.5;
      const ru = cosA * u - sinA * v;
      const rv = sinA * u + cosA * v;
      const su = (((ru + 0.5) / scale + offsetX) % 1 + 1) % 1;
      const sv = (((rv + 0.5) / scale + offsetY) % 1 + 1) % 1;
      const ipx = Math.min(IW - 1, Math.floor(su * IW));
      const ipy = Math.min(IH - 1, Math.floor(sv * IH));
      mask[gv * GU + gu] = px[ipy * IW + ipx] < 128 ? 1 : 0;
    }
  }
  return mask;
}

// ─── SVG parser & polygon extractor ──────────────────────────────────────────
/**
 * Parse an SVG file and extract all filled/stroked shape outlines as
 * arrays of 2-D polygon rings: [ [ [x,y], [x,y], ... ], ... ]
 * Supports <polygon>, <polyline>, <rect>, <circle>, <ellipse>, <path>.
 * Path arc / cubic / quadratic beziers are linearised with a fixed step.
 */
function parseSVGPolygons(svgPath) {
  const xml = fs.readFileSync(svgPath, 'utf8');

  // Grab viewBox / width / height so we can normalise to [0,1]
  const vbM = xml.match(/viewBox=["']([^"']+)["']/);
  let vbX=0,vbY=0,vbW=100,vbH=100;
  if (vbM) { const p=vbM[1].trim().split(/[\s,]+/).map(Number); vbX=p[0];vbY=p[1];vbW=p[2];vbH=p[3]; }
  else {
    const wM=xml.match(/\bwidth=["']([\d.]+)/),hM=xml.match(/\bheight=["']([\d.]+)/);
    if(wM)vbW=+wM[1]; if(hM)vbH=+hM[1];
  }

  const rings = [];

  function norm(pts) {
    return pts.map(([x,y])=>[(x-vbX)/vbW,(y-vbY)/vbH]);
  }

  // ---- <rect> ----
  for (const m of xml.matchAll(/<rect([^/\->]*)\/?>|<rect([^>]*)>/g)) {
    const attr = m[1]||m[2]||'';
    const ga=(n,d=0)=>{ const r=attr.match(new RegExp(`\\b${n}=["']([\\d.\\-]+)["']`)); return r?+r[1]:d; };
    const x=ga('x'),y=ga('y'),w=ga('width',0),h=ga('height',0),rx=ga('rx',0),ry=ga('ry',rx);
    if(w<=0||h<=0) continue;
    if(rx<=0&&ry<=0) {
      rings.push(norm([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]));
    } else {
      const r=Math.min(rx,w/2,ry,h/2), steps=16, pts=[];
      const corners=[[x+r,y,270],[x+w-r,y,270+90],[x+w-r,y+h-r,0],[x+r,y+h-r,90]];
      for(const [cx2,cy2,startDeg] of corners)
        for(let s=0;s<=steps;s++){
          const a=(startDeg+s*90/steps)*Math.PI/180;
          pts.push([cx2+r*Math.cos(a),cy2+r*Math.sin(a)]);
        }
      rings.push(norm(pts));
    }
  }

  // ---- <circle> ----
  for (const m of xml.matchAll(/<circle([^/\->]*)\/?>|<circle([^>]*)>/g)) {
    const attr=m[1]||m[2]||'';
    const ga=(n,d=0)=>{ const r=attr.match(new RegExp(`\\b${n}=["']([\\d.\\-]+)["']`)); return r?+r[1]:d; };
    const cx2=ga('cx'),cy2=ga('cy'),r=ga('r');
    if(r<=0) continue;
    const steps=64, pts=[];
    for(let s=0;s<steps;s++){ const a=2*Math.PI*s/steps; pts.push([cx2+r*Math.cos(a),cy2+r*Math.sin(a)]); }
    rings.push(norm(pts));
  }

  // ---- <ellipse> ----
  for (const m of xml.matchAll(/<ellipse([^/\->]*)\/?>|<ellipse([^>]*)>/g)) {
    const attr=m[1]||m[2]||'';
    const ga=(n,d=0)=>{ const r=attr.match(new RegExp(`\\b${n}=["']([\\d.\\-]+)["']`)); return r?+r[1]:d; };
    const cx2=ga('cx'),cy2=ga('cy'),rx2=ga('rx'),ry2=ga('ry');
    if(rx2<=0||ry2<=0) continue;
    const steps=64, pts=[];
    for(let s=0;s<steps;s++){ const a=2*Math.PI*s/steps; pts.push([cx2+rx2*Math.cos(a),cy2+ry2*Math.sin(a)]); }
    rings.push(norm(pts));
  }

  // ---- <polygon> / <polyline> ----
  for (const m of xml.matchAll(/<poly(?:gon|line)([^>]*)>/g)) {
    const ptM=m[1].match(/points=["']([^"']+)["']/);
    if(!ptM) continue;
    const nums=ptM[1].trim().split(/[\s,]+/).map(Number);
    const pts=[];
    for(let i=0;i+1<nums.length;i+=2) pts.push([nums[i],nums[i+1]]);
    if(pts.length>=2) rings.push(norm(pts));
  }

  // ---- <path> ----
  for (const m of xml.matchAll(/<path([^>]*)>/g)) {
    const dM=m[1].match(/\bd=["']([^"']+)["']/);
    if(!dM) continue;
    rings.push(...norm_path(dM[1], vbX, vbY, vbW, vbH));
  }

  return rings;
}

/** Linearise an SVG path d-attribute into one or more normalised rings. */
function norm_path(d, vbX, vbY, vbW, vbH) {
  const STEPS_CURVE = 32;
  const rings = [];
  let cur = [], cx=0, cy=0, mx=0, my=0;
  let lastCmd='', lastCx=0, lastCy=0;

  // tokenise: commands + numbers
  const tokens = d.match(/[MmZzLlHhVvCcSsQqTtAa]|[\-+]?[\d]*\.?[\d]+(?:[eE][\-+]?[\d]+)?/g)||[];
  let i=0;
  function nextNum(){ return i<tokens.length&&/[^A-Za-z]/.test(tokens[i]) ? +tokens[i++] : 0; }
  function addPt(x,y){ cur.push([(x-vbX)/vbW,(y-vbY)/vbH]); }

  while(i<tokens.length){
    const cmd = tokens[i++];
    if(!/[A-Za-z]/.test(cmd)) { i--; /* repeat last command */ }
    const c = /[A-Za-z]/.test(tokens[i-1]) ? tokens[i-1] : lastCmd;
    lastCmd = c;

    switch(c){
      case 'M': cx=nextNum(); cy=nextNum(); mx=cx; my=cy; addPt(cx,cy); lastCmd='L'; break;
      case 'm': cx+=nextNum(); cy+=nextNum(); mx=cx; my=cy; addPt(cx,cy); lastCmd='l'; break;
      case 'Z': case 'z':
        if(cur.length>1) rings.push(cur);
        cur=[]; cx=mx; cy=my; break;
      case 'L': cx=nextNum(); cy=nextNum(); addPt(cx,cy); break;
      case 'l': cx+=nextNum(); cy+=nextNum(); addPt(cx,cy); break;
      case 'H': cx=nextNum(); addPt(cx,cy); break;
      case 'h': cx+=nextNum(); addPt(cx,cy); break;
      case 'V': cy=nextNum(); addPt(cx,cy); break;
      case 'v': cy+=nextNum(); addPt(cx,cy); break;
      case 'C':{
        const x1=nextNum(),y1=nextNum(),x2=nextNum(),y2=nextNum(),ex=nextNum(),ey=nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,t2=t*t,t3=t2*t,u=1-t,u2=u*u,u3=u2*u;
          addPt(u3*cx+3*u2*t*x1+3*u*t2*x2+t3*ex, u3*cy+3*u2*t*y1+3*u*t2*y2+t3*ey);
        }
        lastCx=x2; lastCy=y2; cx=ex; cy=ey; break;
      }
      case 'c':{
        const x1=cx+nextNum(),y1=cy+nextNum(),x2=cx+nextNum(),y2=cy+nextNum(),ex=cx+nextNum(),ey=cy+nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,t2=t*t,t3=t2*t,u=1-t,u2=u*u,u3=u2*u;
          addPt(u3*cx+3*u2*t*x1+3*u*t2*x2+t3*ex, u3*cy+3*u2*t*y1+3*u*t2*y2+t3*ey);
        }
        lastCx=x2; lastCy=y2; cx=ex; cy=ey; break;
      }
      case 'S':{
        const x1=2*cx-lastCx,y1=2*cy-lastCy,x2=nextNum(),y2=nextNum(),ex=nextNum(),ey=nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,t2=t*t,t3=t2*t,u=1-t,u2=u*u,u3=u2*u;
          addPt(u3*cx+3*u2*t*x1+3*u*t2*x2+t3*ex, u3*cy+3*u2*t*y1+3*u*t2*y2+t3*ey);
        }
        lastCx=x2; lastCy=y2; cx=ex; cy=ey; break;
      }
      case 's':{
        const x1=2*cx-lastCx,y1=2*cy-lastCy,x2=cx+nextNum(),y2=cy+nextNum(),ex=cx+nextNum(),ey=cy+nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,t2=t*t,t3=t2*t,u=1-t,u2=u*u,u3=u2*u;
          addPt(u3*cx+3*u2*t*x1+3*u*t2*x2+t3*ex, u3*cy+3*u2*t*y1+3*u*t2*y2+t3*ey);
        }
        lastCx=x2; lastCy=y2; cx=ex; cy=ey; break;
      }
      case 'Q':{
        const x1=nextNum(),y1=nextNum(),ex=nextNum(),ey=nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,u=1-t;
          addPt(u*u*cx+2*u*t*x1+t*t*ex, u*u*cy+2*u*t*y1+t*t*ey);
        }
        lastCx=x1; lastCy=y1; cx=ex; cy=ey; break;
      }
      case 'q':{
        const x1=cx+nextNum(),y1=cy+nextNum(),ex=cx+nextNum(),ey=cy+nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,u=1-t;
          addPt(u*u*cx+2*u*t*x1+t*t*ex, u*u*cy+2*u*t*y1+t*t*ey);
        }
        lastCx=x1; lastCy=y1; cx=ex; cy=ey; break;
      }
      case 'T':{
        const x1=2*cx-lastCx,y1=2*cy-lastCy,ex=nextNum(),ey=nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,u=1-t;
          addPt(u*u*cx+2*u*t*x1+t*t*ex, u*u*cy+2*u*t*y1+t*t*ey);
        }
        lastCx=x1; lastCy=y1; cx=ex; cy=ey; break;
      }
      case 't':{
        const x1=2*cx-lastCx,y1=2*cy-lastCy,ex=cx+nextNum(),ey=cy+nextNum();
        for(let s=1;s<=STEPS_CURVE;s++){
          const t=s/STEPS_CURVE,u=1-t;
          addPt(u*u*cx+2*u*t*x1+t*t*ex, u*u*cy+2*u*t*y1+t*t*ey);
        }
        lastCx=x1; lastCy=y1; cx=ex; cy=ey; break;
      }
      case 'A': case 'a':{
        const rel=(c==='a');
        const rx2=nextNum(),ry2=nextNum(),xRot=nextNum(),largeArc=nextNum(),sweep=nextNum();
        let ex=nextNum(),ey=nextNum();
        if(rel){ex+=cx;ey+=cy;}
        // convert endpoint to centre parametrisation
        const phi=xRot*Math.PI/180,cosPhi=Math.cos(phi),sinPhi=Math.sin(phi);
        const dx2=(cx-ex)/2, dy2=(cy-ey)/2;
        const x1p= cosPhi*dx2+sinPhi*dy2, y1p=-sinPhi*dx2+cosPhi*dy2;
        let rx3=Math.abs(rx2),ry3=Math.abs(ry2);
        const lam=(x1p*x1p)/(rx3*rx3)+(y1p*y1p)/(ry3*ry3);
        if(lam>1){rx3*=Math.sqrt(lam);ry3*=Math.sqrt(lam);}
        const num=Math.max(0,(rx3*rx3*ry3*ry3-rx3*rx3*y1p*y1p-ry3*ry3*x1p*x1p));
        const den=rx3*rx3*y1p*y1p+ry3*ry3*x1p*x1p;
        let sq=den===0?0:Math.sqrt(num/den);
        if(largeArc===sweep) sq=-sq;
        const cxp= sq*rx3*y1p/ry3, cyp=-sq*ry3*x1p/rx3;
        const ccx=(cx+ex)/2+cosPhi*cxp-sinPhi*cyp;
        const ccy=(cy+ey)/2+sinPhi*cxp+cosPhi*cyp;
        const ux=(x1p-cxp)/rx3,uy=(y1p-cyp)/ry3;
        const vx=(-x1p-cxp)/rx3,vy=(-y1p-cyp)/ry3;
        let ang1=Math.atan2(uy,ux);
        let dang=Math.atan2(vy,vx)-ang1;
        if(sweep===0&&dang>0) dang-=2*Math.PI;
        if(sweep===1&&dang<0) dang+=2*Math.PI;
        const steps2=Math.max(4,Math.ceil(Math.abs(dang)*rx3*16));
        for(let s=1;s<=steps2;s++){
          const a=ang1+dang*s/steps2;
          addPt(cosPhi*rx3*Math.cos(a)-sinPhi*ry3*Math.sin(a)+ccx,
                sinPhi*rx3*Math.cos(a)+cosPhi*ry3*Math.sin(a)+ccy);
        }
        cx=ex; cy=ey; break;
      }
      default: break;
    }
  }
  if(cur.length>1) rings.push(cur);
  return rings;
}

// ─── Ear-clip triangulation (for flat cap faces) ─────────────────────────────
function triangulate(ring) {
  const pts = ring.slice();
  const tris = [];
  let iter = 0;
  while (pts.length > 3) {
    let clipped = false;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i-1+n)%n], b = pts[i], c = pts[(i+1)%n];
      if (!isEar(a, b, c, pts)) continue;
      tris.push([a, b, c]);
      pts.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped || ++iter > pts.length * pts.length) break;
  }
  if (pts.length === 3) tris.push([pts[0], pts[1], pts[2]]);
  return tris;
}

function cross2(o, a, b) {
  return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
}

function isEar(a, b, c, poly) {
  if (cross2(a, b, c) <= 0) return false;
  for (const p of poly) {
    if (p===a||p===b||p===c) continue;
    if (pointInTriangle(p, a, b, c)) return false;
  }
  return true;
}

function pointInTriangle(p, a, b, c) {
  const d1=cross2(p,a,b), d2=cross2(p,b,c), d3=cross2(p,c,a);
  const hasNeg=(d1<0)||(d2<0)||(d3<0), hasPos=(d1>0)||(d2>0)||(d3>0);
  return !(hasNeg&&hasPos);
}

// ─── SVG extrude: minimal-face solid from SVG outlines ────────────────────────
/**
 * Given parsed SVG rings (normalised 0-1), a face plane, carve depth and
 * texture scale/offset params, produce STL triangles by:
 *  - projecting each ring onto the face plane in world space
 *  - extruding walls along the carve axis (one quad per edge = 2 tris)
 *  - capping top and bottom with ear-clip triangulation
 */
function svgExtrudeOnFace(rings, textureParams, uAxis, vAxis, dAxis,
                           worldMins, worldSizes, carveDepth, tris) {
  const { scale, rotation, offsetX, offsetY } = textureParams;
  const rad=rotation*Math.PI/180, cosA=Math.cos(rad), sinA=Math.sin(rad);

  for (const ring of rings) {
    if (ring.length < 3) continue;

    // Apply texture transform (scale, rotation, offset) to each normalised UV
    const worldPts = ring.map(([u,v]) => {
      // rotate + scale around centre
      const cu = u - 0.5, cv = v - 0.5;
      const ru = (cosA*cu - sinA*cv) / scale + 0.5 + offsetX;
      const rv = (sinA*cu + cosA*cv) / scale + 0.5 + offsetY;
      // map back to world coordinates on the face surface
      const wp = [0,0,0];
      wp[uAxis] = worldMins[uAxis] + ru * worldSizes[uAxis];
      wp[vAxis] = worldMins[vAxis] + rv * worldSizes[vAxis];
      // place on the outer surface (dAxis at max)
      wp[dAxis] = worldMins[dAxis] + worldSizes[dAxis];
      return wp;
    });

    // Determine face normal direction (outward = positive dAxis)
    const faceNormal = [0,0,0];
    faceNormal[dAxis] = 1;
    const [fnx,fny,fnz] = faceNormal;
    const wallNormalSign = -1; // walls point inward (into the model)

    // ── Top cap (outer surface) ──────────────────────────────────────────────
    const ring2d = ring.map(([u,v]) => {
      const cu=u-0.5,cv=v-0.5;
      const ru=(cosA*cu-sinA*cv)/scale+0.5+offsetX;
      const rv=(sinA*cu+cosA*cv)/scale+0.5+offsetY;
      return [ru,rv];
    });
    const capTris = triangulate(ring2d);

    for (const [ta,tb,tc] of capTris) {
      const pa=[0,0,0],pb=[0,0,0],pc=[0,0,0];
      for (const [pt,w2] of [[pa,ta],[pb,tb],[pc,tc]]) {
        pt[uAxis]=worldMins[uAxis]+w2[0]*worldSizes[uAxis];
        pt[vAxis]=worldMins[vAxis]+w2[1]*worldSizes[vAxis];
        pt[dAxis]=worldMins[dAxis]+worldSizes[dAxis];
      }
      tris.push([fnx,fny,fnz, pa[0],pa[1],pa[2], pb[0],pb[1],pb[2], pc[0],pc[1],pc[2]]);
    }

    // ── Bottom cap (carved depth) ────────────────────────────────────────────
    const dBottom = worldMins[dAxis] + worldSizes[dAxis] - carveDepth;
    for (const [ta,tb,tc] of capTris) {
      const pa=[0,0,0],pb=[0,0,0],pc=[0,0,0];
      for (const [pt,w2] of [[pa,ta],[pb,tb],[pc,tc]]) {
        pt[uAxis]=worldMins[uAxis]+w2[0]*worldSizes[uAxis];
        pt[vAxis]=worldMins[vAxis]+w2[1]*worldSizes[vAxis];
        pt[dAxis]=dBottom;
      }
      // reverse winding for bottom face (normal points inward)
      tris.push([-fnx,-fny,-fnz, pa[0],pa[1],pa[2], pc[0],pc[1],pc[2], pb[0],pb[1],pb[2]]);
    }

    // ── Side walls ───────────────────────────────────────────────────────────
    const n = worldPts.length;
    for (let i = 0; i < n; i++) {
      const p0 = worldPts[i];
      const p1 = worldPts[(i+1)%n];

      // bottom versions
      const p0b = p0.slice(); p0b[dAxis] = dBottom;
      const p1b = p1.slice(); p1b[dAxis] = dBottom;

      // Edge vector and outward wall normal
      const ex = p1[0]-p0[0], ey = p1[1]-p0[1], ez = p1[2]-p0[2];
      // cross edge with dAxis-direction to get outward normal
      const dd = [0,0,0]; dd[dAxis]=1;
      let wnx=ey*dd[2]-ez*dd[1], wny=ez*dd[0]-ex*dd[2], wnz=ex*dd[1]-ey*dd[0];
      const wlen=Math.sqrt(wnx*wnx+wny*wny+wnz*wnz)||1;
      wnx/=wlen; wny/=wlen; wnz/=wlen;

      pushQuad(tris, wnx,wny,wnz,
        p0[0],p0[1],p0[2], p1[0],p1[1],p1[2],
        p1b[0],p1b[1],p1b[2], p0b[0],p0b[1],p0b[2]);
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function run(stlPath, patternPath, outputPath, selectedGroups, textureParams) {
  const stlBuf    = fs.readFileSync(stlPath);
  const positions = parseSTL(stlBuf);
  const [x0,y0,z0,x1,y1,z1] = bbox(positions);
  const W=x1-x0, D=y1-y0, H=z1-z0;

  const isSVG = path.extname(patternPath).toLowerCase() === '.svg';

  // Determine carve axis
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
  const worldMins = [x0,y0,z0];
  const worldSizes = [W,D,H];

  // ── SVG mode: extrude shapes directly ──────────────────────────────────────
  if (isSVG) {
    const rings = parseSVGPolygons(patternPath);
    const carveDepth = Math.min(worldDims[dAxis] * 0.3, Math.max(worldDims[uAxis], worldDims[vAxis]) * 0.05);

    // Start from original mesh triangles (keep non-selected faces)
    const tris = [];
    const allTriSet = new Set();
    for (const g of selectedGroups) g.triIndices.forEach(i => allTriSet.add(i));
    const totalTris = positions.length / 9;
    for (let i = 0; i < totalTris; i++) {
      if (allTriSet.has(i)) continue; // skip selected faces (replaced by extrusion)
      const b = i*9;
      // compute face normal
      const ax_=positions[b],ay_=positions[b+1],az_=positions[b+2];
      const bx_=positions[b+3],by_=positions[b+4],bz_=positions[b+5];
      const cx_=positions[b+6],cy_=positions[b+7],cz_=positions[b+8];
      const ux_=bx_-ax_,uy_=by_-ay_,uz_=bz_-az_;
      const vx_=cx_-ax_,vy_=cy_-ay_,vz_=cz_-az_;
      const fnx=uy_*vz_-uz_*vy_, fny=uz_*vx_-ux_*vz_, fnz=ux_*vy_-uy_*vx_;
      const fl=Math.sqrt(fnx*fnx+fny*fny+fnz*fnz)||1;
      tris.push([fnx/fl,fny/fl,fnz/fl, ax_,ay_,az_, bx_,by_,bz_, cx_,cy_,cz_]);
    }

    svgExtrudeOnFace(rings, textureParams, uAxis, vAxis, dAxis,
                     worldMins, worldSizes, carveDepth, tris);

    fs.writeFileSync(outputPath, writeBinarySTL(tris));
    return;
  }

  // ── PNG voxel mode (original) ───────────────────────────────────────────────
  const GRID_UV = 256;
  const GU = GRID_UV, GV = GRID_UV;
  const GD = Math.max(16, Math.round(GRID_UV * worldDims[dAxis] / Math.max(worldDims[uAxis], worldDims[vAxis])));

  const GArr = [0,0,0];
  GArr[uAxis]=GU; GArr[vAxis]=GV; GArr[dAxis]=GD;
  const [GX,GY,GZ] = GArr;

  const cellU = worldSizes[uAxis] / GU;
  const cellV = worldSizes[vAxis] / GV;

  const faceMask = new Uint8Array(GU * GV);
  const allTriSet2 = new Set();
  for (const g of selectedGroups) g.triIndices.forEach(i => allTriSet2.add(i));

  for (const ti of allTriSet2) {
    const b = ti * 9;
    const verts = [
      [positions[b],   positions[b+1], positions[b+2]],
      [positions[b+3], positions[b+4], positions[b+5]],
      [positions[b+6], positions[b+7], positions[b+8]],
    ];
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

  const tiledMask = await buildTiledMask(patternPath, GU, GV, textureParams);

  const blackMask = new Uint8Array(GU * GV);
  for (let i=0; i<GU*GV; i++) blackMask[i] = (faceMask[i] && tiledMask[i]) ? 1 : 0;

  const { grid, idx } = voxelizeShell(positions, GX, GY, GZ, x0,y0,z0, x1,y1,z1);
  floodFillExterior(grid, GX, GY, GZ);

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
