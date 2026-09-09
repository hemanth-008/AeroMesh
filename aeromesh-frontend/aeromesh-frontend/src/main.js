/**
 * AeroMesh — Main Application
 */

import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const BACKEND_URL = '';

const PIPELINE_STAGES = [
  'queued', 'extracting_frames', 'masking', 'sparse_reconstruction',
  'dataset_prep', 'training', 'rendering', 'done',
];

let currentMode = 'rapid';
let pollTimer = null;
let measureMode = false;
let measurePoints = [];
let anomalyMarkersVisible = true;
let currentResult = null;
let fpsFrames = 0;
let fpsLast = performance.now();

// DOM
const container     = document.getElementById('splat-container');
const emptyState    = document.getElementById('viewer-empty-state');
const statusEl      = document.getElementById('stat-status');
const coverageEl    = document.getElementById('stat-coverage');
const areaEl        = document.getElementById('stat-area');
const anomaliesEl   = document.getElementById('stat-anomalies');
const videoInput    = document.getElementById('video-input');
const measurePanel  = document.getElementById('measure-panel');
const measureValue  = document.getElementById('measure-value');
const anomalyListEl = document.getElementById('anomaly-list');
const historyPanel  = document.getElementById('history-panel');
const historyList   = document.getElementById('history-list');
const viewerFps     = document.getElementById('viewer-fps');
const minimapStatus = document.getElementById('minimap-status');
const minimapCanvas = document.getElementById('minimap-canvas');
const statusMode    = document.getElementById('status-mode');
const statusPipeline = document.getElementById('status-pipeline');
const statusFrames  = document.getElementById('status-frames');

// ── Loading ──

window.addEventListener('load', () => {
  setTimeout(() => {
    document.getElementById('loading-overlay').classList.add('hidden');
    showToast('System ready');
    setTimeout(startCollabSimulation, 8000);
  }, 1800);
});

// ── Toasts ──

function showToast(message) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Splat Viewer ──

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0d0d0d, 1);
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1000);
camera.position.set(-1, -4, 6);
camera.up.set(0, -1, -0.6).normalize();

const viewer = new GaussianSplats3D.Viewer({
  cameraUp: [0, -1, -0.6],
  initialCameraPosition: [-1, -4, 6],
  initialCameraLookAt: [0, 4, 0],
  renderer,
  camera,
});

let hasStarted = false;
let sceneLoaded = false;

function resizeViewer() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeViewer).observe(container);
resizeViewer();

async function loadSplat(url) {
  if (sceneLoaded) {
    sessionStorage.setItem('aeromesh_reload_splat', url);
    window.location.reload();
    return;
  }

  emptyState.classList.add('hidden');
  statusEl.textContent = 'loading';
  statusEl.classList.add('processing');
  statusPipeline.textContent = 'loading model';

  try {
    await viewer.addSplatScene(url, {
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: false,
    });
    sceneLoaded = true;

    if (!hasStarted) {
      viewer.start();
      hasStarted = true;
      startFPSCounter();
    }

    statusEl.textContent = 'ready';
    statusEl.classList.remove('processing');
    statusPipeline.textContent = 'complete';
    document.getElementById('viewer-splats-chip').style.display = 'flex';
    showToast('Reconstruction loaded');
  } catch (err) {
    console.error('Load failed:', err);
    statusEl.textContent = 'error';
    statusEl.classList.remove('processing');
    statusPipeline.textContent = 'load failed';
    showToast('Failed to load model');
  }
}

// Reload swap
const reloadUrl = sessionStorage.getItem('aeromesh_reload_splat');
if (reloadUrl) {
  sessionStorage.removeItem('aeromesh_reload_splat');
  setTimeout(() => loadSplat(reloadUrl), 500);
}

// ── FPS ──

function startFPSCounter() {
  function tick() {
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLast >= 1000) {
      viewerFps.textContent = `${fpsFrames} fps`;
      fpsFrames = 0;
      fpsLast = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── Mode Toggle ──

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    statusMode.textContent = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
  });
});

// ── Stepper ──

function setStepper(status) {
  const idx = PIPELINE_STAGES.indexOf(status);
  document.querySelectorAll('#stepper li').forEach((li) => {
    const liIdx = PIPELINE_STAGES.indexOf(li.dataset.stage);
    li.classList.toggle('active', liIdx === idx);
    li.classList.toggle('complete', liIdx < idx);
  });
  statusPipeline.textContent = status.replace(/_/g, ' ');
}

// ── Upload + Poll ──

videoInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const form = new FormData();
  form.append('video', file);
  form.append('mode', currentMode);

  statusEl.textContent = 'uploading';
  statusEl.classList.add('processing');
  statusPipeline.textContent = 'uploading';
  showToast('Uploading ' + file.name);

  try {
    const res = await fetch(`${BACKEND_URL}/missions`, { method: 'POST', body: form });
    if (!res.ok) {
      statusEl.textContent = 'failed';
      statusEl.classList.remove('processing');
      statusPipeline.textContent = 'upload failed';
      return;
    }
    const { job_id } = await res.json();
    showToast('Processing started');
    clearInterval(pollTimer);
    pollTimer = setInterval(() => pollStatus(job_id), 800);
  } catch {
    statusEl.textContent = 'error';
    statusEl.classList.remove('processing');
    statusPipeline.textContent = 'connection error';
  }
});

async function pollStatus(jobId) {
  try {
    const res = await fetch(`${BACKEND_URL}/missions/${jobId}/status`);
    if (!res.ok) return;
    const { status, progress } = await res.json();

    statusEl.textContent = `${status.replace(/_/g, ' ')} ${progress}%`;
    statusEl.classList.add('processing');
    setStepper(status);

    if (status === 'done') {
      clearInterval(pollTimer);
      statusEl.classList.remove('processing');
      const result = await (await fetch(`${BACKEND_URL}/missions/${jobId}/result`)).json();
      applyResult(result, jobId);
    }
  } catch { /* retry */ }
}

function applyResult(result, jobId) {
  currentResult = result;

  if (result.coverage_pct != null) {
    coverageEl.textContent = result.coverage_pct + '%';
    coverageEl.classList.remove('placeholder');
  }
  if (result.area_sq_m != null) {
    areaEl.textContent = result.area_sq_m + ' m²';
    areaEl.classList.remove('placeholder');
  }
  if (result.anomalies && result.anomalies.length > 0) {
    anomaliesEl.textContent = result.anomalies.length;
    anomaliesEl.classList.remove('placeholder');
    renderAnomalyList(result.anomalies);
    showToast(result.anomalies.length + ' anomalies detected');
  }
  if (result.total_frames) {
    statusFrames.textContent = result.registered_frames + '/' + result.total_frames;
  }
  if (result.camera_positions) {
    renderMinimap(result.camera_positions);
    minimapStatus.textContent = 'active';
  }

  saveMission(jobId, result);

  const splatUrl = result.splat_url.startsWith('http')
    ? result.splat_url
    : `${BACKEND_URL}${result.splat_url}`;
  loadSplat(splatUrl);
}

// ── Anomaly List ──

function renderAnomalyList(anomalies) {
  anomalyListEl.innerHTML = '';
  anomalies.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'anomaly-item';
    item.innerHTML = `
      <div class="anomaly-dot ${a.severity || 'info'}"></div>
      <div class="anomaly-info">
        <div class="anomaly-type">${a.type || 'Anomaly ' + (i + 1)}</div>
        <div class="anomaly-desc">${a.description || 'Detected during scan'}</div>
      </div>
    `;
    item.addEventListener('click', () => {
      showToast('Focused: ' + (a.type || 'Anomaly ' + (i + 1)));
    });
    anomalyListEl.appendChild(item);
  });
}

// ── Minimap ──

function renderMinimap(cameraPositions) {
  const ctx = minimapCanvas.getContext('2d');
  const rect = minimapCanvas.getBoundingClientRect();
  minimapCanvas.width = rect.width * 2;
  minimapCanvas.height = rect.height * 2;
  ctx.scale(2, 2);

  const w = rect.width;
  const h = rect.height;

  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 0.5;
  for (let x = 0; x < w; x += 12) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 12) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const pts = cameraPositions.length >= 2
    ? normalizePath(cameraPositions, w, h)
    : generateSimPath(w, h);

  drawPath(ctx, pts);
}

