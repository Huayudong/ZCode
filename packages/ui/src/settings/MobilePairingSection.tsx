/**
 * 移动端配对分区：桌面（Web 形态）出配对二维码 + 已配对设备管理。
 * 数据面走同源 REST /api/pairing/*（cookie 鉴权，dev 下经 vite 代理）。
 * 行为规范：docs/specs/harmony/pairing.md §1/§5。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface PairingCodeResponse {
  pairCode: string;
  pairCodeId: string;
  expiresAt: string;
  certFingerprint?: string;
}

interface DeviceRecord {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

type PairingUiState = "idle" | "issuing" | "ready" | "expired";

/** 二维码 URL 由 UI 拼装：Web 自身 location 才是手机可达地址（pairing spec §1）。 */
function buildPairUrl(options: {
  pairCode: string;
  serverName?: string;
  certFingerprint?: string;
}): string {
  const params = new URLSearchParams();
  params.set("host", window.location.hostname);
  params.set("port", window.location.port || (window.location.protocol === "https:" ? "443" : "80"));
  params.set("token", options.pairCode);
  const name = options.serverName?.trim();
  if (name) {
    params.set("name", name);
  }
  const fingerprint = options.certFingerprint?.trim();
  if (fingerprint) {
    params.set("fp", fingerprint);
  }
  return `zcode://pair?${params.toString()}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchPairingApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function MobilePairingSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const [uiState, setUiState] = useState<PairingUiState>("idle");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [expiresAtMs, setExpiresAtMs] = useState<number>(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [serverCertFingerprint, setServerCertFingerprint] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const issueRequestIdRef = useRef(0);

  const loadDevices = useCallback(async () => {
    setDevicesError(null);
    try {
      const body = await fetchPairingApi<{ devices: DeviceRecord[] }>("/api/pairing/devices");
      setDevices(body.devices);
    } catch (error) {
      setDevicesError(getErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      void loadDevices();
    }
  }, [isDesktop, loadDevices]);

  // 倒计时：每秒刷新剩余时间，归零进入过期态。
  useEffect(() => {
    if (uiState !== "ready") {
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (remaining <= 0) {
        setUiState("expired");
        setQrDataUrl(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [uiState, expiresAtMs]);

  const issuePairingCode = useCallback(async () => {
    const requestId = issueRequestIdRef.current + 1;
    issueRequestIdRef.current = requestId;
    setUiState("issuing");
    setErrorMessage(null);
    try {
      const body = await fetchPairingApi<PairingCodeResponse>("/api/pairing/code", {
        method: "POST",
        body: "{}",
      });
      if (issueRequestIdRef.current !== requestId) {
        return;
      }
      const pairUrl = buildPairUrl({
        pairCode: body.pairCode,
        certFingerprint: body.certFingerprint,
      });
      const dataUrl = await QRCode.toDataURL(pairUrl, { margin: 1, width: 220 });
      if (issueRequestIdRef.current !== requestId) {
        return;
      }
      setServerCertFingerprint(body.certFingerprint);
      setExpiresAtMs(Date.parse(body.expiresAt));
      setQrDataUrl(dataUrl);
      setUiState("ready");
    } catch (error) {
      if (issueRequestIdRef.current !== requestId) {
        return;
      }
      setErrorMessage(getErrorMessage(error));
      setUiState("idle");
    }
  }, []);

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      if (confirmingRevokeId !== deviceId) {
        // 破坏性操作二次确认：第一次点击进入确认态，再次点击才真正吊销。
        setConfirmingRevokeId(deviceId);
        return;
      }
      setConfirmingRevokeId(null);
      try {
        await fetchPairingApi(`/api/pairing/devices/${encodeURIComponent(deviceId)}`, {
          method: "DELETE",
        });
      } finally {
        await loadDevices();
      }
    },
    [confirmingRevokeId, loadDevices],
  );

  if (isDesktop) {
    return (
      <div className="space-y-6">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.mobilePairing.title" })}
            description={intl.formatMessage({ id: "settings.mobilePairing.desktopUnavailable" })}
            control={null}
          />
        </SettingsGroupCard>
      </div>
    );
  }

  const activeDevices = devices.filter((device) => !device.revokedAt);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.mobilePairing.title" })}
          description={intl.formatMessage({ id: "settings.mobilePairing.description" })}
          control={
            <Button onClick={() => void issuePairingCode()} disabled={uiState === "issuing"}>
              {uiState === "issuing"
                ? intl.formatMessage({ id: "settings.mobilePairing.issuing" })
                : uiState === "ready"
                  ? intl.formatMessage({ id: "settings.mobilePairing.regenerate" })
                  : intl.formatMessage({ id: "settings.mobilePairing.generate" })}
            </Button>
          }
        />
      </SettingsGroupCard>

      {errorMessage ? (
        <div className="rounded-xl border border-destructive bg-transparent px-4 py-3 text-ui-base text-destructive">
          {intl.formatMessage({ id: "settings.mobilePairing.loadError" }, { message: errorMessage })}
        </div>
      ) : null}

      {uiState === "ready" && qrDataUrl ? (
        <SettingsGroupCard>
          <div className="flex flex-col items-center gap-3 px-4 py-6">
            {/* 二维码只含一次性 pairCode，过期自动失效；不含任何长期凭据。 */}
            <img src={qrDataUrl} alt="zcode://pair QR code" className="h-56 w-56 rounded-lg bg-white p-2" />
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.mobilePairing.scanHint" })}
            </p>
            <p className="text-ui-sm tabular-nums text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.mobilePairing.expiresInSeconds" },
                { seconds: remainingSeconds },
              )}
            </p>
            {serverCertFingerprint ? (
              <p className="break-all text-center text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "settings.mobilePairing.fingerprint" })}
                {serverCertFingerprint}
              </p>
            ) : null}
          </div>
        </SettingsGroupCard>
      ) : uiState === "expired" ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-6 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mobilePairing.expired" })}
        </div>
      ) : null}

      <SettingsGroupCard>
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.mobilePairing.devices" })}
          </span>
          <Button variant="ghost" onClick={() => void loadDevices()}>
            {intl.formatMessage({ id: "settings.mobilePairing.refresh" })}
          </Button>
        </div>
        {devicesError ? (
          <div className="px-4 pb-3 text-ui-sm text-destructive">
            {intl.formatMessage(
              { id: "settings.mobilePairing.loadError" },
              { message: devicesError },
            )}
          </div>
        ) : activeDevices.length === 0 ? (
          <div className="px-4 pb-4 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.mobilePairing.noDevices" })}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {activeDevices.map((device) => (
              <li key={device.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-ui-base">{device.deviceName}</p>
                  <p className="text-ui-xs text-foreground-subtle">
                    {new Date(device.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void revokeDevice(device.id)}
                >
                  {confirmingRevokeId === device.id
                    ? intl.formatMessage({ id: "settings.mobilePairing.revokeConfirm" })
                    : intl.formatMessage({ id: "settings.mobilePairing.revoke" })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroupCard>
    </div>
  );
}
