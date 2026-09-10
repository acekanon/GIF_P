// CLI entry point; invoke with Node.js.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const PACKET_PROTOCOL = "gifp-blind-review-packet-v1";
const VOTE_PROTOCOL = "gifp-paired-blind-v2";
const MARKER_FILE = ".gifp-review-output.json";
const ENTRYPOINT = "OPEN-REVIEW.html";
const CHECKSUM_FILE = "SHA256SUMS.txt";
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `GIFP blind-review packet builder

Usage:
  node scripts/package-blind-review.mjs --report PATH [options]

Options:
  --output PATH          Distribution directory (default: beside report/reviewer-packets/RUN_ID)
  --reviewers COUNT      Balanced reviewer assignments to generate (default: 3)
  --template PATH        Blind HTML template (default: bench/blind-report-template.html)
  --no-archive           Build and audit folders without creating ZIP files
  --force                Replace an earlier marked output for the same run
  --allow-dirty-packager Development only; formal packets require a clean packager commit
  --help                 Show this help

The reviewer ZIPs are opaque. Profile mappings and aggregation commands are written only to
the coordinator files outside the ZIPs.
`;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeHash(value, label) {
  const hash = requireString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} is not SHA-256`);
  return hash;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function safeSegment(value, label) {
  const segment = requireString(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
    throw new Error(`${label} contains unsafe path characters: ${segment}`);
  }
  return segment;
}

function isContained(root, target) {
  const path = relative(resolve(root), resolve(target));
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

function resolveContained(root, path, label) {
  const target = resolve(root, path);
  if (!isContained(root, target)) throw new Error(`${label} escapes ${root}: ${path}`);
  return target;
}

function normalizeAssetPath(value, label) {
  const path = requireString(value, label).replaceAll("\\", "/");
  if (isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || /[?#]/.test(path)) {
    throw new Error(`${label} must be a plain relative path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} contains an unsafe path segment: ${path}`);
  }
  return parts.join("/");
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function extractBlindData(html) {
  const match = html.match(
    /<script\s+id=["']gifp-blind-data["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) throw new Error("Blind page has no gifp-blind-data payload");
  try {
    return requireObject(JSON.parse(match[1]), "blind page data");
  } catch (error) {
    throw new Error(`Blind page has invalid embedded JSON: ${error.message}`);
  }
}

function effectiveConstraint(profile) {
  if (profile.target_constraint) return profile.target_constraint;
  return profile.match_target_profile_id ? "symmetric_match" : "hard_cap";
}

export function discoverBlindProfilePairs(report) {
  const manifest = requireObject(report.manifest, "quality report manifest");
  const profiles = requireArray(manifest.profiles, "quality report profiles");
  let references = profiles.filter(
    (profile) =>
      profile.generation_mode === "target_size" &&
      effectiveConstraint(profile) === "symmetric_match",
  );
  if (!references.length) {
    const reference = profiles.find((profile) => profile.generation_mode === "fast_gif");
    const candidate = profiles.find((profile) => profile.generation_mode === "best_gif");
    if (!reference || !candidate) {
      throw new Error("Report has no symmetric target/best pair or fast/best fallback");
    }
    return [{ reference, candidate }];
  }

  return references.map((reference) => {
    const candidateId = requireString(
      reference.match_target_profile_id,
      `match target for ${reference.id}`,
    );
    const candidate = profiles.find((profile) => profile.id === candidateId);
    if (!candidate) {
      throw new Error(`Blind reference ${reference.id} points to missing ${candidateId}`);
    }
    if (candidate.generation_mode !== "best_gif") {
      throw new Error(`Blind candidate ${candidate.id} must use best_gif mode`);
    }
    return { reference, candidate };
  });
}

function reportArtifactStem(reportPath) {
  const extension = extname(reportPath);
  return join(dirname(reportPath), basename(reportPath, extension));
}

export function blindPagePath(reportPath, pair, index) {
  const stem = reportArtifactStem(reportPath);
  if (index === 0) return `${stem}-blind.html`;
  const candidate = safeSegment(pair.candidate.id, "candidate profile id");
  const reference = safeSegment(pair.reference.id, "reference profile id");
  return `${stem}-blind-${candidate}-vs-${reference}.html`;
}

function assignmentSwaps(runId, fixtureId) {
  const digest = createHash("sha256").update(`${runId}:${fixtureId}`).digest();
  return (digest[digest.length - 1] & 1) === 1;
}

function symmetricDeltaPercent(first, second) {
  if (first === 0 && second === 0) return 0;
  return (Math.abs(first - second) / ((first + second) / 2)) * 100;
}

function findRun(report, fixtureId, profileId) {
  const run = report.runs.find(
    (item) => item.fixture_id === fixtureId && item.profile_id === profileId,
  );
  if (!run) throw new Error(`Missing report run ${fixtureId} / ${profileId}`);
  return run;
}

function validateBlindData(report, data, pair, blindPath) {
  const referenceId = requireString(pair.reference.id, "reference profile id");
  const candidateId = requireString(pair.candidate.id, "candidate profile id");
  const sourceRoot = dirname(blindPath);
  const reportSources = requireArray(report.sources, "quality report sources");
  const sources = new Map(reportSources.map((source) => [source.fixture_id, source]));

  const equalHeader =
    data.schema_version === report.schema_version &&
    data.run_id === report.run_id &&
    data.corpus_id === report.manifest.corpus_id &&
    data.manifest_sha256 === report.manifest_sha256 &&
    data.git_commit === report.git_commit &&
    data.git_dirty === false &&
    report.git_dirty === false &&
    data.reference_profile_id === referenceId &&
    data.candidate_profile_id === candidateId;
  if (!equalHeader) throw new Error(`Blind page provenance mismatch: ${blindPath}`);

  const pairs = requireArray(data.pairs, "blind page pairs");
  const omissions = requireArray(data.omitted_pairs, "blind page omissions");
  if (
    data.expected_pairs !== reportSources.length ||
    data.available_pairs !== pairs.length ||
    data.available_pairs !== data.expected_pairs ||
    omissions.length !== 0
  ) {
    throw new Error(`Formal distribution requires every report fixture: ${blindPath}`);
  }

  const seenFixtures = new Set();
  const seenAssets = new Set();
  const assets = [];
  pairs.forEach((blindPair, pairIndex) => {
    const fixtureId = requireString(blindPair.fixture_id, `pair ${pairIndex} fixture id`);
    if (seenFixtures.has(fixtureId)) throw new Error(`Duplicate blind fixture ${fixtureId}`);
    seenFixtures.add(fixtureId);
    const source = sources.get(fixtureId);
    if (!source || source.category !== blindPair.category) {
      throw new Error(`Blind fixture metadata mismatch for ${fixtureId}`);
    }
    if (blindPair.formal_vote_eligible !== true) {
      throw new Error(`Blind fixture is not formal-vote eligible: ${fixtureId}`);
    }

    const a = requireObject(blindPair.candidate_a, `${fixtureId} candidate A`);
    const b = requireObject(blindPair.candidate_b, `${fixtureId} candidate B`);
    const swap = assignmentSwaps(report.run_id, fixtureId);
    const expectedA = swap ? candidateId : referenceId;
    const expectedB = swap ? referenceId : candidateId;
    if (a.profile_id !== expectedA || b.profile_id !== expectedB) {
      throw new Error(`A/B assignment mismatch for ${fixtureId}`);
    }

    const computedDelta = symmetricDeltaPercent(a.size_bytes, b.size_bytes);
    if (
      !Number.isFinite(blindPair.size_delta_percent) ||
      Math.abs(blindPair.size_delta_percent - computedDelta) > 1e-8 ||
      computedDelta > data.formal_max_size_delta_percent
    ) {
      throw new Error(`Size-match evidence mismatch for ${fixtureId}`);
    }

    for (const [side, embedded] of [
      ["a", a],
      ["b", b],
    ]) {
      if (embedded.correctness_passed !== true) {
        throw new Error(`${fixtureId}/${side} failed embedded correctness`);
      }
      const imagePath = normalizeAssetPath(
        embedded.image_src,
        `${fixtureId}/${side} image path`,
      );
      if (!imagePath.endsWith(`/${side}.gif`)) {
        throw new Error(`${fixtureId}/${side} has the wrong asset side: ${imagePath}`);
      }
      if (seenAssets.has(imagePath)) throw new Error(`Duplicate blind asset ${imagePath}`);
      seenAssets.add(imagePath);
      const sourcePath = resolveContained(sourceRoot, imagePath, "blind asset");
      if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
        throw new Error(`Missing blind asset ${sourcePath}`);
      }
      const run = findRun(report, fixtureId, embedded.profile_id);
      if (
        run.status !== "ok" ||
        run.correctness?.all_passed !== true ||
        !run.metrics ||
        run.metrics.size_bytes !== embedded.size_bytes
      ) {
        throw new Error(`Report correctness/size mismatch for ${fixtureId}/${embedded.profile_id}`);
      }
      const expectedHash = normalizeHash(
        run.output_sha256,
        `${fixtureId}/${embedded.profile_id} output hash`,
      );
      const actualHash = sha256File(sourcePath);
      if (actualHash !== expectedHash || statSync(sourcePath).size !== embedded.size_bytes) {
        throw new Error(`Asset bytes do not match the quality report: ${imagePath}`);
      }
      assets.push({
        pairIndex,
        side,
        sourcePath,
        sourceImagePath: imagePath,
        sha256: actualHash,
        sizeBytes: embedded.size_bytes,
      });
    }
  });

  if (seenFixtures.size !== reportSources.length || assets.length !== pairs.length * 2) {
    throw new Error(`Blind page coverage is incomplete: ${blindPath}`);
  }
  return assets;
}

function escapeEmbeddedJson(data) {
  return JSON.stringify(data)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderBlindPage(template, data) {
  const placeholder = "__GIFP_BLIND_DATA__";
  if (template.split(placeholder).length !== 2) {
    throw new Error("Blind template must contain exactly one data placeholder");
  }
  return template.replace(placeholder, escapeEmbeddedJson(data));
}

function walkFiles(root, current = root) {
  const output = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(root, path));
    else if (entry.isFile()) output.push(toPosix(relative(root, path)));
    else throw new Error(`Packet contains unsupported filesystem entry: ${path}`);
  }
  return output.sort();
}

function writeChecksums(packetRoot) {
  const files = walkFiles(packetRoot).filter((path) => path !== CHECKSUM_FILE);
  const lines = files.map((path) => `${sha256File(join(packetRoot, ...path.split("/")))}  *${path}`);
  writeFileSync(join(packetRoot, CHECKSUM_FILE), `${lines.join("\n")}\n`, "utf8");
  return files.length;
}

export function verifyPacketDirectory(packetRoot) {
  const checksumPath = join(packetRoot, CHECKSUM_FILE);
  if (!existsSync(checksumPath)) throw new Error(`Missing ${CHECKSUM_FILE} in ${packetRoot}`);
  const expected = new Map();
  for (const line of readFileSync(checksumPath, "utf8").trim().split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})  \*(.+)$/);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    if (expected.has(match[2])) throw new Error(`Duplicate checksum path: ${match[2]}`);
    expected.set(match[2], match[1]);
  }
  const actualFiles = walkFiles(packetRoot).filter((path) => path !== CHECKSUM_FILE);
  if (
    actualFiles.length !== expected.size ||
    actualFiles.some((path) => !expected.has(path))
  ) {
    throw new Error(`Packet file list does not match ${CHECKSUM_FILE}: ${packetRoot}`);
  }
  for (const path of actualFiles) {
    const actual = sha256File(join(packetRoot, ...path.split("/")));
    if (actual !== expected.get(path)) throw new Error(`Packet checksum mismatch: ${path}`);
  }

  const manifest = JSON.parse(readFileSync(join(packetRoot, "PACKET.json"), "utf8"));
  if (manifest.packet_protocol !== PACKET_PROTOCOL || manifest.entrypoint !== ENTRYPOINT) {
    throw new Error(`Invalid packet manifest in ${packetRoot}`);
  }
  const data = extractBlindData(readFileSync(join(packetRoot, ENTRYPOINT), "utf8"));
  if (
    data.run_id !== manifest.run_id ||
    data.available_pairs !== manifest.available_pair_count ||
    data.pairs.filter((pair) => pair.formal_vote_eligible).length !== manifest.formal_pair_count
  ) {
    throw new Error(`Packet page and manifest disagree in ${packetRoot}`);
  }
  for (const pair of data.pairs) {
    for (const candidate of [pair.candidate_a, pair.candidate_b]) {
      const imagePath = normalizeAssetPath(candidate.image_src, "packaged image path");
      const path = resolveContained(packetRoot, imagePath, "packaged asset");
      if (!existsSync(path) || sha256File(path) === "") {
        throw new Error(`Missing packaged asset ${imagePath}`);
      }
    }
  }
  return manifest;
}

function setDeterministicTimes(root, unixMs) {
  const timestamp = new Date(Number.isFinite(unixMs) ? unixMs : 0);
  const paths = walkFiles(root).map((path) => join(root, ...path.split("/")));
  paths.sort((left, right) => right.length - left.length);
  for (const path of paths) utimesSync(path, timestamp, timestamp);

  const directories = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(path, entry.name));
    }
    directories.push(path);
  };
  visit(root);
  for (const path of directories) utimesSync(path, timestamp, timestamp);
}

function startHere(packetId, pairCount) {
  return `GIFP 成对盲测 · ${packetId}

