import { renderLabel } from '../shared/appRuntime.ts';
import type { AppSpec, StateValue } from '../shared/types.ts';
import { querySandboxComponentElements } from './sandboxRenderer.ts';

export interface SnapshotVisionOptions {
  blurPx?: number;
  contrast?: number;
}

/**
 * サンドボックス内の現在のお題アプリ画面と、ユーザーが描き込んだペン軌跡キャンバスを合成し、
 * Gemini マルチモーダル入力用の PNG Data URL を生成する。
 * レビューAI向けには視力制約（ぼかし・コントラスト低下）をキャンバス描画時に適用できる。
 */
export function captureSandboxSnapshot(
  spec: AppSpec,
  liveState: Record<string, StateValue>,
  sandboxContainer: HTMLElement,
  penCanvas: HTMLCanvasElement | null,
  visionOptions?: SnapshotVisionOptions,
): string {
  const rect = sandboxContainer.getBoundingClientRect();
  const width = Math.max(360, Math.round(rect.width || 480));
  const height = Math.max(420, Math.round(rect.height || 540));

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return '';

  // 視力制約（ぼかし・コントラスト低下）の適用
  const filters: string[] = [];
  if (visionOptions?.blurPx && visionOptions.blurPx > 0) {
    filters.push(`blur(${visionOptions.blurPx}px)`);
  }
  if (visionOptions?.contrast && visionOptions.contrast !== 1) {
    filters.push(`contrast(${Math.round(visionOptions.contrast * 100)}%)`);
  }
  if (filters.length > 0) {
    ctx.filter = filters.join(' ');
  }

  // 背景
  ctx.fillStyle = spec.theme.bgColor || '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // ヘッダー描画
  ctx.fillStyle = spec.theme.textColor || '#1e293b';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(spec.title, 20, 32);

  ctx.fillStyle = '#64748b';
  ctx.font = '12px sans-serif';
  ctx.fillText(spec.subtitle, 20, 52);

  // 各部品の実際のDOM位置（iframe内を含む）とスタイルを読み取って描画
  const compElements = querySandboxComponentElements(sandboxContainer);
  const variantColors: Record<string, { bg: string; fg: string; border: string }> = {
    default: { bg: '#ffffff', fg: '#1e293b', border: '#cbd5e1' },
    primary: { bg: '#2563eb', fg: '#ffffff', border: '#1d4ed8' },
    danger: { bg: '#dc2626', fg: '#ffffff', border: '#b91c1c' },
    warning: { bg: '#f59e0b', fg: '#1e293b', border: '#d97706' },
    success: { bg: '#16a34a', fg: '#ffffff', border: '#15803d' },
    muted: { bg: '#e2e8f0', fg: '#64748b', border: '#cbd5e1' },
  };
  const fontSizes: Record<string, number> = {
    xs: 10,
    sm: 12,
    md: 14,
    lg: 18,
    xl: 22,
  };

  for (const el of compElements) {
    const id = el.dataset.componentId;
    const comp = spec.components.find((c) => c.id === id);
    if (!comp) continue;

    const elRect = el.getBoundingClientRect();
    const isInsideIframe = el.ownerDocument !== document;
    const x = isInsideIframe ? elRect.left : elRect.left - rect.left;
    const y = isInsideIframe ? elRect.top : elRect.top - rect.top;
    const w = elRect.width;
    const h = elRect.height;

    const palette = variantColors[comp.style.variant] ?? variantColors.default;
    ctx.fillStyle = palette.bg;
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();

    const fontSize = fontSizes[comp.style.size] ?? 14;
    ctx.fillStyle = palette.fg;
    ctx.font = `bold ${fontSize}px sans-serif`;
    // 入力欄は選ばれている値も一緒に描く。ラベル内の {状態キー} は現在の値に置き換える
    const label = renderLabel(comp, liveState);
    const isField = ['select', 'input', 'checkbox', 'toggle', 'slider'].includes(comp.type);
    const stateVal = isField && comp.stateKey ? liveState[comp.stateKey] : undefined;
    const displayLabel = stateVal !== undefined ? `${label}: ${String(stateVal)}` : label;
    ctx.fillText(displayLabel.slice(0, 36), x + 12, y + Math.min(h - 8, fontSize + 12));
  }

  ctx.filter = 'none';

  // ペン描きレイヤーを上に重ねる
  if (penCanvas && penCanvas.width > 0 && penCanvas.height > 0) {
    ctx.drawImage(penCanvas, 0, 0, width, height);
  }

  return out.toDataURL('image/png');
}
