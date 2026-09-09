"""
AeroMesh backend — Full Demo Build.

DEMO_MODE = True (default):
    Every mission is simulated. You upload a video, get a job_id, watch it
    move through realistic pipeline stages, and land on the pre-baked result
    with mock anomalies, coverage stats, and camera positions.

DEMO_MODE = False:
    Replace the body of `_run_real_pipeline()` with a call into your actual
    pipeline code (frame extraction -> masking -> HLOC -> ns-train ->
    ns-export -> measurement layer).

Run with:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000
"""

import shutil
import threading
import time
import uuid
import math
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

DEMO_MODE = True

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
FRONTEND_DIR = BASE_DIR / "static"  # Built frontend files go here
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="AeroMesh API", description="Drone-based 3D infrastructure inspection")

# CORS — wide open for dev. Tighten before deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve output files (splats, renders, etc.)
app.mount("/outputs", StaticFiles(directory=OUTPUT_DIR), name="outputs")

# In-memory job store
JOBS: Dict[str, dict] = {}

PIPELINE_STAGES = [
    "queued",
    "extracting_frames",
    "masking",
    "sparse_reconstruction",
    "dataset_prep",
    "training",
    "rendering",
    "done",
]

# ─── Mock anomalies for demo ───
# These simulate what a real anomaly detection system (Phase 9) would find
# during a building/infrastructure inspection scan.
MOCK_ANOMALIES = [
    {
        "id": "A001",
        "type": "Surface Crack",
        "severity": "critical",
        "description": "Linear crack detected on south-facing wall, ~2.3m length, possible structural concern",
        "recommendation": "Schedule immediate structural assessment",
        "position": [1.2, -0.8, 3.5],
        "confidence": 0.94,
    },
    {
        "id": "A002",
        "type": "Thermal Anomaly",
        "severity": "warning",
        "description": "Heat signature deviation on northwest rooftop section, potential insulation degradation",
        "recommendation": "Thermal imaging follow-up within 30 days",
        "position": [-2.1, 1.5, 6.2],
        "confidence": 0.87,
    },
    {
        "id": "A003",
        "type": "Water Damage",
        "severity": "warning",
        "description": "Discoloration pattern consistent with water infiltration near rooftop drainage",
        "recommendation": "Inspect drainage system and waterproofing membrane",
        "position": [0.5, 2.3, 5.8],
        "confidence": 0.82,
    },
    {
        "id": "A004",
        "type": "Vegetation Growth",
        "severity": "info",
        "description": "Moss/algae buildup on north-facing wall surface, minor aesthetic concern",
        "recommendation": "Schedule cleaning during next maintenance cycle",
        "position": [-1.8, -1.2, 2.1],
        "confidence": 0.91,
    },
    {
        "id": "A005",
        "type": "Sealant Deterioration",
        "severity": "warning",
        "description": "Window sealant showing signs of aging and separation on 2nd floor east side",
        "recommendation": "Re-seal within 60 days to prevent water intrusion",
        "position": [3.0, 0.2, 4.0],
        "confidence": 0.78,
    },
]

# Mock camera positions simulating a drone flight path around a building
# These form a roughly elliptical orbit pattern
def _generate_camera_positions(n: int = 40) -> List[List[float]]:
    positions = []
    for i in range(n):
        t = (i / n) * 2 * math.pi
        # Elliptical path with some altitude variation
        x = 8.0 * math.cos(t) + 0.3 * math.sin(t * 3)
        z = 6.0 * math.sin(t) + 0.2 * math.cos(t * 5)
        y = 3.0 + 1.5 * math.sin(t * 2)  # altitude varies
        positions.append([round(x, 2), round(y, 2), round(z, 2)])
    return positions


# Pre-baked result with enriched data for demo
PREBAKED_RESULT = {
    "splat_url": "/outputs/splat.ply",
    "coverage_pct": 94.2,
    "area_sq_m": 847.5,
    "anomalies": MOCK_ANOMALIES,
    "flight_path_geojson": None,
    "camera_positions": _generate_camera_positions(),
    "scan_duration_sec": 42,
    "total_frames": 185,
    "registered_frames": 178,
    "point_cloud_size": 248_631,
}


class MissionResponse(BaseModel):
    job_id: str


@app.get("/health")
async def health():
    return {"ok": True, "version": "0.1.0", "demo_mode": DEMO_MODE}


@app.post("/missions", response_model=MissionResponse)
async def create_mission(
    video: UploadFile = File(...),
    mode: str = Form("rapid"),
):
    if mode not in ("rapid", "precision"):
        raise HTTPException(400, "mode must be 'rapid' or 'precision'")

    job_id = str(uuid.uuid4())
    dest = UPLOAD_DIR / f"{job_id}_{video.filename}"
    with dest.open("wb") as f:
        shutil.copyfileobj(video.file, f)

    JOBS[job_id] = {
        "status": "queued",
        "progress": 0,
        "mode": mode,
        "video_path": str(dest),
        "result": None,
        "created_at": time.time(),
    }

    threading.Thread(target=_run_pipeline, args=(job_id,), daemon=True).start()

    return MissionResponse(job_id=job_id)


@app.get("/missions/{job_id}/status")
async def get_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job_id")
    return {
        "status": job["status"],
        "progress": job["progress"],
        "mode": job["mode"],
    }


@app.get("/missions/{job_id}/result")
async def get_result(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job_id")
    if job["status"] != "done":
        raise HTTPException(409, f"job not finished yet (status: {job['status']})")
    return job["result"]


@app.get("/missions")
async def list_missions():
    """List all missions (completed and in-progress)."""
    missions = []
    for job_id, job in JOBS.items():
        missions.append({
            "job_id": job_id,
            "status": job["status"],
            "progress": job["progress"],
            "mode": job["mode"],
            "created_at": job.get("created_at"),
        })
    return {"missions": missions}


def _run_pipeline(job_id: str):
    if DEMO_MODE:
        _run_demo_pipeline(job_id)
    else:
        _run_real_pipeline(job_id)


def _run_demo_pipeline(job_id: str):
    """Walk the job through the real stage names at a believable pace so
    the dashboard's pipeline stepper has something true to animate, then
    attach the pre-baked result. Rapid finishes faster than Precision."""
    job = JOBS[job_id]
    stage_seconds = 1.2 if job["mode"] == "rapid" else 2.5

    for i, stage in enumerate(PIPELINE_STAGES[:-1]):
        job["status"] = stage
        job["progress"] = round(i / (len(PIPELINE_STAGES) - 1) * 100)
        time.sleep(stage_seconds)

    job["status"] = "done"
    job["progress"] = 100
    job["result"] = PREBAKED_RESULT


def _run_real_pipeline(job_id: str):
    """Wire this up when the real pipeline is ready: call your actual
    Colab/local pipeline here, updating JOBS[job_id]['status'] / ['progress']
    as it moves through PIPELINE_STAGES, and set JOBS[job_id]['result'] to
    the real output at the end (same shape as PREBAKED_RESULT)."""
    raise NotImplementedError("plug in the real pipeline here")


# ─── Frontend SPA serving (production) ───
# In production, the built frontend lives in ./static/
# Mount static assets, then serve index.html for all non-API routes.

if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="frontend-assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the SPA index.html for any route not matched by API endpoints."""
        file_path = FRONTEND_DIR / full_path
        if full_path and file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIR / "index.html")
