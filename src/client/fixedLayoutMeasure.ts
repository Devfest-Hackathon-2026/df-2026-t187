// 判定用の座標を、決まった条件で画面外に描画した画面から測る。
// 見えているスマホ画面の大きさ・スクロール位置・広告が出ているか・完了ページの途中か、には左右されない。
// 部品の大きさや並びの変更は、描画した結果にそのまま表れる

import {
  FIXED_LAYOUT_VIEWPORT,
  canonicalizeMeasuredBounds,
  fixedLayoutStateVariants,
  mergeBoundsVariants,
  type MeasuredComponentRect,
} from '../shared/fixedLayout.ts';
import type { AppSpec, ComponentBoundsInput } from '../shared/types.ts';
import { querySandboxComponentElements, refitMeasuredSandbox, renderSandboxApp } from './sandboxRenderer.ts';

const CACHE_LIMIT = 20;
const cache = new Map<string, Promise<ComponentBoundsInput[] | undefined>>();
/** 同時に2つの画面を測らないよう、1つずつ順に測る */
let queue: Promise<unknown> = Promise.resolve();

const NO_ANIMATION_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; }';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => window.setTimeout(resolve, ms))]);
}

/** iframe に写したスタイルシートと文字の読み込みを待つ。読み込みが遅くても、上限の時間で先に進む */
async function waitForStylesAndFonts(doc: Document): Promise<void> {
  const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
  await withTimeout(
    Promise.all(
      links.map(
        (link) =>
          new Promise<void>((resolve) => {
            if (link.sheet) return resolve();
            link.addEventListener('load', () => resolve(), { once: true });
            link.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    ),
    3000,
  );
  if (doc.fonts?.ready) await withTimeout(doc.fonts.ready, 3000);
}

function measureCurrent(host: HTMLElement): ComponentBoundsInput[] {
  const iframe = host.querySelector<HTMLIFrameElement>('iframe.sandbox-iframe');
  const doc = iframe?.contentDocument;
  const body = doc?.querySelector<HTMLElement>('.sandbox-app-body');
  if (!doc || !body) return [];
  const stickyBar = doc.querySelector<HTMLElement>('.sandbox-sticky-bar');
  const rects: MeasuredComponentRect[] = [];
  for (const el of querySandboxComponentElements(host)) {
    const id = el.dataset.componentId;
    if (!id) continue;
    const r = el.getBoundingClientRect();
    rects.push({
      id,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      sticky: Boolean(el.closest('.sandbox-sticky-bar')),
    });
  }
  return canonicalizeMeasuredBounds(rects, {
    viewportWidth: doc.documentElement.clientWidth,
    scrollTop: body.scrollTop,
    bodyTop: body.getBoundingClientRect().top,
    bodyScrollHeight: body.scrollHeight,
    stickyBarTop: stickyBar ? stickyBar.getBoundingClientRect().top : undefined,
  });
}

async function measureNow(spec: AppSpec): Promise<ComponentBoundsInput[] | undefined> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.className = 'fixed-layout-measure-host';
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${FIXED_LAYOUT_VIEWPORT.width}px`,
    height: `${FIXED_LAYOUT_VIEWPORT.height}px`,
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  document.body.appendChild(host);
  const noop = { onStateChange: () => {}, onStatePatch: () => {}, onNotice: () => {} };
  try {
    const variants: ComponentBoundsInput[][] = [];
    let prepared = false;
    for (const variantState of fixedLayoutStateVariants(spec)) {
      renderSandboxApp(host, spec, variantState, new Set(), noop, { measureOnly: true });
      if (!prepared) {
        const doc = host.querySelector<HTMLIFrameElement>('iframe.sandbox-iframe')?.contentDocument;
        if (doc) {
          const style = doc.createElement('style');
          style.textContent = NO_ANIMATION_CSS;
          doc.head.appendChild(style);
          await waitForStylesAndFonts(doc);
        }
        prepared = true;
        refitMeasuredSandbox(host);
      }
      variants.push(measureCurrent(host));
    }
    const merged = mergeBoundsVariants(variants);
    return merged.length > 0 ? merged : undefined;
  } catch {
    return undefined;
  } finally {
    host.remove();
  }
}

/**
 * 画面の定義から、判定用の座標を測る。同じ画面の定義なら、同じ値を返す（測った値は覚えておく）。
 * 測れなかったときは undefined を返し、サーバーは部品の大きさから見積もった配置で判定する
 */
export function measureFixedLayoutBounds(spec: AppSpec): Promise<ComponentBoundsInput[] | undefined> {
  const key = JSON.stringify(spec);
  const cached = cache.get(key);
  if (cached) return cached;
  const task = queue.then(() => measureNow(spec));
  queue = task.catch(() => undefined);
  cache.set(key, task);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  // 測れなかった結果は覚えず、次に測り直す
  void task.then((bounds) => {
    if (!bounds && cache.get(key) === task) cache.delete(key);
  });
  return task;
}
