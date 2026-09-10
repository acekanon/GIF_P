import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLicenseTextBundle,
  buildThirdPartyManifest,
  loadLicenseOverlayManifest,
  parseArguments,
  parseCargoLock,
  runCli,
  serializeLicenseTextManifest,
  serializeThirdPartyManifest,
  writeLicenseTextBundle,
} from "./generate-third-party-manifest.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "gifp-third-party-manifest-"));
  roots.push(root);
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fixture",
          version: "1.0.0",
          dependencies: { "runtime-zeta": "1.0.0" },
        },
        "node_modules/runtime-zeta": {
          version: "1.0.0",
          license: "MIT",
          resolved: "https://registry.npmjs.org/runtime-zeta/-/runtime-zeta-1.0.0.tgz",
          integrity: "sha512-runtime",
        },
        "node_modules/@scope/no-license": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/@scope/no-license/-/no-license-2.0.0.tgz",
        },
        "node_modules/dev-only": {
          version: "3.0.0",
          dev: true,
          license: "Apache-2.0",
          resolved: "https://registry.npmjs.org/dev-only/-/dev-only-3.0.0.tgz",
        },
      },
    })}\n`,
  );
  const cargoLock = `# generated\nversion = 4\n\n[[package]]\nname = "alpha"\nversion = "1.2.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aaa"\n\n[[package]]\nname = "beta"\nversion = "2.1.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "bbb"\n`;
  writeFileSync(join(root, "src-tauri", "Cargo.lock"), cargoLock);

  const rootPackage = {
    id: "path+file:///fixture#app@1.0.0",
    name: "app",
    version: "1.0.0",
    license: null,
    license_file: null,
    source: null,
    manifest_path: join(root, "src-tauri", "Cargo.toml"),
  };
  const packages = [
    {
      id: "registry#beta@2.1.0",
      name: "beta",
      version: "2.1.0",
      license: null,
      license_file: join(root, "cargo-cache", "beta", "LICENSE.custom"),
      source: "registry+https://github.com/rust-lang/crates.io-index",
      manifest_path: join(root, "cargo-cache", "beta", "Cargo.toml"),
      repository: "https://example.invalid/beta",
    },
    rootPackage,
    {
      id: "registry#alpha@1.2.0",
      name: "alpha",
      version: "1.2.0",
      license: "MIT OR Apache-2.0",
      license_file: null,
      source: "registry+https://github.com/rust-lang/crates.io-index",
      manifest_path: join(root, "cargo-cache", "alpha", "Cargo.toml"),
      repository: "https://github.com/example/project",
    },
  ];
  const cargoMetadata = {
    workspace_members: [rootPackage.id],
    packages,
    resolve: { nodes: packages.map(({ id }) => ({ id })) },
  };
  const directories = [
    join(root, "cargo-cache", "alpha"),
    join(root, "cargo-cache", "beta"),
    join(root, "node_modules", "runtime-zeta"),
    join(root, "node_modules", "@scope", "no-license"),
    join(root, "node_modules", "dev-only"),
  ];
  for (const directory of directories) mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "cargo-cache", "alpha", "LICENSE-MIT"), "shared\n");
  writeFileSync(join(root, "cargo-cache", "alpha", "NOTICE"), "alpha notice\n");
  writeFileSync(join(root, "cargo-cache", "beta", "LICENSE.custom"), "beta\n");
  writeFileSync(join(root, "node_modules", "runtime-zeta", "LICENSE"), "shared\n");
  writeFileSync(
    join(root, "node_modules", "@scope", "no-license", "COPYING"),
    "orphan text\n",
  );
  writeFileSync(join(root, "node_modules", "dev-only", "LICENSE"), "dev\n");
  return { root, cargoLock, cargoMetadata };
}