这是离线 protocol v2 正式评审包，共 ${pairCount} 个可比较配对。

操作步骤
1. 完整解压 ZIP，不要只在压缩包预览器里打开文件。
2. 双击 ${ENTRYPOINT}，建议使用最新版 Chrome、Edge 或 Firefox。
3. 输入协调者分配的评审代号，例如 reviewer-01。
4. 只根据画面判断 A 更好、B 更好或接近；可使用同步重播和底色切换。
5. 在全部配对投完前，不要揭示身份、查看网页源代码、检查资源文件或导出 JSON。
6. 全部配对完成后，“导出投票 JSON”会解锁。导出一次并原样交给协调者。
7. 不要修改导出的 JSON，也不要在其他评审者完成前交流判断。

正式票规则
- 投票前或改票前揭示某个配对的身份，该配对会永久降为探索票。
- “重置本轮盲测”只清空选择，不会洗掉已经揭示身份的历史。
- “开始新评审会话”只供另一位真实评审者接手同一台电脑时使用。
- 如果刷新页面，本机浏览器会恢复同一评审会话；不要清理站点数据。

完整性
- ${CHECKSUM_FILE} 列出包内全部内容的 SHA-256。
- 本包已在打包后解压复验；缺文件或校验不一致时请停止评审并联系协调者。
`;
}

function readGitProvenance(root) {
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return {
    git_commit: git(["rev-parse", "HEAD"]),
    git_dirty: git(["status", "--porcelain", "--untracked-files=normal"]) !== "",
  };
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(unixMs) {
  const date = new Date(Number.isFinite(unixMs) ? unixMs : 0);
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  const month = Math.min(12, Math.max(1, date.getUTCMonth() + 1));
  const day = Math.min(31, Math.max(1, date.getUTCDate()));
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time:
      (Math.min(23, date.getUTCHours()) << 11) |
      (Math.min(59, date.getUTCMinutes()) << 5) |
      Math.floor(Math.min(59, date.getUTCSeconds()) / 2),
  };
}

export function createDeterministicZip(packetRoot, archivePath, unixMs) {
  const packetName = safeSegment(basename(packetRoot), "packet directory name");
  const files = walkFiles(packetRoot);
  if (files.length > 0xffff) throw new Error("Packet has too many files for classic ZIP");
  const timestamp = dosDateTime(unixMs);
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const relativePath of files) {
    const bytes = readFileSync(join(packetRoot, ...relativePath.split("/")));
    if (bytes.length >= 0xffffffff) throw new Error(`Packet file requires ZIP64: ${relativePath}`);
    const name = Buffer.from(`${packetName}/${relativePath}`, "utf8");
    if (name.length > 0xffff) throw new Error(`ZIP path is too long: ${relativePath}`);
    const checksum = crc32(bytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(bytes.length, 18);
    localHeader.writeUInt32LE(bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, name, bytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(bytes.length, 20);
    centralHeader.writeUInt32LE(bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralChunks.push(centralHeader, name);
    localOffset += localHeader.length + name.length + bytes.length;
    if (localOffset >= 0xffffffff) throw new Error("Packet requires ZIP64");
  }

  const local = Buffer.concat(localChunks);
  const central = Buffer.concat(centralChunks);
  if (central.length >= 0xffffffff || local.length >= 0xffffffff) {
    throw new Error("Packet requires ZIP64");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(archivePath, Buffer.concat([local, central, end]));
}

export function auditDeterministicZip(packetRoot, archivePath) {
  const archive = readFileSync(archivePath);
  if (archive.length < 22) throw new Error(`ZIP is truncated: ${archivePath}`);
  const endOffset = archive.length - 22;
  if (archive.readUInt32LE(endOffset) !== 0x06054b50) {
    throw new Error(`ZIP has no deterministic end record: ${archivePath}`);
  }
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (
    archive.readUInt16LE(endOffset + 4) !== 0 ||
    archive.readUInt16LE(endOffset + 6) !== 0 ||
    diskEntries !== totalEntries ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new Error(`ZIP end record is inconsistent: ${archivePath}`);
  }

  const packetName = safeSegment(basename(packetRoot), "packet directory name");
  const expectedFiles = walkFiles(packetRoot);
  if (totalEntries !== expectedFiles.length) {
    throw new Error(`ZIP entry count mismatch: ${archivePath}`);
  }
  const expected = new Map(
    expectedFiles.map((path) => [`${packetName}/${path}`, join(packetRoot, ...path.split("/"))]),
  );
  const seen = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`ZIP central directory is malformed at entry ${index}`);
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > endOffset) {
      throw new Error(`ZIP central entry is truncated at ${index}`);
    }
    const name = archive.subarray(nameStart, nameEnd).toString("utf8");
    const sourcePath = expected.get(name);
    if (!sourcePath || seen.has(name)) throw new Error(`Unexpected ZIP entry: ${name}`);
    seen.add(name);
    if (flags !== 0x0800 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error(`ZIP entry is not deterministic stored UTF-8 data: ${name}`);
    }
    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP local header is invalid: ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const localName = archive.subarray(localNameStart, localNameEnd).toString("utf8");
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      archive.readUInt16LE(localOffset + 6) !== flags ||
      archive.readUInt16LE(localOffset + 8) !== method ||
      archive.readUInt32LE(localOffset + 18) !== compressedSize ||
      archive.readUInt32LE(localOffset + 22) !== uncompressedSize ||
      localName !== name ||
      dataEnd > centralOffset
    ) {
      throw new Error(`ZIP local entry does not match central directory: ${name}`);
    }
    const data = archive.subarray(dataStart, dataEnd);
    const source = readFileSync(sourcePath);
    if (
      !data.equals(source) ||
      crc32(data) !== expectedCrc ||
      archive.readUInt32LE(localOffset + 14) !== expectedCrc
    ) {
      throw new Error(`ZIP entry bytes or CRC mismatch: ${name}`);
    }
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== endOffset || seen.size !== expected.size) {
    throw new Error(`ZIP central directory coverage mismatch: ${archivePath}`);
  }
  return { entryCount: seen.size, archiveSha256: sha256Bytes(archive) };
}

function prepareOutputRoot(outputRoot, runId, force) {
  const resolved = resolve(outputRoot);
  if (existsSync(resolved)) {
    if (!force) throw new Error(`Output already exists; use --force: ${resolved}`);
    const markerPath = join(resolved, MARKER_FILE);
    if (!existsSync(markerPath)) {
      throw new Error(`Refusing to replace an unmarked directory: ${resolved}`);
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker.packet_protocol !== PACKET_PROTOCOL || marker.run_id !== runId) {
      throw new Error(`Refusing to replace an output for another run: ${resolved}`);
    }
    const parsedRoot = resolve(resolved, sep);
    if (resolved === parsedRoot || resolved === workspaceRoot || resolved === dirname(resolved)) {
      throw new Error(`Refusing unsafe recursive removal: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
  }
  mkdirSync(resolved, { recursive: true });
  writeFileSync(
    join(resolved, MARKER_FILE),
    jsonText({ packet_protocol: PACKET_PROTOCOL, run_id: runId }),
    "utf8",
  );
  return resolved;
}

