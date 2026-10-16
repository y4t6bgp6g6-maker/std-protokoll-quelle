// Arena: Live-Kampf in 3D für das Team (alle gleichzeitig über den Team-Server, Durable Object ARENA).
// Lädt erst beim Öffnen der Arena (arena-seite.js); Figur und Animationen: Quaternius, CC0 (siehe LIZENZEN.txt).
// Bewegung rechnet jedes iPhone selbst und meldet sie; Treffer, Leben und Punkte kommen nur vom Server.

import * as THREE from './three.module.min.js';
import { GLTFLoader } from './GLTFLoader.js';
import * as SkeletonUtils from './SkeletonUtils.js';

// Farben der Spieler (Server vergibt die Nummer)
export const COLORS = ['#e9b234', '#3d8fe0', '#e0503f', '#3fae62', '#9a63d8', '#ee8433', '#2fbcc4', '#e46aa6'];
const SPEED_JOG = 3.4;
const SPEED_SPRINT = 5.8;
const SPEED_BLOCK = 1.3;
const ROLL_SPEED = 7.5;
const ROLL_TIME = 0.5;
const BODY_R = 0.42; // Abstand zwischen zwei Figuren (Hälfte)
const SEND_GAP = 0.066;
const INTERP = 0.11; // Kollegen etwas verzögert zeigen, dafür flüssig
// Animationen: Name im Modell, Geschwindigkeit, nach wie vielen Sekunden (bei Geschwindigkeit 1) man wieder frei ist
const ONE = {
  jab: { clip: 'Punch_Jab', ts: 1.7, free: 0.5 },
  cross: { clip: 'Punch_Cross', ts: 1.7, free: 0.58 },
  heavy: { clip: 'Sword_Attack', ts: 1.25, free: 1.2 },
  roll: { clip: 'Roll', ts: 1.65, free: 1.05 },
  hitHead: { clip: 'Hit_Head', ts: 1, free: 0.4 },
  hitChest: { clip: 'Hit_Chest', ts: 1, free: 0.33 },
};

let base = null; // geladenes Modell { scene, clips, height }
let baseLoad = null;
const loadBase = () =>
  (baseLoad ||= new GLTFLoader().loadAsync(new URL('./figur.glb', import.meta.url).href).then((g) => {
    const box = new THREE.Box3().setFromObject(g.scene);
    base = { scene: g.scene, clips: g.animations, height: box.max.y - box.min.y };
  })).catch((e) => {
    baseLoad = null;
    throw e;
  });

// ───────── Geräusche (ohne Dateien, Web Audio) ─────────
let audio = null;
function sound(kind, vol = 1) {
  if (!audio) return;
  const t = audio.currentTime;
  const g = audio.createGain();
  g.connect(audio.destination);
  if (kind === 'whoosh' || kind === 'hit' || kind === 'block') {
    const len = kind === 'whoosh' ? 0.18 : 0.12;
    const buf = audio.createBuffer(1, audio.sampleRate * len, audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    const src = audio.createBufferSource();
    src.buffer = buf;
    const f = audio.createBiquadFilter();
    f.type = kind === 'whoosh' ? 'bandpass' : 'lowpass';
    f.frequency.value = kind === 'whoosh' ? 900 : kind === 'block' ? 2400 : 500;
    src.connect(f).connect(g);
    g.gain.value = (kind === 'whoosh' ? 0.12 : 0.5) * vol;
    src.start(t);
  }
  if (kind === 'hit' || kind === 'block' || kind === 'ko') {
    const o = audio.createOscillator();
    o.type = kind === 'block' ? 'square' : 'sine';
    o.frequency.setValueAtTime(kind === 'block' ? 900 : kind === 'ko' ? 160 : 120, t);
    o.frequency.exponentialRampToValueAtTime(kind === 'ko' ? 40 : 50, t + (kind === 'ko' ? 0.5 : 0.15));
    const og = audio.createGain();
    og.gain.setValueAtTime((kind === 'block' ? 0.05 : 0.6) * vol, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'ko' ? 0.6 : 0.18));
    o.connect(og).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.7);
  }
}

// ───────── Arena (Boden, Zaun, Baustelle drumherum) ─────────
function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}
function noise(ctx, s, n, alpha, light) {
  for (let i = 0; i < n; i++) {
    const v = Math.random();
    ctx.fillStyle = light ? `rgba(255,255,255,${alpha * v})` : `rgba(0,0,0,${alpha * v})`;
    const r = Math.random() * 2.2 + 0.4;
    ctx.fillRect(Math.random() * s, Math.random() * s, r, r);
  }
}

