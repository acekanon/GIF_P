import { describe, expect, it } from "vitest";
import { QUICK_DELIVERY_SCENARIOS } from "./quickDeliveryModel";
import {
  PLATFORM_POLICIES,
  PLATFORM_POLICY_SET_VERSION,
  platformPolicyById,
  platformPolicyVerificationLabel,
} from "./platformPolicy";

describe("platform policy registry", () => {
  it("versions every quick-delivery surface and keeps scenario guidance aligned", () => {
    expect(PLATFORM_POLICY_SET_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
    expect(PLATFORM_POLICIES.map((policy) => policy.id)).toEqual(
      QUICK_DELIVERY_SCENARIOS.map((scenario) => scenario.id),
    );

    for (const scenario of QUICK_DELIVERY_SCENARIOS) {
      const policy = platformPolicyById(scenario.id);
      expect(policy).toBeDefined();
      expect(policy?.acceptedFormats).toContain(scenario.format);
      expect(policy?.guidance.maxWidth).toBe(scenario.width);
      expect(policy?.guidance.maxFps).toBe(scenario.fps);
      expect(policy?.guidance.maxDurationSeconds).toBe(scenario.maxDuration);
      expect(policy?.guidance.targetSizeMb).toBe(scenario.targetSizeMb);
      expect(policy?.guidance.aspect).toBe(scenario.aspect);
    }
  });

  it("does not claim any chat client is verified before full lifecycle evidence exists", () => {
    const chatPolicies = PLATFORM_POLICIES.filter((policy) =>
      ["qq_chat", "wechat_chat", "wechat_sticker", "feishu_chat"].includes(policy.id),
    );
    expect(chatPolicies.every((policy) => policy.verification === "unverified")).toBe(true);
    expect(chatPolicies.every((policy) => policy.testedClients.length === 0)).toBe(true);
    expect(platformPolicyVerificationLabel("unverified")).toBe("待客户端实测");
  });

  it("requires a real source URL for every documented policy", () => {
    const documented = PLATFORM_POLICIES.filter((policy) => policy.verification === "documented");
    expect(documented.length).toBeGreaterThan(0);
    expect(documented.every((policy) => policy.source.kind === "official")).toBe(true);
    expect(documented.every((policy) => policy.source.url?.startsWith("https://"))).toBe(true);
  });
});