function coordinatorMarkdown(reportPath, packets, reviewerCount) {
  const packetRows = packets
    .map(
      (packet) =>
        `| ${packet.packet_id} | \`${packet.candidate_profile_id}\` | \`${packet.reference_profile_id}\` | ${packet.formal_pair_count} | \`${packet.archive_name ?? "folder only"}\` |`,
    )
    .join("\n");
  const commands = packets
    .map(
      (packet) => `### ${packet.packet_id}

\`\`\`powershell
npm run quality:blind:aggregate -- --report "${reportPath}" \`
  --reference-profile ${packet.reference_profile_id} \`
  --candidate-profile ${packet.candidate_profile_id} \`
  --votes C:\\votes\\${packet.packet_id}-reviewer-01.json \`
  --votes C:\\votes\\${packet.packet_id}-reviewer-02.json \`
  --votes C:\\votes\\${packet.packet_id}-reviewer-03.json \`
  --output tmp/quality-lab/${packet.packet_id}-blind-audit.json
\`\`\``,
    )
    .join("\n\n");
  return `# GIFP 盲测协调者说明

这份文件包含候选映射，不要发给评审者。只逐个发送对应的匿名 ZIP，并按 \`reviewer-assignments.csv\` 平衡顺序。

质量报告：\`${reportPath}\`  
Run：\`${packets[0]?.run_id ?? "unknown"}\`  
计划评审者：${reviewerCount}

| 匿名包 | 候选 | 同体积参考 | 正式配对 | 分发文件 |
| --- | --- | --- | ---: | --- |
${packetRows}

## 收集规则

- 每位评审者使用固定代号，并完成两个包；奇偶代号按表反向，降低顺序学习效应。
- 一次只发送一个 ZIP；收到并核对第一个完整 JSON 后再发第二个。
- 导出文件必须原样保存，不要手工修补、不接受截图代替。
- 聚合器会重新计算 A/B 身份、正式资格、体积差和 reviewer_id 去重。

## 聚合命令

${commands}
`;
}