function buildWorld(scene, R) {
  // Himmel: Verlauf auf einer großen Kugel
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(200, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { top: { value: new THREE.Color('#5c8fd1') }, bottom: { value: new THREE.Color('#dfe7ee') } },
      vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 p; void main(){ gl_FragColor = vec4(mix(bottom, top, pow(max(p.y,0.),0.6)),1.); }',
    })
  );
  scene.add(sky);
  scene.fog = new THREE.Fog('#d9e1e8', 35, 120);

  const hemi = new THREE.HemisphereLight('#dfeaff', '#7a6a55', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff3dd', 2.4);
  sun.position.set(12, 22, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -R - 3;
  sc.right = sc.top = R + 3;
  sc.near = 5;
  sc.far = 60;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);

  // Erde rundherum
  const dirt = canvasTex(256, (c, s) => {
    c.fillStyle = '#8b7556';
    c.fillRect(0, 0, s, s);
    noise(c, s, 6000, 0.35, false);
    noise(c, s, 2500, 0.25, true);
  }, 40);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 48), new THREE.MeshStandardMaterial({ map: dirt, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  // Betonplatte mit Fugen
  const concrete = canvasTex(512, (c, s) => {
    c.fillStyle = '#a9a8a2';
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      const g = c.createRadialGradient(Math.random() * s, Math.random() * s, 0, Math.random() * s, Math.random() * s, 80 + Math.random() * 120);
      g.addColorStop(0, `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},0.06)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    }
    noise(c, s, 14000, 0.22, false);
    noise(c, s, 6000, 0.25, true);
    c.strokeStyle = 'rgba(40,40,40,0.55)';
    c.lineWidth = 3;
    c.strokeRect(0, 0, s, s);
    c.strokeStyle = 'rgba(30,30,30,0.35)';
    c.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      let x = Math.random() * s, y = Math.random() * s;
      c.moveTo(x, y);
      for (let k = 0; k < 6; k++) c.lineTo((x += (Math.random() - 0.5) * 40), (y += (Math.random() - 0.5) * 40));
      c.stroke();
    }
  }, R / 2.5);
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.6, R + 0.75, 0.2, 64), new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.92 }));
  slab.position.y = -0.1;
  slab.receiveShadow = true;
  scene.add(slab);
  // Rand-Markierung (Warnstreifen)
  const stripe = canvasTex(256, (c, s) => {
    for (let i = 0; i < 8; i++) {
      c.fillStyle = i % 2 ? '#1d1d1d' : '#e9b51f';
      c.beginPath();
      c.moveTo((i * s) / 8, 0);
      c.lineTo(((i + 1) * s) / 8, 0);
      c.lineTo(((i + 1) * s) / 8 - s / 8, s);
      c.lineTo((i * s) / 8 - s / 8, s);
      c.fill();
    }
  });
  stripe.repeat.set(40, 1);
  const ring = new THREE.Mesh(new THREE.RingGeometry(R + 0.05, R + 0.45, 96, 1), new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.8 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.006;
  ring.receiveShadow = true;
  scene.add(ring);

  // Bauzaun: Füße, Rahmen, Gitter
  const mesh = canvasTex(128, (c, s) => {
    c.clearRect(0, 0, s, s);
    c.strokeStyle = '#c9ccd0';
    c.lineWidth = 2;
    for (let i = 0; i <= s; i += 16) {
      c.beginPath();
      c.moveTo(i, 0);
      c.lineTo(i, s);
      c.moveTo(0, i);
      c.lineTo(s, i);
      c.stroke();
    }
  });
  mesh.repeat.set(5, 4);
  const gridMat = new THREE.MeshStandardMaterial({ map: mesh, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 });
  const frameMat = new THREE.MeshStandardMaterial({ color: '#b9bec4', metalness: 0.7, roughness: 0.4 });
  const footMat = new THREE.MeshStandardMaterial({ color: '#c8432f', roughness: 0.8 });
  const FR = R + 2.2, n = 24, w = (2 * Math.PI * FR) / n;
  const gridGeo = new THREE.PlaneGeometry(w - 0.1, 1.9);
  const postGeo = new THREE.CylinderGeometry(0.025, 0.025, 2, 6);
  const footGeo = new THREE.BoxGeometry(0.65, 0.14, 0.22);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const panel = new THREE.Group();
    panel.position.set(Math.sin(a) * FR, 0, Math.cos(a) * FR);
    panel.rotation.y = a;
    const g = new THREE.Mesh(gridGeo, gridMat);
    g.position.y = 1.08;
    g.castShadow = true;
    panel.add(g);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, frameMat);
      p.position.set((s * (w - 0.05)) / 2, 1.05, 0);
      panel.add(p);
    }
    const f = new THREE.Mesh(footGeo, footMat);
    f.position.set((w - 0.05) / 2, 0.07, 0);
    f.rotation.y = Math.PI / 2;
    f.castShadow = true;
    panel.add(f);
    scene.add(panel);
  }

  // Baustelle drumherum: Container, Paletten, Kran, Flutlicht
  const corrugated = (color) =>
    canvasTex(256, (c, s) => {
      c.fillStyle = color;
      c.fillRect(0, 0, s, s);
      for (let x = 0; x < s; x += 16) {
        const g = c.createLinearGradient(x, 0, x + 16, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.25)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0.25)');
        c.fillStyle = g;
        c.fillRect(x, 0, 16, s);
      }
      noise(c, s, 3000, 0.2, false);
    }, 1);
  const container = (x, z, rot, color, stack = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(6, 2.6, 2.45), new THREE.MeshStandardMaterial({ map: corrugated(color), roughness: 0.7, metalness: 0.3 }));
    m.position.set(x, 1.3 + stack * 2.6, z);
    m.rotation.y = rot;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  };
  container(-19, -8, 0.4, '#2f6aa8');
  container(-19, -8, 0.4, '#b0412e', 1);
  container(-20, 2, 1.4, '#3a7a49');
  container(18, 11, -0.6, '#c48a22');
  container(21, -4, 1.2, '#6c6f74');
  const wood = canvasTex(128, (c, s) => {
    c.fillStyle = '#b48a58';
    c.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 3) {
      c.fillStyle = `rgba(80,50,20,${Math.random() * 0.25})`;
      c.fillRect(0, y, s, 1);
    }
  });
  const woodMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9 });
  const pallets = (x, z, h) => {
    for (let i = 0; i < h; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.14, 0.8), woodMat);
      p.position.set(x, 0.07 + i * 0.15, z);
      p.rotation.y = (Math.random() - 0.5) * 0.2;
      p.castShadow = p.receiveShadow = true;
      scene.add(p);
    }
  };
  pallets(16, -10, 6);
  pallets(17.4, -9.2, 3);
  pallets(-15, 12, 5);
  pallets(4, 17, 4);
  // Kran (Gittermast als Kästen)
  const crane = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: '#e5b21e', roughness: 0.6, metalness: 0.3 });
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.4, 34, 1.4), yellow);
  mast.position.y = 17;
  crane.add(mast);
  const jib = new THREE.Mesh(new THREE.BoxGeometry(36, 1.1, 1.1), yellow);
  jib.position.set(9, 34, 0);
  crane.add(jib);
  const weight = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 1.6), new THREE.MeshStandardMaterial({ color: '#777', roughness: 0.9 }));
  weight.position.set(-7, 33, 0);
  crane.add(weight);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: '#ddd', roughness: 0.5 }));
  cab.position.set(1.6, 32, 0);
  crane.add(cab);
  crane.position.set(-12, 0, -30);
  crane.rotation.y = 0.5;
  crane.traverse((o) => (o.castShadow = true));
  scene.add(crane);
  // Flutlichtmasten
  const poleMat = new THREE.MeshStandardMaterial({ color: '#555b61', metalness: 0.6, roughness: 0.5 });
  for (const a of [0.8, 2.4, 3.9, 5.5]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 9, 8), poleMat);
    p.position.set(Math.sin(a) * (R + 4), 4.5, Math.cos(a) * (R + 4));
    p.castShadow = true;
    scene.add(p);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.6, 0.3), new THREE.MeshStandardMaterial({ color: '#333', emissive: '#fff6d8', emissiveIntensity: 0.6 }));
    lamp.position.set(p.position.x * 0.97, 9.1, p.position.z * 0.97);
    lamp.lookAt(0, 0, 0);
    scene.add(lamp);
  }
  return sun;
}

// ───────── Figuren ─────────
class Fighter {
  constructor(info, scene, me) {
    this.id = info.id;
    this.me = me;
    this.name = info.name;
    this.color = COLORS[info.color % COLORS.length];
    this.hp = info.hp;
    this.k = info.k || 0;
    this.d = info.d || 0;
    this.dead = !!info.dead;
    this.pos = new THREE.Vector3(info.x, 0, info.z);
    this.yaw = info.r || 0;
    this.m = 0; // 0 steht, 1 geht, 2 rennt
    this.block = false;
    this.snaps = []; // Kollegen: [Zeit, x, z, r]
    this.busy = 0; // bis wann eine Einmal-Animation läuft (Sekunden, Spielzeit)
    this.oneKind = null;
    this.push = new THREE.Vector2();

    const model = SkeletonUtils.clone(base.scene);
    const s = 1.8 / base.height;
    model.scale.setScalar(s);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;
      const joint = o.material.name === 'M_Joints';
      o.material = new THREE.MeshStandardMaterial({
        color: joint ? '#2c3036' : this.color,
        roughness: joint ? 0.45 : 0.55,
        metalness: joint ? 0.4 : 0.05,
      });
      if (!joint) this.bodyMat = o.material;
    });
    this.root = new THREE.Group();
    this.root.add(model);
    scene.add(this.root);
    this.model = model;
    this.hand = null;
    this.head = null;
    model.traverse((o) => {
      if (o.name === 'DEF-handR') this.hand = o;
      if (o.name === 'DEF-head') this.head = o;
    });
    // Hammer für den schweren Schlag (nur dann sichtbar)
    this.hammer = new THREE.Group();
    const stiel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.78, 8), new THREE.MeshStandardMaterial({ color: '#a8743f', roughness: 0.8 }));
    stiel.position.y = 0.3;
    const kopf = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.24), new THREE.MeshStandardMaterial({ color: '#3b3f45', metalness: 0.8, roughness: 0.35 }));
    kopf.position.y = 0.68;
    this.hammer.add(stiel, kopf);
    this.hammer.traverse((o) => (o.castShadow = true));
    this.hammer.visible = false;
    if (this.hand) {
      this.hand.add(this.hammer);
      this.hammer.scale.setScalar(1 / s);
      this.hammer.rotation.set(0, 0, Math.PI / 2);
      this.hammer.position.set(0, 0.08 / s, 0);
    }

    this.mixer = new THREE.AnimationMixer(model);
    this.act = {};
    for (const c of base.clips) {
      const a = this.mixer.clipAction(c);
      if (!/_Loop$/.test(c.name)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.act[c.name] = a;
    }
    this.cur = null;
    this.go(this.dead ? 'Death01' : 'Idle_Loop', 0);
    if (this.dead) this.cur.time = this.cur.getClip().duration;
    this.place();
  }

  go(name, fade = 0.15, ts = 1) {
    const next = this.act[name];
    if (!next) return;
    if (this.cur === next && /_Loop$/.test(name)) return;
    next.reset();
    next.setEffectiveTimeScale(ts);
    next.setEffectiveWeight(1);
    next.play();
    if (this.cur && this.cur !== next) this.cur.crossFadeTo(next, fade, false);
    this.cur = next;
  }

  /** Einmal-Animation (Schlag, Rolle, Treffer); t = Spielzeit */
  one(kind, t) {
    const o = ONE[kind];
    this.oneKind = kind;
    this.busy = t + o.free / o.ts;
    this.go(o.clip, kind.startsWith('hit') ? 0.05 : 0.08, o.ts);
    this.hammer.visible = kind === 'heavy';
  }

  die() {
    this.dead = true;
    this.block = false;
    this.busy = 0;
    this.hammer.visible = false;
    this.go('Death01', 0.1, 1.1);
  }

  spawn(x, z, r, hp) {
    this.dead = false;
    this.hp = hp;
    this.pos.set(x, 0, z);
    this.yaw = r;
    this.snaps = [];
    this.busy = 0;
    this.push.set(0, 0);
    this.go('Idle_Loop', 0.05);
    this.place();
  }

  /** Grundhaltung nach Tempo, Block und Einmal-Animationen */
  pose(t) {
    if (this.dead) return;
    if (t < this.busy) return;
    if (this.oneKind) {
      this.oneKind = null;
      this.hammer.visible = false;
    }
    if (this.dance && this.m === 0 && !this.block) return this.go('Dance_Loop', 0.25);
    this.dance = false;
    if (this.block) return this.go('Punch_Enter', 0.1, 2);
    this.go(this.m === 2 ? 'Sprint_Loop' : this.m === 1 ? 'Jog_Fwd_Loop' : 'Idle_Loop', 0.2);
  }

  place() {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
  }

  remove(scene) {
    scene.remove(this.root);
    this.mixer.stopAllAction();
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry !== undefined && o.geometry.dispose?.();
        o.material.dispose?.();
      }
    });
    this.tag?.remove();
  }
}

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// ───────── Spiel ─────────
/**
 * el: leeres Element (ganzer Bildschirm); api: { ticket: async () => WebSocket-Adresse, exit: () => void }
 * Gibt eine Funktion zum Beenden zurück.
 */
export async function start(el, api) {
  const st = {
    alive: true,
    ws: null,
    myId: 0,
    R: 13,
    maxHp: 100,
    fighters: new Map(),
    t: 0,
    sendT: 0,
    lastSend: '',
    lastSendT: 0,
    camYaw: Math.PI,
    camPitch: 0.32,
    stick: { x: 0, y: 0, id: null, ox: 0, oy: 0 },
    keys: new Set(),
    blockHeld: false,
    combo: 0,
    comboT: -9,
    roll: 0,
    rollDir: new THREE.Vector2(),
    shake: 0,
    retry: 0,
    status: 'load',
    lb: [],
  };

  el.innerHTML = `
    <canvas class="ar-cv"></canvas>
    <div class="ar-tags"></div>
    <div class="ar-hud">
      <button class="ar-x" aria-label="Schließen"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="ar-hp"><div class="ar-hp-in"></div><span class="ar-hp-n"></span></div>
      <button class="ar-score-btn" aria-label="Punkte"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 4h8v4a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 12v4M8.5 20h7M10 16h4l.5 4h-5z"/></svg><span class="ar-count"></span></button>
    </div>
    <div class="ar-feed"></div>
    <div class="ar-score" hidden></div>
    <div class="ar-msg"></div>
    <div class="ar-flash"></div>
    <div class="ar-stick"><div class="ar-knob"></div></div>
    <div class="ar-btns">
      <button class="ar-b ar-b-hit" data-k="hit" aria-label="Schlag"><svg viewBox="0 0 24 24"><path d="M7 11V7.5a1.5 1.5 0 0 1 3 0V10m0-1.5V6.5a1.5 1.5 0 0 1 3 0V10m0-2a1.5 1.5 0 0 1 3 0v3m0-1a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-1.5A5.5 5.5 0 0 1 6 14.5V12a1.5 1.5 0 0 1 3 0"/></svg></button>
      <button class="ar-b ar-b-heavy" data-k="heavy" aria-label="Hammer"><svg viewBox="0 0 24 24"><path d="M4 21l9-9M11.5 4.5l3-1.5 6.5 6.5-1.5 3zM10 6l8 8"/></svg></button>
      <button class="ar-b ar-b-block" data-k="block" aria-label="Block"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg></button>
      <button class="ar-b ar-b-roll" data-k="roll" aria-label="Rolle"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-3-6.2M20 4v4.5h-4.5"/></svg></button>
      <button class="ar-b ar-b-emo" data-k="emo" aria-label="Tanzen"><svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg></button>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const canvas = $('.ar-cv');
  const msg = (text, button) => {
    const m = $('.ar-msg');
    m.innerHTML = text ? `<span>${text}</span>${button ? `<button class="ar-retry">${button}</button>` : ''}` : '';
    m.classList.toggle('on', !!text);
  };
  msg('Lade …');
  // Schließen und „Nochmal“ gehen sofort (auch wenn das Laden scheitert)
  let connect = () => {};
  $('.ar-x').addEventListener('click', () => api.exit());
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.ar-retry')) return;
    if (st.status === 'fail') return api.retry();
    st.retry = 0;
    connect();
  });

  // ───── Grafik ─────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 2, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
  const resize = () => {
    const w = el.clientWidth, h = el.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // hochkant: etwas weiter weg und breiter, damit man genug sieht
    camera.fov = w < h ? 62 : 50;
    camera.updateProjectionMatrix();
  };
  resize();
  addEventListener('resize', resize);

  try {
    await loadBase();
  } catch (e) {
    st.status = 'fail';
    msg('Laden fehlgeschlagen', 'Nochmal');
    throw e;
  }
  if (!st.alive) return () => {};
  const sun = buildWorld(scene, st.R);

  const me = () => st.fighters.get(st.myId);
  const tags = $('.ar-tags');
  function addFighter(info) {
    if (st.fighters.has(info.id)) return st.fighters.get(info.id);
    const f = new Fighter(info, scene, info.id === st.myId);
    st.fighters.set(info.id, f);
    if (!f.me) {
      f.tag = document.createElement('div');
      f.tag.className = 'ar-tag';
      f.tag.innerHTML = `<b translate="no"></b><i><s></s></i>`;
      f.tag.querySelector('b').textContent = f.name;
      f.tag.style.setProperty('--c', f.color);
      tags.appendChild(f.tag);
    }
    updateHud();
    return f;
  }
  function dropFighter(id) {
    const f = st.fighters.get(id);
    if (!f) return;
    f.remove(scene);
    st.fighters.delete(id);
    updateHud();
  }

  // ───── HUD ─────
  function updateHud() {
    const m = me();
    if (m) {
      const p = Math.max(0, m.hp / st.maxHp);
      $('.ar-hp-in').style.width = p * 100 + '%';
      $('.ar-hp-in').style.background = p > 0.5 ? '#3fbf62' : p > 0.25 ? '#e9b234' : '#e0503f';
      $('.ar-hp-n').textContent = m.hp;
    }
    $('.ar-count').textContent = st.fighters.size || '';
    const sb = $('.ar-score');
    if (!sb.hidden) {
      const list = [...st.fighters.values()].sort((a, b) => b.k - a.k || a.d - b.d);
      sb.innerHTML = list.map((f) => `<div class="${f.me ? 'me' : ''}"><i style="background:${f.color}"></i><b translate="no"></b><span>${f.k}</span><span>${f.d}</span></div>`).join('');
      sb.querySelectorAll('b').forEach((b, i) => (b.textContent = list[i].name));
      sb.insertAdjacentHTML('afterbegin', '<div class="hd"><i></i><b></b><span>K.o.</span><span>†</span></div>');
      if (st.lb.length) {
        sb.insertAdjacentHTML('beforeend', '<h3>Bestenliste</h3>' + st.lb.map((e, i) => `<div class="lb"><i>${i + 1}</i><b translate="no"></b><span>${e[1]}</span><span>${e[2]}</span></div>`).join(''));
        sb.querySelectorAll('.lb b').forEach((b, i) => (b.textContent = st.lb[i][0]));
      }
    }
  }
  function feed(a, v) {
    const line = document.createElement('div');
    line.innerHTML = `<b translate="no"></b><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 20l9-9M12 4l8 8-3 3-8-8z"/></svg><b translate="no"></b>`;
    const [x, y] = line.querySelectorAll('b');
    x.textContent = a ? a.name : '?';
    x.style.color = a ? a.color : '';
    y.textContent = v ? v.name : '?';
    y.style.color = v ? v.color : '';
    $('.ar-feed').prepend(line);
    setTimeout(() => line.remove(), 5000);
    while ($('.ar-feed').children.length > 4) $('.ar-feed').lastChild.remove();
  }
  const pops = [];
  function popNumber(f, text, cls) {
    const d = document.createElement('div');
    d.className = 'ar-pop ' + cls;
    d.textContent = text;
    tags.appendChild(d);
    pops.push({ el: d, f, t: st.t, x: (Math.random() - 0.5) * 0.4 });
  }
  // Funken an der Trefferstelle
  const sparkGeo = new THREE.SphereGeometry(0.04, 4, 3);
  const sparks = [];
  function burst(f, color) {
    const at = new THREE.Vector3(f.pos.x, 1.3, f.pos.z);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
      m.position.copy(at);
      scene.add(m);
      sparks.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5), t: st.t });
    }
  }

  // ───── Verbindung ─────
  const send = (o) => st.ws && st.ws.readyState === 1 && st.ws.send(JSON.stringify(o));
  connect = async () => {
    if (!st.alive) return;
    st.status = 'conn';
    msg('Verbinde …');
    let url;
    try {
      url = await api.ticket();
    } catch (e) {
      msg(e && e.status === 403 ? 'Erst anmelden' : 'Keine Verbindung', 'Nochmal');
      return;
    }
    if (!st.alive) return;
    const ws = new WebSocket(url);
    st.ws = ws;
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      if (st.ws !== ws) return;
      st.ws = null;
      for (const id of [...st.fighters.keys()]) dropFighter(id);
      if (!st.alive || st.status === 'raus') return;
      // kurz weg (Funkloch): von selbst neu verbinden, dann mit Knopf
      if (st.retry++ < 3) setTimeout(connect, 1000 * st.retry);
      else msg('Keine Verbindung', 'Nochmal');
    };
  };
  function onMsg(d) {
    const f = d.id != null ? st.fighters.get(d.id) : null;
    switch (d.t) {
      case 'hi':
        st.myId = d.id;
        st.R = d.r;
        st.maxHp = d.hp;
        st.retry = 0;
        st.status = 'on';
        st.lb = d.lb || [];
        for (const p of d.players) addFighter(p);
        st.camYaw = me().yaw;
        msg('');
        break;
      case 'join':
        addFighter(d.p);
        break;
      case 'left':
        dropFighter(d.id);
        break;
      case 'voll':
        st.status = 'raus';
        msg('Arena voll', 'Nochmal');
        break;
      case 'raus':
        st.status = 'raus';
        msg(d.why === 'doppelt' ? 'Auf einem anderen Gerät geöffnet' : 'Getrennt', 'Nochmal');
        break;
      case 'w':
        for (const [id, x, z, r, m, b, hp] of d.s) {
          const g = st.fighters.get(id);
          if (!g) continue;
          g.hp = hp;
          if (g.me) continue;
          g.snaps.push([performance.now() / 1000, x, z, r]);
          if (g.snaps.length > 12) g.snaps.shift();
          g.m = m;
          g.block = !!b;
          if (m) g.dance = false;
        }
        updateHud();
        break;
      case 'lb':
        st.lb = d.lb;
        updateHud();
        break;
      case 'atk':
        if (f && !f.dead) {
          f.one(d.k, st.t);
          sound('whoosh', 0.5);
        }
        break;
      case 'roll':
        if (f && !f.dead) f.one('roll', st.t);
        break;
      case 'emo':
        if (f) f.dance = true;
        break;
      case 'hit': {
        const v = st.fighters.get(d.v), a = st.fighters.get(d.a);
        if (!v) break;
        v.hp = d.hp;
        const near = me() && (v.me || a?.me) ? 1 : 0.5;
        sound(d.b ? 'block' : 'hit', near);
        burst(v, d.b ? '#cfe3ff' : '#ffb347');
        popNumber(v, d.b ? '−' + d.d : d.d, d.b ? 'blk' : d.k === 'heavy' ? 'big' : '');
        if (!d.b && d.hp > 0 && v.oneKind !== 'heavy') v.one(Math.random() < 0.5 ? 'hitHead' : 'hitChest', st.t);
        if (v.me) {
          v.push.set(v.push.x + d.px, v.push.y + d.pz);
          st.shake = d.b ? 0.1 : d.k === 'heavy' ? 0.45 : 0.22;
          if (!d.b) {
            const fl = $('.ar-flash');
            fl.classList.remove('on');
            void fl.offsetWidth;
            fl.classList.add('on');
            navigator.vibrate?.(40);
          }
        }
        updateHud();
        break;
      }
      case 'die': {
        const v = st.fighters.get(d.v), a = st.fighters.get(d.a);
        if (v) {
          v.d = d.d;
          v.die();
        }
        if (a) a.k = d.k;
        sound('ko', v && v.me ? 1 : 0.5);
        feed(a, v);
        if (v && v.me) msg('K.o.');
        updateHud();
        break;
      }
      case 'spawn':
        if (f) {
          f.spawn(d.x, d.z, d.r, d.hp);
          if (f.me) {
            msg('');
            st.camYaw = d.r;
            st.roll = 0;
          }
        }
        updateHud();
        break;
    }
  }

  // ───── Eingabe ─────
  const stick = $('.ar-stick'), knob = $('.ar-knob');
  const STICK_R = 52;
  let camTouch = null;
  const unlockAudio = () => {
    if (!audio) {
      try {
        audio = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
    }
    audio?.state === 'suspended' && audio.resume();
  };
  function onDown(e) {
    unlockAudio();
    const b = e.target.closest('.ar-b');
    if (b) {
      e.preventDefault();
      b.classList.add('on');
      press(b.dataset.k, true, e.pointerId);
      return;
    }
    if (e.target.closest('button, .ar-score')) return;
    e.preventDefault();
    // linke Hälfte: Steuerkreuz dort, wo der Finger aufsetzt; rechts: Kamera drehen
    if (e.clientX < el.clientWidth * 0.45 && st.stick.id == null) {
      st.stick.id = e.pointerId;
      st.stick.ox = e.clientX;
      st.stick.oy = e.clientY;
      stick.style.transform = `translate(${e.clientX - 70}px, ${e.clientY - 70}px)`;
      stick.classList.add('on');
      knob.style.transform = '';
    } else if (camTouch == null) {
      camTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  }
  function onMove(e) {
    if (e.pointerId === st.stick.id) {
      let dx = e.clientX - st.stick.ox, dy = e.clientY - st.stick.oy;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) {
        dx *= STICK_R / len;
        dy *= STICK_R / len;
      }
      st.stick.x = dx / STICK_R;
      st.stick.y = dy / STICK_R;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (camTouch && e.pointerId === camTouch.id) {
      st.camYaw -= (e.clientX - camTouch.x) * 0.008;
      st.camPitch = Math.max(0.05, Math.min(0.9, st.camPitch + (e.clientY - camTouch.y) * 0.004));
      camTouch.x = e.clientX;
      camTouch.y = e.clientY;
    }
  }
  function onUp(e) {
    if (e.pointerId === st.stick.id) {
      st.stick.id = null;
      st.stick.x = st.stick.y = 0;
      stick.classList.remove('on');
    }
    if (camTouch && e.pointerId === camTouch.id) camTouch = null;
    el.querySelectorAll('.ar-b.on').forEach((b) => {
      if (b.dataset.pid == e.pointerId) {
        b.classList.remove('on');
        press(b.dataset.k, false);
      }
    });
  }
  function press(k, down, pid) {
    const b = el.querySelector(`.ar-b[data-k="${k}"]`);
    if (b && pid != null) b.dataset.pid = pid;
    if (k === 'block') st.blockHeld = down;
    if (!down) return;
    if (k === 'hit') attack(st.t - st.comboT < 0.75 && st.combo === 1 ? 'cross' : 'jab');
    else if (k === 'heavy') attack('heavy');
    else if (k === 'roll') roll();
    else if (k === 'emo') {
      const m = me();
      if (m && !m.dead) {
        m.dance = true;
        send({ t: 'emo' });
      }
    }
  }
  const keyMap = { KeyJ: 'hit', KeyK: 'heavy', KeyL: 'block', Space: 'roll', KeyE: 'emo' };
  const onKey = (e) => {
    const down = e.type === 'keydown';
    if (keyMap[e.code]) {
      e.preventDefault();
      if (down && e.repeat) return;
      press(keyMap[e.code], down);
    }
    if (down) st.keys.add(e.code);
    else st.keys.delete(e.code);
  };
  el.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKey);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  $('.ar-score-btn').addEventListener('click', () => {
    $('.ar-score').hidden = !$('.ar-score').hidden;
    updateHud();
  });
  $('.ar-score').addEventListener('click', () => ($('.ar-score').hidden = true));

  /** Nächster Gegner vor einem (zum Ausrichten beim Schlag), sonst null */
  function target(m, range) {
    let best = null, bd = range;
    for (const f of st.fighters.values()) {
      if (f === m || f.dead) continue;
      const d = Math.hypot(f.pos.x - m.pos.x, f.pos.z - m.pos.z);
      const a = Math.abs(angDiff(Math.atan2(f.pos.x - m.pos.x, f.pos.z - m.pos.z), m.yaw));
      if (d < bd && a < 1.9) {
        bd = d;
        best = f;
      }
    }
    return best;
  }
  function attack(k) {
    const m = me();
    if (!m || m.dead || st.t < m.busy || st.roll > 0) return;
    const tg = target(m, k === 'heavy' ? 3.4 : 2.8);
    if (tg) m.yaw = Math.atan2(tg.pos.x - m.pos.x, tg.pos.z - m.pos.z);
    st.combo = k === 'jab' ? 1 : 0;
    st.comboT = st.t;
    m.one(k, st.t);
    sound('whoosh', 0.8);
    send({ t: 'atk', k, r: +m.yaw.toFixed(3) });
  }
  function roll() {
    const m = me();
    if (!m || m.dead || st.t < m.busy - 0.15 || st.roll > 0) return;
    const mv = moveInput();
    const yaw = mv.lengthSq() > 0.01 ? Math.atan2(mv.x, mv.y) : m.yaw;
    m.yaw = yaw;
    st.rollDir.set(Math.sin(yaw), Math.cos(yaw));
    st.roll = ROLL_TIME;
    m.one('roll', st.t);
    send({ t: 'roll' });
  }
  /** Richtung in der Welt aus Steuerkreuz bzw. Tasten, relativ zur Kamera */
  function moveInput() {
    let x = st.stick.x, y = st.stick.y;
    const k = st.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    let len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
      len = 1;
    }
    if (k.has('ShiftLeft') && len > 0) {
      x /= len;
      y /= len;
    }
    const a = st.camYaw, fx = Math.sin(a), fz = Math.cos(a);
    // vorne = von der Kamera weg; rechts = (−cos, sin)
    return new THREE.Vector2(fx * -y + -fz * x, fz * -y + fx * x);
  }

  // ───── Schleife ─────
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  const camPos = new THREE.Vector3(0, 6, -10);
  let raf = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    st.t += dt;
    const m = me();
    if (m && !m.dead) {
      m.block = st.blockHeld && st.roll <= 0 && st.t >= m.busy;
      const mv = moveInput();
      const amt = Math.min(1, mv.length());
      let speed = 0;
      if (st.roll > 0) {
        st.roll -= dt;
        m.pos.x += st.rollDir.x * ROLL_SPEED * dt * Math.min(1, st.roll / ROLL_TIME + 0.3);
        m.pos.z += st.rollDir.y * ROLL_SPEED * dt * Math.min(1, st.roll / ROLL_TIME + 0.3);
        m.m = 0;
      } else if (amt > 0.12) {
        const sprint = amt > 0.92 && !m.block;
        speed = m.block ? SPEED_BLOCK : sprint ? SPEED_SPRINT : SPEED_JOG * Math.max(0.45, amt);
        if (st.t < m.busy) speed *= 0.15;
        m.pos.x += (mv.x / amt) * speed * dt;
        m.pos.z += (mv.y / amt) * speed * dt;
        if (st.t >= m.busy && !m.block) m.yaw += angDiff(Math.atan2(mv.x, mv.y), m.yaw) * Math.min(1, dt * 14);
        m.m = st.t < m.busy ? 0 : sprint ? 2 : 1;
        m.dance = false;
      } else m.m = 0;
      // Rückstoß
      m.pos.x += m.push.x * dt;
      m.pos.z += m.push.y * dt;
      m.push.multiplyScalar(Math.exp(-dt * 5));
      // nicht durch andere hindurch
      for (const f of st.fighters.values()) {
        if (f === m || f.dead) continue;
        const dx = m.pos.x - f.pos.x, dz = m.pos.z - f.pos.z, d = Math.hypot(dx, dz);
        if (d < BODY_R * 2 && d > 0.001) {
          m.pos.x += (dx / d) * (BODY_R * 2 - d);
          m.pos.z += (dz / d) * (BODY_R * 2 - d);
        }
      }
      const len = Math.hypot(m.pos.x, m.pos.z);
      if (len > st.R) m.pos.multiplyScalar(st.R / len);
      m.place();
      // Stand melden (unverändert nur jede Sekunde als Lebenszeichen)
      st.sendT += dt;
      if (st.sendT >= SEND_GAP) {
        st.sendT = 0;
        const s = JSON.stringify({ t: 's', x: +m.pos.x.toFixed(2), z: +m.pos.z.toFixed(2), r: +m.yaw.toFixed(2), m: m.m, b: m.block ? 1 : 0 });
        if (s !== st.lastSend || st.t - st.lastSendT > 1) {
          st.ws && st.ws.readyState === 1 && st.ws.send(s);
          st.lastSend = s;
          st.lastSendT = st.t;
        }
      }
    }
    // Kollegen: zwischen den letzten Meldungen gleiten
    const now = performance.now() / 1000 - INTERP;
    for (const f of st.fighters.values()) {
      if (!f.me && f.snaps.length) {
        const s = f.snaps;
        let i = s.length - 1;
        while (i > 0 && s[i - 1][0] > now) i--;
        const b = s[i], a = s[Math.max(0, i - 1)];
        const k = b[0] === a[0] ? 1 : Math.max(0, Math.min(1, (now - a[0]) / (b[0] - a[0])));
        const tx = a[1] + (b[1] - a[1]) * k, tz = a[2] + (b[2] - a[2]) * k;
        f.pos.set(tx, 0, tz);
        f.yaw += angDiff(a[3] + angDiff(b[3], a[3]) * k, f.yaw) * Math.min(1, dt * 15);
        f.place();
      }
      f.pose(st.t);
      f.mixer.update(dt);
    }
    // Kamera hinter der eigenen Figur
    const focus = m ? m.pos : tmp.set(0, 0, 0);
    const dist = camera.aspect < 1 ? 6.8 : 5.6;
    const want = new THREE.Vector3(
      focus.x - Math.sin(st.camYaw) * dist * Math.cos(st.camPitch),
      1.2 + Math.sin(st.camPitch) * dist + 0.6,
      focus.z - Math.cos(st.camYaw) * dist * Math.cos(st.camPitch)
    );
    camPos.lerp(want, Math.min(1, dt * 10));
    camera.position.copy(camPos);
    if (st.shake > 0) {
      st.shake = Math.max(0, st.shake - dt);
      camera.position.x += (Math.random() - 0.5) * st.shake * 0.5;
      camera.position.y += (Math.random() - 0.5) * st.shake * 0.5;
    }
    camera.lookAt(focus.x, 1.25, focus.z);
    sun.position.set(focus.x + 12, 22, focus.z + 8);
    sun.target.position.set(focus.x, 0, focus.z);
    sun.target.updateMatrixWorld();
    // Funken
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i], age = st.t - s.t;
      s.v.y -= 12 * dt;
      s.m.position.addScaledVector(s.v, dt);
      s.m.material.opacity = 1 - age / 0.45;
      if (age > 0.45) {
        scene.remove(s.m);
        s.m.material.dispose();
        sparks.splice(i, 1);
      }
    }
    renderer.render(scene, camera);
    // Namen über den Köpfen, Schadenszahlen
    const w = el.clientWidth, h = el.clientHeight;
    for (const f of st.fighters.values()) {
      if (!f.tag) continue;
      tmp.set(f.pos.x, 2.05, f.pos.z).project(camera);
      const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2;
      f.tag.style.display = vis ? '' : 'none';
      if (!vis) continue;
      f.tag.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -100%)`;
      f.tag.querySelector('s').style.width = Math.max(0, (f.hp / st.maxHp) * 100) + '%';
      f.tag.classList.toggle('dead', f.dead);
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i], age = st.t - p.t;
      tmp.set(p.f.pos.x + p.x, 1.9 + age * 1.2, p.f.pos.z).project(camera);
      p.el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -50%)`;
      p.el.style.opacity = String(Math.max(0, 1 - age / 0.9));
      if (age > 0.9) {
        p.el.remove();
        pops.splice(i, 1);
      }
    }
  }
  frame();
  // nur für Tests (Testseite übergibt debug)
  api.debug?.({ st, scene, camera, renderer, step: (n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) { clock.getDelta = () => dt; frame(); cancelAnimationFrame(raf); } } });

  // App im Hintergrund: Verbindung trennen (iOS hält sie ohnehin nicht), beim Zurückkommen neu
  const onVis = () => {
    if (document.hidden) {
      const ws = st.ws;
      st.ws = null;
      ws?.close();
      for (const id of [...st.fighters.keys()]) dropFighter(id);
      cancelAnimationFrame(raf);
    } else if (st.alive) {
      clock.getDelta();
      frame();
      if (!st.ws && st.status !== 'raus') {
        st.retry = 0;
        connect();
      }
    }
  };
  document.addEventListener('visibilitychange', onVis);

  connect();

  return function stop() {
    st.alive = false;
    cancelAnimationFrame(raf);
    const ws = st.ws;
    st.ws = null;
    ws?.close();
    for (const id of [...st.fighters.keys()]) dropFighter(id);
    removeEventListener('resize', resize);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKey);
    document.removeEventListener('visibilitychange', onVis);
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) [].concat(o.material).forEach((mt) => (mt.map?.dispose(), mt.dispose()));
    });
    renderer.dispose();
    renderer.forceContextLoss?.();
    el.innerHTML = '';
  };
}