describe("third-party manifest generator", () => {
  it("builds stable sorted output, excludes project and npm development packages", () => {
    const { root, cargoMetadata } = createFixture();
    const options = {
      rootDir: root,
      cargoMetadata,
      cargoMetadataDescriptor: { mode: "fixture" },
    };
    const first = buildThirdPartyManifest(options);
    const second = buildThirdPartyManifest({
      ...options,
      cargoMetadata: {
        ...cargoMetadata,
        packages: [...cargoMetadata.packages].reverse(),
        resolve: { nodes: [...cargoMetadata.resolve.nodes].reverse() },
      },
    });

    expect(serializeThirdPartyManifest(first)).toBe(serializeThirdPartyManifest(second));
    expect(first.components.map(({ ecosystem, name }) => `${ecosystem}:${name}`)).toEqual([
      "cargo:alpha",
      "cargo:beta",
      "npm:@scope/no-license",
      "npm:runtime-zeta",
    ]);
    expect(first.summary).toEqual({
      componentCount: 4,
      missingLicenseCount: 1,
      byEcosystem: {
        cargo: { componentCount: 2, missingLicenseCount: 0 },
        npm: { componentCount: 2, missingLicenseCount: 1 },
      },
    });
    expect(first.components[0]).toMatchObject({
      ecosystem: "cargo",
      name: "alpha",
      integrity: "aaa",
      missingLicense: false,
    });
    expect(first.components[1]).toMatchObject({
      name: "beta",
      license: null,
      licenseFile: "LICENSE.custom",
      missingLicense: false,
    });
    expect(serializeThirdPartyManifest(first)).not.toContain(root.replaceAll("\\", "/"));
    expect(serializeThirdPartyManifest(first)).not.toContain(basename(root));
  });

  it("can include npm development dependencies and parse strict-mode arguments", () => {
    const { root, cargoMetadata } = createFixture();
    const manifest = buildThirdPartyManifest({
      rootDir: root,
      cargoMetadata,
      includeNpmDev: true,
    });

    expect(manifest.components.find(({ name }) => name === "dev-only")).toMatchObject({
      ecosystem: "npm",
      scope: "development",
    });
    expect(
      parseArguments([
        "--root",
        root,
        "--include-npm-dev",
        "--fail-on-missing-license",
        "--licenses-output-dir",
        "licenses",
        "--license-overlay-manifest",
        "compliance/license-overlays.json",
        "--fail-on-missing-license-text",
        "--output",
        "manifest.json",
      ]),
    ).toMatchObject({
      rootDir: root,
      includeNpmDev: true,
      failOnMissingLicense: true,
      licensesOutputDir: "licenses",
      licenseOverlayManifestPath: "compliance/license-overlays.json",
      failOnMissingLicenseText: true,
      outputPath: "manifest.json",
    });
  });

  it("extracts package checksums from Cargo.lock without parsing dependency arrays", () => {
    const { cargoLock } = createFixture();
    expect(parseCargoLock(cargoLock)).toEqual({
      version: 4,
      packages: [
        {
          name: "alpha",
          version: "1.2.0",
          source: "registry+https://github.com/rust-lang/crates.io-index",
          checksum: "aaa",
        },
        {
          name: "beta",
          version: "2.1.0",
          source: "registry+https://github.com/rust-lang/crates.io-index",
          checksum: "bbb",
        },
      ],
    });
  });

  it("collects, deduplicates, and maps real license text without absolute paths", () => {
    const { root, cargoMetadata } = createFixture();
    const manifest = buildThirdPartyManifest({ rootDir: root, cargoMetadata });
    const bundle = buildLicenseTextBundle({
      rootDir: root,
      manifest,
      cargoMetadata,
    });

    expect(bundle.manifest.summary).toEqual({
      componentCount: 4,
      componentsWithLicenseTextCount: 4,
      missingLicenseTextCount: 0,
      licenseMetadataWithoutTextCount: 0,
      missingLicenseMetadataWithTextCount: 1,
      uniqueLicenseTextCount: 4,
    });
    const alpha = bundle.manifest.components.find(({ name }) => name === "alpha");
    const runtime = bundle.manifest.components.find(
      ({ name }) => name === "runtime-zeta",
    );
    const sharedAlpha = alpha.licenseTexts.find(({ sourceNames }) =>
      sourceNames.includes("LICENSE-MIT"),
    );
    const sharedRuntime = runtime.licenseTexts.find(({ sourceNames }) =>
      sourceNames.includes("LICENSE"),
    );
    expect(sharedAlpha.sha256).toBe(sharedRuntime.sha256);
    expect(alpha.licenseTexts.find(({ sourceNames }) => sourceNames.includes("NOTICE"))).toMatchObject({
      kinds: ["notice"],
    });

    const outputDir = join(root, "generated", "licenses");
    const written = writeLicenseTextBundle({ rootDir: root, outputDir, bundle });
    expect(written).toEqual(bundle.manifest);
    expect(existsSync(join(outputDir, "LICENSE-TEXTS.json"))).toBe(true);
    expect(readdirSync(join(outputDir, "texts"))).toHaveLength(4);
    const serialized = serializeLicenseTextManifest(
      JSON.parse(readFileSync(join(outputDir, "LICENSE-TEXTS.json"), "utf8")),
    );
    expect(serialized).not.toContain(root.replaceAll("\\", "/"));
    expect(serialized).not.toContain(basename(root));
  });

  it("fails the strict text gate when SPDX metadata exists but text is absent", () => {
    const { root, cargoMetadata } = createFixture();
    unlinkSync(join(root, "node_modules", "runtime-zeta", "LICENSE"));
    writeFileSync(
      join(root, "node_modules", "runtime-zeta", "NOTICE"),
      "A notice is not a license grant.\n",
    );
    writeFileSync(join(root, "cargo-metadata.json"), JSON.stringify(cargoMetadata));
    const stdout = [];
    const stderr = [];
    const exitCode = runCli(
      [
        "--root",
        root,
        "--cargo-metadata-file",
        "cargo-metadata.json",
        "--output",
        "generated/manifest.json",
        "--licenses-output-dir",
        "generated/licenses",
        "--fail-on-missing-license-text",
      ],
      {
        stdout: { write: (value) => stdout.push(value) },
        stderr: { write: (value) => stderr.push(value) },
      },
    );

    expect(exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("1 component(s) without collected license text");
    const licenseManifest = JSON.parse(
      readFileSync(join(root, "generated", "licenses", "LICENSE-TEXTS.json"), "utf8"),
    );
    expect(licenseManifest.summary).toMatchObject({
      missingLicenseTextCount: 1,
      licenseMetadataWithoutTextCount: 1,
    });
    expect(
      licenseManifest.components.find(({ name }) => name === "runtime-zeta"),
    ).toMatchObject({
      license: "MIT",
      missingLicense: false,
      missingLicenseText: true,
      licenseMetadataWithoutText: true,
    });
    expect(
      licenseManifest.components
        .find(({ name }) => name === "runtime-zeta")
        .licenseTexts.flatMap(({ kinds }) => kinds),
    ).toEqual(["notice"]);
  });

  it("adds only hash-pinned immutable license overlays to an exact component", () => {
    const { root, cargoMetadata } = createFixture();
    unlinkSync(join(root, "cargo-cache", "alpha", "LICENSE-MIT"));
    const textPath = join(root, "compliance", "license-texts", "alpha-MIT.txt");
    mkdirSync(join(root, "compliance", "license-texts"), { recursive: true });
    writeFileSync(textPath, "reviewed upstream license\n");
    const sha256 = createHash("sha256").update(readFileSync(textPath)).digest("hex");
    const overlayPath = join(root, "compliance", "license-overlays.json");
    const overlayManifest = {
      schemaVersion: 1,
      entries: [{
        ecosystem: "cargo",
        name: "alpha",
        version: "1.2.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        integrity: "aaa",
        license: "MIT OR Apache-2.0",
        vcsCommit: "1".repeat(40),
        vcsUrl: `https://github.com/example/project/commit/${"1".repeat(40)}`,
        files: [{
          path: "compliance/license-texts/alpha-MIT.txt",
          sha256,
          kind: "license",
          sourceType: "repository-revision",
          sourceUrl: `https://raw.githubusercontent.com/example/project/${"1".repeat(40)}/LICENSE`,
        }],
      }],
    };
    writeFileSync(overlayPath, JSON.stringify(overlayManifest));
    const manifest = buildThirdPartyManifest({ rootDir: root, cargoMetadata });
    const overlay = loadLicenseOverlayManifest({
      rootDir: root,
      manifest,
      overlayManifestPath: overlayPath,
    });
    const bundle = buildLicenseTextBundle({
      rootDir: root,
      manifest,
      cargoMetadata,
      licenseOverlayCandidates: overlay.candidates,
      licenseOverlayDescriptor: overlay.descriptor,
    });
    const alpha = bundle.manifest.components.find(({ name }) => name === "alpha");
    expect(alpha).toMatchObject({ overlayApplied: true, missingLicenseText: false });
    expect(alpha.licenseTexts.find(({ sourceNames }) => sourceNames.some((name) => name.startsWith("overlay:")))).toMatchObject({
      provenanceUrls: [`https://raw.githubusercontent.com/example/project/${"1".repeat(40)}/LICENSE`],
      vcsCommits: ["1".repeat(40)],
      vcsUrls: [`https://github.com/example/project/commit/${"1".repeat(40)}`],
      sourceTypes: ["repository-revision"],
    });
    expect(bundle.manifest.licenseOverlayManifest).toMatchObject({ entryCount: 1 });
    const outputDir = join(root, "generated", "licenses");
    writeLicenseTextBundle({
      rootDir: root,
      outputDir,
      bundle,
      overlayManifestPath: overlayPath,
    });
    expect(readFileSync(join(outputDir, "LICENSE-OVERLAYS.json"), "utf8")).toBe(
      readFileSync(overlayPath, "utf8"),
    );
    writeFileSync(overlayPath, `${JSON.stringify(overlayManifest)}\n`);
    expect(() => writeLicenseTextBundle({
      rootDir: root,
      outputDir: join(root, "generated", "changed-overlay"),
      bundle,
      overlayManifestPath: overlayPath,
    })).toThrow(/changed before bundle write/);
    writeFileSync(overlayPath, JSON.stringify(overlayManifest));

    const mutableUrl = structuredClone(overlayManifest);
    mutableUrl.entries[0].files[0].sourceUrl =
      "https://raw.githubusercontent.com/example/project/main/LICENSE";
    writeFileSync(overlayPath, JSON.stringify(mutableUrl));
    expect(() => loadLicenseOverlayManifest({
      rootDir: root,
      manifest,
      overlayManifestPath: overlayPath,
    })).toThrow(/reviewed repository commit/);

    const wrongRepository = structuredClone(overlayManifest);
    wrongRepository.entries[0].files[0].sourceUrl =
      `https://raw.githubusercontent.com/evil/project/${"1".repeat(40)}/LICENSE`;
    writeFileSync(overlayPath, JSON.stringify(wrongRepository));
    expect(() => loadLicenseOverlayManifest({
      rootDir: root,
      manifest,
      overlayManifestPath: overlayPath,
    })).toThrow(/reviewed repository commit/);

    const wrongVcsCommitUrl = structuredClone(overlayManifest);
    wrongVcsCommitUrl.entries[0].vcsUrl =
      `https://github.com/example/project/commit/${"2".repeat(40)}`;
    writeFileSync(overlayPath, JSON.stringify(wrongVcsCommitUrl));
    expect(() => loadLicenseOverlayManifest({
      rootDir: root,
      manifest,
      overlayManifestPath: overlayPath,
    })).toThrow(/reviewed component repository commit/);

    const missingSource = structuredClone(overlayManifest);
    delete missingSource.entries[0].source;
    writeFileSync(overlayPath, JSON.stringify(missingSource));
    expect(() => loadLicenseOverlayManifest({
      rootDir: root,
      manifest,
      overlayManifestPath: overlayPath,
    })).toThrow(/source is required/);

    writeFileSync(overlayPath, JSON.stringify(overlayManifest));
    writeFileSync(textPath, "reviewed upstream license\n");
    const beforeTextMutation = loadLicenseOverlayManifest({
      rootDir: root,
      manifest,
      overlayManifestPath: overlayPath,
    });
    writeFileSync(textPath, "tampered\n");
    expect(() => buildLicenseTextBundle({
      rootDir: root,
      manifest,
      cargoMetadata,
      licenseOverlayCandidates: beforeTextMutation.candidates,
      licenseOverlayDescriptor: beforeTextMutation.descriptor,
    })).toThrow(/changed after review/);
    expect(() => loadLicenseOverlayManifest({
      rootDir: root,
      manifest,
      overlayManifestPath: overlayPath,
    })).toThrow(/hash mismatch/);
  });
});
