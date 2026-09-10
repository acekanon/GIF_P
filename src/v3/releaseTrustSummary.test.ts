import { describe, expect, it } from "vitest";
import type { ReleaseTrustReport } from "../tauri";
import { buildReleaseTrustSummary } from "./releaseTrustSummary";

function report(overrides: Partial<ReleaseTrustReport> = {}): ReleaseTrustReport {
  return {
    schema_version: 1,
    context: "packaged",
    status: "verified",
    manifest_path: "C:\\Users\\Alice\\private\\DISTRIBUTION.json",
    manifest_found: true,
    expected_product_version: "5.7.18",
    reported_product_version: "5.7.18",
    product_version_matches: true,
    actual_executable_name: "GIFP-private-build.exe",
    reported_executable_name: "GIFP.exe",
    executable_name_matches: false,
    actual_executable_sha256: "actual-secret-hash",
    reported_executable_sha256: "reported-secret-hash",
    executable_sha256_matches: true,
    source_dirty: false,
    channel: "public",
    signature_status: "Valid",
    signature_trusted: true,
    public_release_blockers: [],
    runtime_integrity_status: "verified",
    runtime_files_checked: 8,
    runtime_failures: ["C:\\Users\\Alice\\private\\ffmpeg.dll hash mismatch"],
    reasons: ["Private diagnostic reason at C:\\Users\\Alice\\private"],
    ...overrides,
  };
}

describe("release trust share summary", () => {
  it("presents a verified release in copy-ready Chinese", () => {
    expect(buildReleaseTrustSummary(report())).toEqual({
      label: "已验证发行",
      summary: "程序、签名与媒体运行时的发行可信校验已完成。",
      copyText: [
        "GIFP 发行可信摘要",
        "版本：5.7.18",
        "运行环境：已打包环境",
        "状态：已验证发行",
        "发行渠道：public",
        "程序哈希：匹配",
        "发布者签名：Valid（可信）",
        "媒体运行时：完整性通过；已校验 8 个文件",
        "阻断代码：无",
      ].join("\n"),
    });
  });

  it("includes only safe blocker codes and never projects private report fields", () => {
    const presentation = buildReleaseTrustSummary(report({
      status: "blocked",
      executable_sha256_matches: false,
      signature_status: "NotSigned",
      signature_trusted: false,
      runtime_integrity_status: "failed",
      runtime_files_checked: 3,
      public_release_blockers: [
        "unsigned_release",
        "runtime-integrity-failed",
        "unsigned_release",
        "C:\\Users\\Alice\\private",
        "raw reason must not escape",
      ],
    }));

    expect(presentation.label).toBe("发行受阻");
    expect(presentation.copyText).toContain("程序哈希：不匹配");
    expect(presentation.copyText).toContain("发布者签名：NotSigned（不可信）");
    expect(presentation.copyText).toContain("阻断代码：unsigned_release、runtime-integrity-failed");
    expect(presentation.copyText).not.toMatch(/Alice|private|GIFP-private-build|actual-secret|reported-secret|diagnostic|raw reason/i);
  });

  it("replaces unsafe free-form values instead of copying paths or diagnostics", () => {
    const presentation = buildReleaseTrustSummary(report({
      context: "development",
      status: "unverified",
      expected_product_version: "also/unsafe",
      reported_product_version: "C:\\secret\\version",
      channel: "C:\\secret\\channel",
      signature_status: "/home/alice/signature",
      executable_sha256_matches: null,
      signature_trusted: null,
      runtime_integrity_status: "unverified",
      runtime_files_checked: -4,
    }));

    expect(presentation.label).toBe("尚未验证");
    expect(presentation.copyText).toContain("版本：未报告");
    expect(presentation.copyText).toContain("运行环境：开发环境");
    expect(presentation.copyText).toContain("发行渠道：未报告");
    expect(presentation.copyText).toContain("程序哈希：未校验");
    expect(presentation.copyText).toContain("发布者签名：未报告（未校验）");
    expect(presentation.copyText).toContain("媒体运行时：未校验；已校验 0 个文件");
    expect(presentation.copyText).not.toMatch(/secret|alice/i);
  });
});