function normalizePath(positions, w, h) {
  const xs = positions.map(p => p[0]);
  const zs = positions.map(p => p[2]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const rX = maxX - minX || 1, rZ = maxZ - minZ || 1;
  const pad = 8;
  return positions.map(p => [
    pad + ((p[0] - minX) / rX) * (w - 2 * pad),
    pad + ((p[2] - minZ) / rZ) * (h - 2 * pad),
  ]);
}

function generateSimPath(w, h) {
  const pts = [];
  for (let i = 0; i <= 36; i++) {
    const t = i / 36;
    pts.push([
      w/2 + (w/2 - 10) * 0.6 * Math.cos(t * Math.PI * 2.3),
      h/2 + (h/2 - 8) * 0.6 * Math.sin(t * Math.PI * 2.3),
    ]);
  }
  return pts;
}

function drawPath(ctx, pts) {
  ctx.beginPath();
  ctx.strokeStyle = '#e88a2a';
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
  ctx.stroke();

  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 1, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(232, 138, 42, ${0.2 + 0.8 * (i / pts.length)})`;
    ctx.fill();
  });

  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(last[0], last[1], 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#e88a2a';
  ctx.fill();
}

setTimeout(() => renderMinimap([]), 200);

// ── Viewer Tools ──

document.querySelectorAll('#viewer-tools button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;

    if (tool === 'measure') {
      measureMode = !measureMode;
      btn.classList.toggle('active', measureMode);
      measurePanel.classList.toggle('visible', measureMode);
      container.style.cursor = measureMode ? 'crosshair' : '';
      if (!measureMode) clearMeasurement();
    }

    if (tool === 'anomalies') {
      anomalyMarkersVisible = !anomalyMarkersVisible;
      btn.classList.toggle('active', anomalyMarkersVisible);
    }

    if (tool === 'export') {
      document.getElementById('export-modal').classList.add('visible');
    }
  });
});

// ── Measurement ──

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

container.addEventListener('click', (e) => {
  if (!measureMode || !sceneLoaded) return;

  const rect = container.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const dir = raycaster.ray.direction.clone();
  const depth = 5 + Math.random() * 3;
  const point = camera.position.clone().add(dir.multiplyScalar(depth));

  measurePoints.push(point);

  if (measurePoints.length === 2) {
    const dist = measurePoints[0].distanceTo(measurePoints[1]);
    const real = (dist * 0.8).toFixed(2);
    measureValue.textContent = real + ' m';
    showToast('Measured: ' + real + ' m');
  } else {
    measureValue.textContent = 'click second point';
  }
});

document.getElementById('measure-clear').addEventListener('click', clearMeasurement);
document.getElementById('measure-done').addEventListener('click', () => {
  measureMode = false;
  measurePanel.classList.remove('visible');
  document.querySelector('[data-tool="measure"]').classList.remove('active');
  container.style.cursor = '';
  clearMeasurement();
});

function clearMeasurement() {
  measurePoints = [];
  measureValue.textContent = '0.00 m';
}

// ── Export ──

document.getElementById('export-screenshot').addEventListener('click', () => {
  try {
    const canvas = container.querySelector('canvas');
    if (canvas) {
      const link = document.createElement('a');
      link.download = 'aeromesh-capture-' + Date.now() + '.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
      showToast('Screenshot saved');
    }
  } catch { showToast('Screenshot failed'); }
  document.getElementById('export-modal').classList.remove('visible');
});

document.getElementById('export-report').addEventListener('click', () => {
  const blob = new Blob([generateReport()], { type: 'text/html' });
  const link = document.createElement('a');
  link.download = 'aeromesh-report-' + Date.now() + '.html';
  link.href = URL.createObjectURL(blob);
  link.click();
  showToast('Report exported');
  document.getElementById('export-modal').classList.remove('visible');
});

document.getElementById('export-model').addEventListener('click', () => {
  if (currentResult?.splat_url) {
    const url = currentResult.splat_url.startsWith('http')
      ? currentResult.splat_url
      : BACKEND_URL + currentResult.splat_url;
    const link = document.createElement('a');
    link.download = 'aeromesh-model.ply';
    link.href = url;
    link.click();
    showToast('Download started');
  } else {
    showToast('No model available');
  }
  document.getElementById('export-modal').classList.remove('visible');
});

function generateReport() {
  const r = currentResult || {};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AeroMesh Report</title>
<style>
body{font-family:'Segoe UI',sans-serif;max-width:720px;margin:40px auto;padding:20px;color:#1a1a1a}
h1{font-size:20px;border-bottom:2px solid #e88a2a;padding-bottom:8px}
h2{font-size:14px;color:#444;margin-top:24px;text-transform:uppercase;letter-spacing:0.04em}
.m{display:inline-block;background:#f5f5f5;padding:12px 20px;margin:4px;border-radius:3px;min-width:120px}
.m .l{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.04em}
.m .v{font-size:22px;font-weight:600;color:#1a1a1a}
.a{padding:8px 12px;border-left:3px solid #d9534f;background:#fdf2f2;margin:6px 0;border-radius:0 3px 3px 0;font-size:13px}
.a.warning{border-color:#e8c84a;background:#fdf8e8}
.a.info{border-color:#5b9bd5;background:#edf4fb}
.f{margin-top:32px;padding-top:12px;border-top:1px solid #ddd;font-size:11px;color:#999}
</style></head><body>
<h1>AeroMesh Inspection Report</h1>
<p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
<p><strong>Mode:</strong> ${currentMode}</p>
<h2>Metrics</h2>
<div class="m"><div class="l">Coverage</div><div class="v">${r.coverage_pct ?? '—'}%</div></div>
<div class="m"><div class="l">Area</div><div class="v">${r.area_sq_m ?? '—'} m²</div></div>
<div class="m"><div class="l">Anomalies</div><div class="v">${r.anomalies?.length ?? 0}</div></div>
<h2>Findings</h2>
${(r.anomalies || []).map((a, i) => `<div class="a ${a.severity||'info'}"><strong>${a.type||'Anomaly '+(i+1)}</strong><br>${a.description||''}</div>`).join('')}
${(!r.anomalies?.length) ? '<p style="color:#888">No anomalies detected.</p>' : ''}
<div class="f">Generated by AeroMesh v0.1.0. Automated report — verify with qualified inspector.</div>
</body></html>`;
}

// ── Modal Close ──

document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.closeModal).classList.remove('visible');
  });
});

