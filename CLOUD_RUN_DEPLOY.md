# Deploying to Google Cloud Run (Zero Firebase)

This application is configured to run on **Google Cloud Run** backed by **Cloud SQL for PostgreSQL** (or any managed PostgreSQL), **Google Cloud Storage (GCS)** for persistent uploads, and **Secret Manager** for secrets. No Firebase services are used.

## 1. Prerequisites

1. **Google Cloud Project** with billing enabled and the following APIs enabled:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com sqladmin.googleapis.com \
     secretmanager.googleapis.com storage.googleapis.com
   ```
2. **PostgreSQL Database (Cloud SQL)**:
   - Create a Cloud SQL PostgreSQL 15+ instance (e.g., `joymediapr-db`) and note its **Connection Name** (`PROJECT_ID:REGION:INSTANCE_NAME`).
   - Create a database (e.g., `joymediapr`) and database user (e.g., `joymediapr_app`).
3. **Google Cloud Storage Bucket**:
   - Create a private bucket for order deliverables and workstream files (e.g., `joymediapr-uploads-prod`).
   - Grant the Cloud Run runtime service account `roles/storage.objectAdmin` on that bucket.
   - Keep the bucket **private** (Uniform bucket-level access, no public `allUsers` IAM); all downloads are served through the authenticated `/api/workstream/files/:filename` endpoint.

## 2. Store Secrets in Secret Manager

Create secrets for sensitive credentials (never bake them into the Docker image):

```bash
printf '%s' 'REPLACE_WITH_64_CHAR_RANDOM_HEX' | gcloud secrets create JWT_SECRET --data-file=-
printf '%s' 'REPLACE_WITH_32_CHAR_RANDOM_HEX' | gcloud secrets create GATEWAY_ENCRYPTION_KEY --data-file=-
printf '%s' 'YOUR_DB_PASSWORD'                | gcloud secrets create SQL_PASSWORD --data-file=-
printf '%s' 'YOUR_RESEND_API_KEY'             | gcloud secrets create RESEND_API_KEY --data-file=-
```

Grant your Cloud Run runtime service account `roles/secretmanager.secretAccessor` (and `roles/cloudsql.client` for Cloud SQL).

## 3. Deploy to Cloud Run

Run from the repository root (Cloud Build builds the `Dockerfile` automatically):

```bash
gcloud run deploy joymediapr \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --timeout 300 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 1 \
  --add-cloudsql-instances PROJECT_ID:REGION:INSTANCE_NAME \
  --set-env-vars "NODE_ENV=production,APP_URL=https://yourdomain.com,TRUST_PROXY=true,SQL_HOST=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME,SQL_DB_NAME=joymediapr,SQL_USER=joymediapr_app,GCS_BUCKET_NAME=joymediapr-uploads-prod,EMAIL_FROM=notifications@yourdomain.com" \
  --set-secrets "JWT_SECRET=JWT_SECRET:latest,GATEWAY_ENCRYPTION_KEY=GATEWAY_ENCRYPTION_KEY:latest,SQL_PASSWORD=SQL_PASSWORD:latest,RESEND_API_KEY=RESEND_API_KEY:latest"
```

### Health & Readiness Probes
- **Liveness probe**: `GET /api/health` (returns `200 { ok: true, hydrated }`)
- **Startup / Readiness probe**: `GET /api/ready` (returns `200 { ready: true }` once PostgreSQL migrations & hydration finish, otherwise `503`)

### Notes on Scaling & WebSockets
- Cloud Run supports WebSockets natively when `--timeout 300` (or higher) is set.
- Periodic background jobs use PostgreSQL advisory locks (`pg_try_advisory_lock`) so scaling beyond 1 instance will never double-process auto-accepts or outbox events.
- On `SIGTERM`, the server stops background jobs, closes WebSockets cleanly, flushes pending DB writes, and exits within 8.5 seconds (inside Cloud Run's 10-second grace period).
- Payment gateways (PayPal, Stripe, Razorpay) can be configured directly via the **Admin Panel -> Payment Gateways** (credentials are encrypted at rest with `GATEWAY_ENCRYPTION_KEY`) or via environment secrets.
