# ──────────────────────────────────────────
# AeroMesh — Combined Dockerfile
# Serves both FastAPI backend + Vite frontend
# ──────────────────────────────────────────

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY aeromesh-frontend/aeromesh-frontend/package*.json ./
RUN npm ci --production=false
COPY aeromesh-frontend/aeromesh-frontend/ ./
RUN npm run build

# Stage 2: Production
FROM python:3.11-slim
WORKDIR /app

# Install Python deps
COPY aeromesh-backend/aeromesh-backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend
COPY aeromesh-backend/aeromesh-backend/ .

# Copy built frontend into backend's static dir
COPY --from=frontend-build /build/dist ./static

# Copy the splat model into outputs (if it exists)
# Users should volume-mount or pre-copy their splat.ply here
RUN mkdir -p outputs uploads

# Expose port
EXPOSE 8000

# Run
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