function assignmentRows(packetIds, reviewerCount) {
  const rows = ["reviewer_label,first_packet,second_packet"];
  for (let index = 0; index < reviewerCount; index += 1) {
    const order = packetIds.map((_, offset) => packetIds[(index + offset) % packetIds.length]);
    rows.push(
      [
        `reviewer-${String(index + 1).padStart(2, "0")}`,
        order[0] ?? "",
        order[1] ?? "",
      ].join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

export function buildBlindReviewDistribution({
  reportPath,
  outputRoot,
  reviewerCount = 3,
  templatePath = join(workspaceRoot, "bench", "blind-report-template.html"),
  archive = true,
  force = false,
  allowDirtyPackager = false,
  packagerProvenance,
} = {}) {
  const resolvedReport = resolve(requireString(reportPath, "report path"));
  if (!Number.isInteger(reviewerCount) || reviewerCount < 3) {
    throw new Error("reviewerCount must be an integer of at least 3");
  }
  const report = requireObject(
    JSON.parse(readFileSync(resolvedReport, "utf8")),
    "quality report",
  );
  requireArray(report.runs, "quality report runs");
  requireString(report.run_id, "quality report run id");
  requireString(report.git_commit, "quality report git commit");
  if (report.git_dirty !== false) throw new Error("Formal packets require git_dirty=false report evidence");
  const template = readFileSync(resolve(templatePath), "utf8");
  const provenance = packagerProvenance ?? readGitProvenance(workspaceRoot);
  if (!allowDirtyPackager && provenance.git_dirty !== false) {
    throw new Error("Formal packets require a clean packager commit");
  }
  requireString(provenance.git_commit, "packager git commit");

  const pairs = discoverBlindProfilePairs(report);
  const destination =
    outputRoot ?? join(dirname(resolvedReport), "reviewer-packets", report.run_id);
  const distributionRoot = prepareOutputRoot(destination, report.run_id, force);
  const reportHash = sha256File(resolvedReport);
  const templateHash = sha256Bytes(template);
  const packets = [];

  pairs.forEach((pair, index) => {
    const packetId = `packet-${String(index + 1).padStart(2, "0")}`;
    const blindPath = blindPagePath(resolvedReport, pair, index);
    if (!existsSync(blindPath)) throw new Error(`Missing blind page: ${blindPath}`);
    const sourceHtml = readFileSync(blindPath, "utf8");
    const data = extractBlindData(sourceHtml);
    const assets = validateBlindData(report, data, pair, blindPath);
    const packagedData = structuredClone(data);
    assets.forEach((asset) => {
      const sideKey = asset.side === "a" ? "candidate_a" : "candidate_b";
      packagedData.pairs[asset.pairIndex][sideKey].image_src =
        `assets/pair-${String(asset.pairIndex + 1).padStart(3, "0")}/${asset.side}.gif`;
    });

    const packetName = `gifp-blind-${report.run_id}-${packetId}`;
    const packetRoot = join(distributionRoot, packetName);
    mkdirSync(packetRoot, { recursive: true });
    for (const asset of assets) {
      const relativePath = packagedData.pairs[asset.pairIndex][
        asset.side === "a" ? "candidate_a" : "candidate_b"
      ].image_src;
      const destinationPath = resolveContained(packetRoot, relativePath, "packet asset");
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(asset.sourcePath, destinationPath);
    }

    writeFileSync(join(packetRoot, ENTRYPOINT), renderBlindPage(template, packagedData), "utf8");
    writeFileSync(
      join(packetRoot, "START-HERE.txt"),
      startHere(packetId, data.available_pairs),
      "utf8",
    );
    const packetManifest = {
      schema_version: 1,
      packet_protocol: PACKET_PROTOCOL,
      vote_protocol: VOTE_PROTOCOL,
      packet_id: packetId,
      entrypoint: ENTRYPOINT,
      run_id: report.run_id,
      corpus_id: report.manifest.corpus_id,
      manifest_sha256: report.manifest_sha256,
      source_git_commit: report.git_commit,
      source_git_dirty: false,
      packager_git_commit: provenance.git_commit,
      packager_git_dirty: provenance.git_dirty,
      expected_pair_count: data.expected_pairs,
      available_pair_count: data.available_pairs,
      formal_pair_count: data.pairs.filter((item) => item.formal_vote_eligible).length,
      asset_file_count: assets.length,
      source_report_sha256: reportHash,
      source_blind_page_sha256: sha256Bytes(sourceHtml),
      review_template_sha256: templateHash,
    };
    const serializedManifest = jsonText(packetManifest);
    if (
      serializedManifest.includes(pair.reference.id) ||
      serializedManifest.includes(pair.candidate.id)
    ) {
      throw new Error(`Reviewer manifest leaked profile identity for ${packetId}`);
    }
    writeFileSync(join(packetRoot, "PACKET.json"), serializedManifest, "utf8");
    const checksummedFileCount = writeChecksums(packetRoot);
    setDeterministicTimes(packetRoot, report.generated_at_unix_ms);
    verifyPacketDirectory(packetRoot);

    let archivePath = null;
    if (archive) {
      archivePath = join(distributionRoot, `${packetName}.zip`);
      createDeterministicZip(packetRoot, archivePath, report.generated_at_unix_ms);
      auditDeterministicZip(packetRoot, archivePath);
    }
    packets.push({
      packet_id: packetId,
      run_id: report.run_id,
      reference_profile_id: pair.reference.id,
      candidate_profile_id: pair.candidate.id,
      formal_pair_count: packetManifest.formal_pair_count,
      packet_directory: packetName,
      packet_directory_checksum_manifest_sha256: sha256File(join(packetRoot, CHECKSUM_FILE)),
      checksummed_file_count: checksummedFileCount,
      archive_name: archivePath ? basename(archivePath) : null,
      archive_size_bytes: archivePath ? statSync(archivePath).size : null,
      archive_sha256: archivePath ? sha256File(archivePath) : null,
    });
  });

  writeFileSync(
    join(distributionRoot, "reviewer-assignments.csv"),
    assignmentRows(
      packets.map((packet) => packet.packet_id),
      reviewerCount,
    ),
    "utf8",
  );
  writeFileSync(
    join(distributionRoot, "COORDINATOR.md"),
    coordinatorMarkdown(resolvedReport, packets, reviewerCount),
    "utf8",
  );
  const distribution = {
    schema_version: 1,
    packet_protocol: PACKET_PROTOCOL,
    run_id: report.run_id,
    quality_report_path: resolvedReport,
    quality_report_sha256: reportHash,
    source_git_commit: report.git_commit,
    packager_git_commit: provenance.git_commit,
    reviewer_count: reviewerCount,
    packets,
  };
  writeFileSync(
    join(distributionRoot, "DISTRIBUTION.json"),
    jsonText(distribution),
    "utf8",
  );
  const archives = packets.filter((packet) => packet.archive_name);
  writeFileSync(
    join(distributionRoot, "ARCHIVE-SHA256SUMS.txt"),
    archives.length
      ? `${archives.map((packet) => `${packet.archive_sha256}  *${packet.archive_name}`).join("\n")}\n`
      : "# ZIP creation skipped; packet folders were still audited.\n",
    "utf8",
  );
  return { distributionRoot, distribution };
}

function parseArgs(args) {
  const options = {
    reportPath: null,
    outputRoot: null,
    reviewerCount: 3,
    templatePath: join(workspaceRoot, "bench", "blind-report-template.html"),
    archive: true,
    force: false,
    allowDirtyPackager: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      index += 1;
      if (index >= args.length) throw new Error(`${argument} requires a value`);
      return args[index];
    };
    switch (argument) {
      case "--report":
        options.reportPath = value();
        break;
      case "--output":
        options.outputRoot = value();
        break;
      case "--reviewers":
        options.reviewerCount = Number(value());
        break;
      case "--template":
        options.templatePath = value();
        break;
      case "--no-archive":
        options.archive = false;
        break;
      case "--force":
        options.force = true;
        break;
      case "--allow-dirty-packager":
        options.allowDirtyPackager = true;
        break;
      case "--help":
      case "-h":
        return null;
      default:
        throw new Error(`Unknown option: ${argument}\n\n${HELP}`);
    }
  }
  if (!options.reportPath) throw new Error(`--report is required\n\n${HELP}`);
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
      process.stdout.write(HELP);
    } else {
      const result = buildBlindReviewDistribution(options);
      console.log(`Blind-review distribution ready: ${result.distributionRoot}`);
      for (const packet of result.distribution.packets) {
        console.log(
          `  ${packet.packet_id}: ${packet.formal_pair_count} formal pairs, ${packet.archive_name ?? packet.packet_directory}`,
        );
      }
    }
  } catch (error) {
    console.error(`GIFP blind-review packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
