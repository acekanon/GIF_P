import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyReproducibleBuilds } from './verify-reproducible-build.mjs';

const BUILDER_IMAGE = `ghcr.io/example/ffmpeg-builder@sha256:${'1'.repeat(64)}`;
const BUILDER_IMAGE_ID = `sha256:${'2'.repeat(64)}`;
const SOURCE_DATE_EPOCH = 1_783_757_450;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileSha256(filename) {
  return sha256(await fs.readFile(filename));
}

async function writeFile(root, relativePath, value) {
  const filename = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, value);
  return filename;
}

async function writeJson(root, relativePath, value) {
  return writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function manifestFor(root, relativeFiles, manifestNames = relativeFiles) {
  const lines = [];
  for (let index = 0; index < relativeFiles.length; index += 1) {
    const digest = await fileSha256(path.join(root, relativeFiles[index]));
    lines.push(`${digest}  ${manifestNames[index]}`);
  }
  return `${lines.join('\n')}\n`;
}

async function createValidBuild(root) {
  const runtimeFiles = [
    ['runtime/avutil-61.dll', Buffer.from('dll closure\n')],
    ['runtime/ffmpeg.exe', Buffer.from('ffmpeg executable\n')],
    ['runtime/ffprobe.exe', Buffer.from('ffprobe executable\n')],
  ];
  for (const [relativePath, content] of runtimeFiles) {
    await writeFile(root, relativePath, content);
  }

  await writeFile(root, 'RUNTIME-LICENSES.txt', 'FFmpeg LGPL license bundle\n');
  await writeFile(root, 'GIFP-FFmpeg-Windows-x64-LGPL-shared.zip', Buffer.from('PK\x03\x04deterministic runtime archive'));
  await writeFile(root, 'GIFP-FFmpeg-Corresponding-Source.tar', Buffer.from('deterministic corresponding source archive'));

  await writeFile(root, 'corresponding-source/sources/ffmpeg.tar.gz', Buffer.from('locked ffmpeg source'));
  await writeFile(root, 'corresponding-source/recipe/build-offline.sh', '#!/bin/sh\nexit 0\n');
  await writeFile(root, 'corresponding-source/recipe/ffmpeg-configure.args', '--disable-network\n');
  await writeJson(root, 'corresponding-source/sources.lock.json', { schemaVersion: 1, sources: ['ffmpeg'] });
  await writeJson(root, 'corresponding-source/build-recipe.lock.json', { schemaVersion: 1, inputs: ['build-offline.sh'] });

  const sourceLockPath = path.join(root, 'corresponding-source/sources.lock.json');
  const recipeLockPath = path.join(root, 'corresponding-source/build-recipe.lock.json');
  const sourceLockSha256 = await fileSha256(sourceLockPath);
  const buildRecipeLockSha256 = await fileSha256(recipeLockPath);

  await writeFile(
    root,
    'evidence/runtime.sha256',
    await manifestFor(
      root,
      runtimeFiles.map(([relativePath]) => relativePath),
      runtimeFiles.map(([relativePath]) => `./${path.posix.basename(relativePath)}`),
    ),
  );
  await writeFile(
    root,
    'evidence/runtime-licenses.sha256',
    await manifestFor(root, ['RUNTIME-LICENSES.txt']),
  );
  await writeFile(
    root,
    'evidence/runtime-archive.sha256',
    await manifestFor(root, ['GIFP-FFmpeg-Windows-x64-LGPL-shared.zip']),
  );
  await writeFile(
    root,
    'evidence/corresponding-source-archive.sha256',
    await manifestFor(root, ['GIFP-FFmpeg-Corresponding-Source.tar']),
  );
  await writeFile(
    root,
    'evidence/corresponding-sources.sha256',
    await manifestFor(
      root,
      ['corresponding-source/sources/ffmpeg.tar.gz'],
      ['./ffmpeg.tar.gz'],
    ),
  );
  await writeFile(
    root,
    'evidence/recipe.sha256',
    await manifestFor(
      root,
      [
        'corresponding-source/recipe/build-offline.sh',
        'corresponding-source/recipe/ffmpeg-configure.args',
      ],
      ['./build-offline.sh', './ffmpeg-configure.args'],
    ),
  );
  await writeFile(
    root,
    'evidence/build-inputs.sha256',
    await manifestFor(
      root,
      [
        'corresponding-source/sources.lock.json',
        'corresponding-source/build-recipe.lock.json',
        'corresponding-source/recipe/build-offline.sh',
        'corresponding-source/recipe/ffmpeg-configure.args',
      ],
      [
        '/lock/sources.lock.json',
        '/lock/build-recipe.lock.json',
        '/recipe/build-offline.sh',
        '/recipe/ffmpeg-configure.args',
      ],
    ),
  );

  const buildMetadata = {
    schemaVersion: 1,
    profile: 'gifp-windows-x64-lgpl-shared',
    target: 'x86_64-w64-mingw32',
    builderImage: BUILDER_IMAGE,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    networkPolicy: 'docker --network=none; source/recipe/lock mounts read-only',
    runtimeLinkage: 'FFmpeg shared DLLs; audited external libraries linked statically',
    sourceLockSha256,
    buildRecipeLockSha256,
  };
  await writeJson(root, 'evidence/build-metadata.json', buildMetadata);

  const recipeInputs = [];
  for (const relativePath of [
    'corresponding-source/recipe/build-offline.sh',
    'corresponding-source/recipe/ffmpeg-configure.args',
  ]) {
    const stats = await fs.stat(path.join(root, relativePath));
    recipeInputs.push({
      path: relativePath.replace('corresponding-source/', 'scripts/ffmpeg-public/'),
      sizeBytes: stats.size,
      sha256: await fileSha256(path.join(root, relativePath)),
    });
  }
  const sourceLockStats = await fs.stat(sourceLockPath);
  await writeJson(root, 'evidence/build-recipe-verification.json', {
    schemaVersion: 1,
    profile: buildMetadata.profile,
    builderImage: BUILDER_IMAGE,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    sourceLock: {
      path: 'compliance/ffmpeg-public/sources.lock.json',
      sizeBytes: sourceLockStats.size,
      sha256: sourceLockSha256,
    },
    inputs: recipeInputs,
  });

  const sourceArchivePath = path.join(root, 'corresponding-source/sources/ffmpeg.tar.gz');
  const sourceArchiveStats = await fs.stat(sourceArchivePath);
  await writeJson(root, 'evidence/source-cache-verification.json', {
    schemaVersion: 1,
    profile: buildMetadata.profile,
    target: buildMetadata.target,
    builderImage: BUILDER_IMAGE,
    sourceCount: 1,
    sources: [{
      id: 'ffmpeg',
      archiveFile: 'ffmpeg.tar.gz',
      sizeBytes: sourceArchiveStats.size,
      sha256: await fileSha256(sourceArchivePath),
    }],
  });

  const expectedInventory = {
    protocols: ['file'],
    devices: ['gdigrab'],
    demuxers: ['gif'],
    decoders: ['gif'],
    encoders: ['gif'],
    muxers: ['gif'],
    filters: ['palettegen'],
    hwaccels: ['d3d11va'],
  };
  await writeJson(root, 'evidence/runtime-inventory-verification.json', {
    schemaVersion: 1,
    actual: expectedInventory,
    expected: expectedInventory,
    missing: {},
    forbidden: {},
  });

  await writeJson(root, 'evidence/host-driver.json', {
    schemaVersion: 1,
    startedUtc: '2026-07-17T00:00:00.000Z',
    finishedUtc: '2026-07-17T00:01:00.000Z',
    builderImage: BUILDER_IMAGE,
    builderImageId: BUILDER_IMAGE_ID,
    builderAcquisition: 'registry-digest',
    builderRunReference: BUILDER_IMAGE,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    networkPolicy: 'docker --network=none; --pull=never',
    platform: 'linux/amd64',
    inputSnapshot: 'fresh verified copies under the preserved run directory',
    inputMountPolicy: [
      '/sources:read-only',
      '/recipe:read-only',
      '/lock:read-only',
    ],
    outputMountPolicy: [
      '/work:fresh Linux-native Docker volume',
      '/out:read-write',
    ],
    workVolume: 'first-build-volume',
    workVolumeStatus: 'removed-after-success',
    jobs: 4,
    dockerExitCode: 0,
    dockerInvocationError: null,
  });
  await writeJson(root, 'evidence/build-status.json', { schemaVersion: 1, exitCode: 0 });
  await writeJson(root, 'evidence/docker-image-inspect.json', [{
    Id: BUILDER_IMAGE_ID,
    RepoDigests: [BUILDER_IMAGE],
    Architecture: 'amd64',
    Os: 'linux',
  }]);
}

async function createBuildPair() {
  const temporaryRoot = await fs.mkdtemp(path.join(tmpdir(), 'gifp-repro-test-'));
  const baselineRoot = path.join(temporaryRoot, 'baseline');
  const replayRoot = path.join(temporaryRoot, 'replay');
  await createValidBuild(baselineRoot);
  await fs.cp(baselineRoot, replayRoot, { recursive: true });
  const replayHostPath = path.join(replayRoot, 'evidence/host-driver.json');
  const replayHost = JSON.parse(await fs.readFile(replayHostPath, 'utf8'));
  replayHost.startedUtc = '2026-07-17T00:02:00.000Z';
  replayHost.finishedUtc = '2026-07-17T00:03:00.000Z';
  replayHost.workVolume = 'second-build-volume';
  await fs.writeFile(replayHostPath, `${JSON.stringify(replayHost, null, 2)}\n`);
  return { temporaryRoot, baselineRoot, replayRoot };
}

async function withBuildPair(callback) {
  const fixture = await createBuildPair();
  try {
    await callback(fixture);
  } finally {
    await fs.rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
}

test('accepts byte-identical builds with matching immutable evidence', async () => {
  await withBuildPair(async ({ baselineRoot, replayRoot }) => {
    const record = await verifyReproducibleBuilds({ baselineRoot, replayRoot });
    assert.equal(record.status, 'pass');
    assert.equal(record.reproducible, true);
    assert.deepEqual(record.errors, []);
    assert.ok(record.checks.length > 0);
    assert.ok(record.checks.every((check) => check.ok));
  });
});

test('rejects a replay record that is not bound to a full Git commit', async () => {
  await withBuildPair(async ({ baselineRoot, replayRoot }) => {
    await assert.rejects(
      verifyReproducibleBuilds({ baselineRoot, replayRoot, gitCommit: 'deadbeef' }),
      /full 40-character Git commit/,
    );
  });
});

test('rejects the same output directory presented as both builds', async () => {
  await withBuildPair(async ({ baselineRoot }) => {
    await assert.rejects(
      verifyReproducibleBuilds({ baselineRoot, replayRoot: baselineRoot }),
      /distinct build outputs/,
    );
  });
});

test('fails closed when a replay runtime file is tampered', async () => {
  await withBuildPair(async ({ baselineRoot, replayRoot }) => {
    await fs.appendFile(path.join(replayRoot, 'runtime/ffmpeg.exe'), 'tampered');
    const record = await verifyReproducibleBuilds({ baselineRoot, replayRoot });
    assert.equal(record.status, 'fail');
    assert.equal(record.reproducible, false);
    assert.ok(record.errors.some((error) => error.code === 'HASH_MANIFEST_DIGEST_MISMATCH'));
    assert.ok(record.errors.some((error) => error.path === 'runtime.file-set-size-sha256'));
  });
});

test('fails closed when metadata or offline-network evidence is tampered', async (context) => {
  await context.test('metadata tamper', async () => {
    await withBuildPair(async ({ baselineRoot, replayRoot }) => {
      const filename = path.join(replayRoot, 'evidence/build-metadata.json');
      const metadata = JSON.parse(await fs.readFile(filename, 'utf8'));
      metadata.profile = 'tampered-public-profile';
      await fs.writeFile(filename, `${JSON.stringify(metadata, null, 2)}\n`);

      const record = await verifyReproducibleBuilds({ baselineRoot, replayRoot });
      assert.equal(record.reproducible, false);
      assert.ok(record.errors.some((error) => error.code === 'EVIDENCE_CROSS_LINK_MISMATCH'));
      assert.ok(record.errors.some((error) => error.path === 'evidence.build-metadata.json'));
    });
  });

  await context.test('network policy tamper', async () => {
    await withBuildPair(async ({ baselineRoot, replayRoot }) => {
      const filename = path.join(replayRoot, 'evidence/host-driver.json');
      const hostDriver = JSON.parse(await fs.readFile(filename, 'utf8'));
      hostDriver.networkPolicy = 'docker --network=bridge; --pull=missing';
      await fs.writeFile(filename, `${JSON.stringify(hostDriver, null, 2)}\n`);

      const record = await verifyReproducibleBuilds({ baselineRoot, replayRoot });
      assert.equal(record.reproducible, false);
      assert.ok(record.errors.some((error) => error.code === 'NETWORK_IS_NOT_OFFLINE'));
      assert.ok(record.errors.some((error) => error.code === 'BUILDER_PULL_IS_NOT_DISABLED'));
      assert.ok(record.errors.some((error) => error.path === 'evidence.host-driver.builder-offline-facts'));
    });
  });
});