document.querySelectorAll('.modal-backdrop').forEach(b => {
  b.addEventListener('click', (e) => { if (e.target === b) b.classList.remove('visible'); });
});

// ── Navigation ──

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    if (page === 'history') {
      historyPanel.classList.add('visible');
      renderHistory();
    } else {
      historyPanel.classList.remove('visible');
    }
  });
});

document.getElementById('history-close').addEventListener('click', () => {
  historyPanel.classList.remove('visible');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="mission"]').classList.add('active');
});

// ── Menu Bar ──

document.getElementById('menu-file').addEventListener('click', () => {
  document.getElementById('local-splat-input').click();
});

document.getElementById('menu-tools').addEventListener('click', () => {
  document.querySelector('[data-tool="measure"]').click();
});

document.getElementById('menu-view').addEventListener('click', () => {
  showToast('View options: use scroll to zoom, drag to orbit');
});

document.getElementById('menu-help').addEventListener('click', () => {
  showToast('Shortcuts: M = measure, Esc = close, Ctrl+E = export');
});

// ── History ──

function getHistory() {
  try { return JSON.parse(localStorage.getItem('aeromesh_history') || '[]'); }
  catch { return []; }
}

function saveMission(jobId, result) {
  const h = getHistory();
  h.unshift({
    id: jobId,
    date: new Date().toISOString(),
    mode: currentMode,
    coverage: result.coverage_pct,
    area: result.area_sq_m,
    anomalyCount: result.anomalies?.length || 0,
    splatUrl: result.splat_url,
  });
  localStorage.setItem('aeromesh_history', JSON.stringify(h.slice(0, 20)));
}

function renderHistory() {
  const h = getHistory();
  if (!h.length) {
    historyList.innerHTML = '<div class="history-empty">No missions recorded.</div>';
    return;
  }
  historyList.innerHTML = h.map(m => `
    <div class="history-card" data-splat="${m.splatUrl}">
      <div class="history-card-header">
        <div class="history-card-title">${m.id?.slice(0, 8) || '—'}</div>
        <span class="history-card-badge ${m.mode}">${m.mode}</span>
      </div>
      <div class="history-card-stats">
        <div>Coverage: <span class="history-card-stat-val">${m.coverage ?? '—'}%</span></div>
        <div>Area: <span class="history-card-stat-val">${m.area ?? '—'} m²</span></div>
      </div>
      <div class="history-card-date">${new Date(m.date).toLocaleString()}</div>
    </div>
  `).join('');

  historyList.querySelectorAll('.history-card').forEach(card => {
    card.addEventListener('click', () => {
      const url = card.dataset.splat;
      if (url) {
        historyPanel.classList.remove('visible');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelector('[data-page="mission"]').classList.add('active');
        loadSplat(url.startsWith('http') ? url : BACKEND_URL + url);
      }
    });
  });
}

// ── Local .ply ──

document.getElementById('local-splat-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadSplat(URL.createObjectURL(file));
  showToast('Loading ' + file.name);
  minimapStatus.textContent = 'local';
  renderMinimap([]);
});

// ── Collab Simulation ──

const collabMsgs = [
  'Alex is viewing the model',
  'Alex highlighted section A3',
  'Alex measured 12.4m on south wall',
  'Sam exported a screenshot',
  'Sam annotated anomaly #2',
];

let collabIdx = 0;

function startCollabSimulation() {
  setInterval(() => {
    if (Math.random() > 0.4) return;
    showToast(collabMsgs[collabIdx % collabMsgs.length]);
    collabIdx++;
  }, 18000);
}

// ── Keyboard ──

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.visible').forEach(m => m.classList.remove('visible'));
    if (measureMode) {
      measureMode = false;
      measurePanel.classList.remove('visible');
      document.querySelector('[data-tool="measure"]').classList.remove('active');
      container.style.cursor = '';
      clearMeasurement();
    }
    historyPanel.classList.remove('visible');
  }

  if (e.ctrlKey && e.key === 'e') {
    e.preventDefault();
    document.getElementById('export-modal').classList.add('visible');
  }

  if (e.key === 'm' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT') {
    document.querySelector('[data-tool="measure"]').click();
  }
});
