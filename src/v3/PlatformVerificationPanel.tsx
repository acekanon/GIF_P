import { CheckCircle, Circle, Monitor, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef } from "react";
import {
  PLATFORM_DELIVERY_EVIDENCE,
  assessPlatformDeliveryEvidence,
  type PlatformDeliveryEvidence,
  type PlatformDeliveryEvidenceAssessment,
  type PlatformDeliveryLifecycle,
} from "./platformDeliveryEvidence";
import { PLATFORM_POLICIES, type PlatformPolicy } from "./platformPolicy";
import "./PlatformVerificationPanel.css";

const STATE_COPY: Record<PlatformDeliveryEvidenceAssessment["state"], { label: string; detail: string }> = {
  device_verified: { label: "已实机验证", detail: "当前规则版本已完成五步交付验证" },
  rule_inferred: { label: "规则推断 · 待实测", detail: "仅依据格式规则，尚无真实客户端证据" },
  evidence_expired: { label: "实机证据已过期", detail: "历史验证超过有效期，需要重新实测" },
  invalid: { label: "实机证据无效", detail: "证据不完整或与当前规则不一致" },
};

const LIFECYCLE_STAGES: readonly { key: keyof PlatformDeliveryLifecycle; label: string }[] = [
  { key: "send", label: "发送" },
  { key: "receiverPlayback", label: "接收端播放" },
  { key: "forward", label: "转发" },
  { key: "download", label: "下载" },
  { key: "reopen", label: "重新打开" },
];

const SOURCE_KIND_LABELS: Record<PlatformPolicy["source"]["kind"], string> = {
  official: "官方文档",
  client_test: "客户端实测",
  product_guidance: "产品建议",
};

export type PlatformVerificationRow = {
  policy: PlatformPolicy;
  evidence?: PlatformDeliveryEvidence;
  assessment: PlatformDeliveryEvidenceAssessment;
};

export function derivePlatformVerificationRows(
  policies: readonly PlatformPolicy[] = PLATFORM_POLICIES,
  evidenceRecords: readonly PlatformDeliveryEvidence[] = PLATFORM_DELIVERY_EVIDENCE,
  now?: Date,
): PlatformVerificationRow[] {
  return policies.map((policy) => {
    const evidence = evidenceRecords.find((record) => record.policyId === policy.id);
    return {
      policy,
      evidence,
      assessment: assessPlatformDeliveryEvidence(policy, evidence, now ? { now } : undefined),
    };
  });
}

export function PlatformVerificationPanel({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const rows = derivePlatformVerificationRows();
  const verifiedCount = rows.filter((row) => row.assessment.state === "device_verified").length;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="platform-verification-layer">
      <button
        type="button"
        className="platform-verification-mask"
        aria-label="点击遮罩关闭平台交付验证"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        className="platform-verification-panel paper-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="platform-verification-head">
          <div>
            <small>DELIVERY EVIDENCE</small>
            <h2 id={titleId}>真实平台交付验证</h2>
            <p>规则能减少失败，但只有完整通过发送到重新打开的五步链路，才算实机验证。</p>
          </div>
          <div className="platform-verification-head-actions">
            <span aria-label={`${verifiedCount} 个平台已有实机验证`}>{verifiedCount} / {rows.length} 已实测</span>
            <button type="button" aria-label="关闭平台交付验证" onClick={onClose}><X weight="bold" /></button>
          </div>
        </header>

        <div className="platform-verification-summary" role="note">
          <Monitor weight="duotone" />
          <div>
            <strong>{verifiedCount === 0 ? "当前没有可声明的实机验证" : `${verifiedCount} 个平台证据有效`}</strong>
            <span>没有证据时只展示规则推断；过期或无效证据不会被降格包装成“已验证”。</span>
          </div>
        </div>

        <div className="platform-verification-grid" aria-label="平台验证状态">
          {rows.map(({ policy, evidence, assessment }) => {
            const copy = STATE_COPY[assessment.state];
            return (
              <article className={`platform-verification-card is-${assessment.state}`} key={policy.id}>
                <div className="platform-verification-card-head">
                  <div>
                    <h3>{policy.label}</h3>
                    <p>{policy.surface}</p>
                  </div>
                  <span className="platform-verification-state">
                    {assessment.state === "device_verified" ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}
                    {copy.label}
                  </span>
                </div>

                <p className="platform-verification-state-detail">{copy.detail}</p>
                <dl className="platform-verification-facts">
                  <div><dt>规则版本</dt><dd>revision {policy.revision}</dd></div>
                  <div>
                    <dt>来源</dt>
                    <dd>
                      {policy.source.url ? (
                        <a href={policy.source.url} target="_blank" rel="noreferrer">
                          {SOURCE_KIND_LABELS[policy.source.kind]} · {policy.source.label}
                        </a>
                      ) : `${SOURCE_KIND_LABELS[policy.source.kind]} · ${policy.source.label}`}
                    </dd>
                  </div>
                  <div><dt>回退格式</dt><dd>{policy.fallbackFormat.toUpperCase()}</dd></div>
                  <div><dt>实测客户端</dt><dd>{evidence?.client || "待实测"}</dd></div>
                </dl>

                <div className="platform-verification-lifecycle" aria-label={`${policy.label} 五步交付要求`}>
                  <strong>五步交付要求</strong>
                  <ol>
                    {LIFECYCLE_STAGES.map((stage) => {
                      const complete = evidence?.lifecycle?.[stage.key] === true;
                      return (
                        <li className={complete ? "is-complete" : "is-pending"} key={stage.key}>
                          {complete ? <CheckCircle weight="fill" /> : <Circle weight="bold" />}
                          <span>{stage.label}</span>
                          <small>{complete ? "已记录" : "待实测"}</small>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </article>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
