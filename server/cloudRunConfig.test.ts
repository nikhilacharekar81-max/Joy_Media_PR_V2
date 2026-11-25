import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPgPoolConfig } from './db/postgresStore';
import { resolveStorageMode } from './cloudStorage';
import { isSafeExternalHttpsUrl } from './services/workstreamService';

test('buildPgPoolConfig supports Cloud SQL Unix sockets without TCP port or SSL', () => {
  const cfg = buildPgPoolConfig({
    env: {
      SQL_HOST: '/cloudsql/my-proj:us-central1:agency-db',
      SQL_DATABASE: 'agency',
      SQL_USER: 'postgres',
      SQL_PASSWORD: 'secret'
    }
  });
  assert.equal(cfg.host, '/cloudsql/my-proj:us-central1:agency-db');
  assert.equal(cfg.port, undefined);
  assert.equal(cfg.ssl, false);
  assert.equal(cfg.database, 'agency');
});

test('buildPgPoolConfig enables SSL on TCP hosts when PGSSL=true', () => {
  const cfg = buildPgPoolConfig({
    env: {
      SQL_HOST: '34.120.0.10',
      SQL_PORT: '5432',
      SQL_DATABASE: 'agency',
      SQL_USER: 'postgres',
      SQL_PASSWORD: 'secret',
      PGSSL: 'true'
    }
  });
  assert.equal(cfg.host, '34.120.0.10');
  assert.equal(cfg.port, 5432);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
});

test('resolveStorageMode uses local in test/dev without bucket and gcs when bucket or production is active', () => {
  assert.equal(resolveStorageMode({ NODE_ENV: 'test', GCS_BUCKET_NAME: 'my-bucket' }), 'local');
  assert.equal(resolveStorageMode({ NODE_ENV: 'development', GOOGLE_CLOUD_PROJECT: 'proj-1' }), 'local');
  assert.equal(resolveStorageMode({ NODE_ENV: 'development', GCS_BUCKET_NAME: 'my-bucket' }), 'gcs');
  assert.equal(resolveStorageMode({ NODE_ENV: 'production' }), 'gcs');
});

test('isSafeExternalHttpsUrl accepts valid public HTTPS URLs and blocks SSRF/unsafe schemes', () => {
  assert.equal(isSafeExternalHttpsUrl('https://example.com/deliverable.pdf'), true);
  assert.equal(isSafeExternalHttpsUrl('https://drive.google.com/file/d/123/view'), true);
  assert.equal(isSafeExternalHttpsUrl('http://example.com/deliverable.pdf'), false);
  assert.equal(isSafeExternalHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalHttpsUrl('https://localhost/admin'), false);
  assert.equal(isSafeExternalHttpsUrl('https://127.0.0.1/secret'), false);
  assert.equal(isSafeExternalHttpsUrl('https://169.254.169.254/computeMetadata/v1/'), false);
  assert.equal(isSafeExternalHttpsUrl('https://10.0.0.5/internal'), false);
  assert.equal(isSafeExternalHttpsUrl('https://192.168.1.1/router'), false);
  assert.equal(isSafeExternalHttpsUrl('https://user:pass@example.com/file'), false);
  assert.equal(isSafeExternalHttpsUrl('not a url'), false);
});
