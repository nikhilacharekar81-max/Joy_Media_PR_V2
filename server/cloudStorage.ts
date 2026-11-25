import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { IS_PRODUCTION } from './initEnv.js';

function getBucketName(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GCS_BUCKET_NAME || '').trim();
}

export function resolveStorageMode(env: NodeJS.ProcessEnv = process.env): 'gcs' | 'local' {
  if (env.NODE_ENV === 'test') {
    return 'local';
  }
  const bucketName = getBucketName(env);
  if (bucketName) {
    return 'gcs';
  }
  const isProd = env.NODE_ENV === 'production' || (env === process.env && IS_PRODUCTION);
  if (isProd) {
    return 'gcs';
  }
  return 'local';
}

let cachedBucketPromise: Promise<any> | null = null;
let cachedBucketName = '';
function getGcsBucket(): Promise<any> {
  const bucketName = getBucketName();
  if (!bucketName) {
    console.error('[CloudStorage ERROR] GCS_BUCKET_NAME is not set. Configure GCS_BUCKET_NAME in your environment variables.');
    return Promise.reject(new Error('Cloud storage configuration missing: GCS_BUCKET_NAME must be set.'));
  }
  if (!cachedBucketPromise || cachedBucketName !== bucketName) {
    cachedBucketName = bucketName;
    cachedBucketPromise = import('@google-cloud/storage')
      .then(({ Storage }) => {
        const storage = new Storage();
        return storage.bucket(bucketName);
      })
      .catch((err) => {
        cachedBucketPromise = null;
        throw err;
      });
  }
  return cachedBucketPromise;
}

function assertProductionBucketConfigured(): void {
  const bucketName = getBucketName();
  if (!bucketName) {
    console.error('[CloudStorage ERROR] GCS_BUCKET_NAME is not set. Configure GCS_BUCKET_NAME in your environment variables.');
    if (process.env.NODE_ENV === 'production' || IS_PRODUCTION) {
      throw new Error('Cloud storage configuration missing: GCS_BUCKET_NAME must be set in production.');
    }
  }
}

export async function uploadFileToCloudStorage(filename: string, buffer: Buffer, mimeType: string): Promise<string> {
  const safeFilename = path.basename(filename);
  const mode = resolveStorageMode();

  if (mode === 'local') {
    const localDir = path.join(process.cwd(), 'data', 'uploads', 'workstream');
    await fs.promises.mkdir(localDir, { recursive: true });
    const localPath = path.join(localDir, safeFilename);
    await fs.promises.writeFile(localPath, buffer);
    return `/api/workstream/files/${safeFilename}`;
  }

  assertProductionBucketConfigured();

  try {
    const bucket = await getGcsBucket();
    const file = bucket.file(`workstream/${safeFilename}`);
    await file.save(buffer, {
      contentType: mimeType,
      resumable: false,
    });
    // Always serve private workstream uploads through the authenticated API proxy route
    return `/api/workstream/files/${safeFilename}`;
  } catch (err) {
    console.error('[CloudStorage ERROR] Failed to upload file to GCS:', err);
    throw err;
  }
}

export async function deleteFileFromCloudStorage(filename: string): Promise<void> {
  const safeFilename = path.basename(filename);
  const mode = resolveStorageMode();

  if (mode === 'local') {
    const localPath = path.join(process.cwd(), 'data', 'uploads', 'workstream', safeFilename);
    try { await fs.promises.unlink(localPath); } catch {}
    return;
  }

  assertProductionBucketConfigured();

  try {
    const bucket = await getGcsBucket();
    const file = bucket.file(`workstream/${safeFilename}`);
    await file.delete({ ignoreNotFound: true });
  } catch (err) {
    console.error('[CloudStorage ERROR] Failed to delete file from GCS:', err);
  }
}

export function openCloudFileStream(
  filename: string,
  authUser?: any,
  checkAccess?: (user: any, filename: string) => boolean
) {
  const safeFilename = path.basename(filename);
  if (checkAccess && (!authUser || !checkAccess(authUser, safeFilename))) {
    throw new Error('Unauthorized file access');
  }
  const passThrough = new PassThrough();
  const mode = resolveStorageMode();

  if (mode === 'local') {
    const localPath = path.join(process.cwd(), 'data', 'uploads', 'workstream', safeFilename);
    const readStream = fs.createReadStream(localPath);
    readStream.on('error', (err: any) => passThrough.destroy(err));
    readStream.pipe(passThrough);
    return passThrough;
  }

  assertProductionBucketConfigured();
  getGcsBucket()
    .then((bucket) => {
      const readStream = bucket.file(`workstream/${safeFilename}`).createReadStream();
      readStream.on('error', (err: any) => passThrough.destroy(err));
      readStream.pipe(passThrough);
    })
    .catch((err) => {
      passThrough.destroy(err);
    });
  return passThrough;
}
