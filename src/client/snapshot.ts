import { renderLabel } from '../shared/appRuntime.ts';
import { sanitizeCssColor } from '../shared/sandboxValidator.ts';
import type { AppSpec, StateValue } from '../shared/types.ts';
import { getStageRelativeRect, querySandboxComponentElements } from './sandboxRenderer.ts';

/**
 * サンドボックス内の現在のお題アプリ画面と、ユーザーが描き込んだペン軌跡キャンバスを合成し、
 * Gemini マルチモーダル入力用の PNG Data URL を生成する。
 */
export function captureSandboxSnapshot(
  spec: AppSpec,
  liveState: Record<string, StateValue>,
  sandboxContainer: HTMLElement,
  penCanvas: HTMLCanvasElement | null,
): string {
  const rect = sandboxContainer.getBoundingClientRect();
  const width = Math.max(360, Math.round(rect.width || 480));
  const height = Math.max(420, Math.round(rect.height || 540));

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return '';

  // 背景
  ctx.fillStyle = sanitizeCssColor(spec.theme?.bgColor, '#f8fafc');
  ctx.fillRect(0, 0, width, height);

  // ヘッダー描画
  ctx.fillStyle = sanitizeCssColor(spec.theme?.textColor, '#1e293b');
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(spec.title, 20, 32);

  ctx.fillStyle = '#64748b';
  ctx.font = '12px sans-serif';
  ctx.fillText(spec.subtitle, 20, 52);

  // 各部品の実際のDOM位置（iframe内を含む）と計算済みスタイル・内部テキストを読み取って描画
  const compElements = querySandboxComponentElements(sandboxContainer);
  const variantColors: Record<string, { bg: string; fg: string; border: string }> = {
    default: { bg: '#ffffff', fg: '#1e293b', border: '#cbd5e1' },
    primary: { bg: '#6f4e37', fg: '#ffffff', border: '#5b3a26' },
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

    const { left: x, top: y, width: w, height: h } = getStageRelativeRect(el, rect);
    if (w <= 0 || h <= 0) continue;

    const win = el.ownerDocument.defaultView ?? window;
    const computed = win.getComputedStyle(el);
    const palette = variantColors[comp.style.variant] ?? variantColors.default;
    const bgColor =
      computed.backgroundColor && computed.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? computed.backgroundColor
        : palette.bg;

    if (comp.type === 'popup') {
      // ポップアップの背景幕を半透明で描く
      ctx.fillStyle = 'rgba(20, 10, 5, 0.42)';
      ctx.fillRect(0, 0, width, height);
    }

    ctx.fillStyle = bgColor;
    ctx.strokeStyle = comp.style.skin === 'intrusive' ? '#d50000' : palette.border;
    ctx.lineWidth = comp.style.skin === 'intrusive' ? 3 : 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, comp.style.skin === 'intrusive' ? 2 : 10);
    ctx.fill();
    ctx.stroke();

    const fontSize = fontSizes[comp.style.size] ?? 14;
    ctx.fillStyle = computed.color || palette.fg;
    ctx.font = `bold ${fontSize}px sans-serif`;

    const rawText = (el.innerText || el.textContent || renderLabel(comp, liveState))
      .replace(/\s+/g, ' ')
      .trim();
    const isField = ['select', 'input', 'checkbox', 'toggle', 'slider'].includes(comp.type);
    const stateVal = isField && comp.stateKey ? liveState[comp.stateKey] : undefined;
    const displayLabel =
      stateVal !== undefined && !rawText.includes(String(stateVal))
        ? `${rawText}: ${String(stateVal)}`
        : rawText;
    ctx.fillText(displayLabel.slice(0, 44), x + 12, y + Math.min(h - 8, fontSize + 14));

    // ポップアップの閉じるボタンの位置・大きさもそのままキャンバスに描く
    const closeBtn = el.querySelector<HTMLElement>('.inapp-popup-close');
    if (closeBtn) {
      const cRect = getStageRelativeRect(closeBtn, rect);
      const cx = cRect.left;
      const cy = cRect.top;
      const cw = Math.max(14, cRect.width);
      const ch = Math.max(14, cRect.height);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.beginPath();
      ctx.roundRect(cx, cy, cw, ch, 6);
      ctx.fill();
      ctx.fillStyle = '#1c1917';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText((closeBtn.textContent || '×').trim(), cx + 4, cy + Math.min(ch - 3, 14));
    }
  }

  // ペン描きレイヤーを上に重ねる
  if (penCanvas && penCanvas.width > 0 && penCanvas.height > 0) {
    ctx.drawImage(penCanvas, 0, 0, width, height);
  }

  return out.toDataURL('image/png');
}
