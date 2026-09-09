# ──────────────────────────────────────────
# AeroMesh — Combined Dockerfile
# Serves both FastAPI backend + Vite frontend
# ──────────────────────────────────────────

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY aeromesh-frontend/aeromesh-frontend/package*.json ./
RUN npm install
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

# Ensure output directories exist
RUN mkdir -p outputs uploads

# Run using the $PORT environment variable (defaults to 8000)
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
