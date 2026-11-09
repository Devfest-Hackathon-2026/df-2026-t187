// 判定用の座標を、見えている画面ではなく決まった条件で描画した画面から測るための決まり。
// 描画と測る処理はブラウザ（src/client/fixedLayoutMeasure.ts）が行い、
// 測った値を判定用の座標にそろえる計算と、どの状態で描画するかはここで決める（テストできるように画面に依存しない）

import { createInitialState, isComponentVisible, type AppState } from './appRuntime.ts';
import type { AppSpec, ComponentBoundsInput, StateValue } from './types.ts';

/**
 * 判定用に描画するスマホ画面の大きさ（CSSピクセル）。
 * 幅は操作シミュレーターの画面幅（SCREEN_WIDTH = 320）と同じにし、片手の親指が届く範囲などの基準とそろえる。
 * 高さは、9:16 のスマホ枠から枠の太さを除いた画面の比率に合わせる
 */
export const FIXED_LAYOUT_VIEWPORT = { width: 320, height: 583 } as const;

/** 画面下に固定したバーを、本文の下に並べるときの間隔。座標なしの見積もり配置と同じ 8px */
const STICKY_GAP = 8;

/** 描画した画面で測った、部品1つの枠。値は getBoundingClientRect と同じく、描画した画面の左上が原点 */
export interface MeasuredComponentRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 画面下に固定したバーの中の部品か */
  sticky: boolean;
}

/** 測ったときの画面の状態 */
export interface MeasuredFrame {
  /** 描画した画面の幅 */
  viewportWidth: number;
  /** 本文のスクロール位置 */
  scrollTop: number;
  /** 本文の上端の位置（スクロールしても動かない） */
  bodyTop: number;
  /** 本文の中身全体の高さ */
  bodyScrollHeight: number;
  /** 画面下に固定したバーの上端の位置。バーがなければ undefined */
  stickyBarTop?: number;
}

/**
 * 測った枠を、判定用の座標にそろえる。
 * - 本文の部品は、スクロール位置を足して、本文の先頭から並べた位置にする（スクロールしていても同じ値になる）
 * - 固定したバーの部品は、本文の下に続けて置く（座標なしの見積もり配置と同じ並べ方。本文の部品と重ならない）
 * - 描画した画面の幅が基準と違っても、基準の幅に縮尺をそろえる
 * - 小数は四捨五入する
 */
export function canonicalizeMeasuredBounds(
  rects: MeasuredComponentRect[],
  frame: MeasuredFrame,
): ComponentBoundsInput[] {
  const scale = frame.viewportWidth > 0 ? frame.viewportWidth / FIXED_LAYOUT_VIEWPORT.width : 1;
  const contentBottom = frame.bodyTop + frame.bodyScrollHeight;
  const out: ComponentBoundsInput[] = [];
  for (const r of rects) {
    if (!(r.right > r.left && r.bottom > r.top)) continue;
    let top: number;
    let bottom: number;
    if (r.sticky && frame.stickyBarTop !== undefined) {
      const offset = contentBottom + STICKY_GAP * scale - frame.stickyBarTop;
      top = r.top + offset;
      bottom = r.bottom + offset;
    } else {
      top = r.top + frame.scrollTop;
      bottom = r.bottom + frame.scrollTop;
    }
    out.push({
      id: r.id,
      left: Math.round(r.left / scale),
      top: Math.round(top / scale),
      right: Math.round(r.right / scale),
      bottom: Math.round(bottom / scale),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 判定用に描画する状態の一覧。最初の状態に加え、確認画面のように表示条件でだけ出る部品があれば、
 * その部品が見える状態も描画する。広告は出る前（最初の状態）のまま描き、完了ページなどの途中の表示は含めない
 */
export function fixedLayoutStateVariants(spec: AppSpec): AppState[] {
  const initial = createInitialState(spec);
  const variants: AppState[] = [initial];
  const seen = new Set<string>();
  for (const comp of spec.components) {
    if (comp.type === 'popup' || !comp.visibleWhen || isComponentVisible(comp, initial)) continue;
    const { stateKey, operator, value } = comp.visibleWhen;
    let next: StateValue;
    if (operator === 'eq') next = value;
    else if (operator === 'gt') next = Number(value) + 1;
    else if (operator === 'lt') next = Number(value) - 1;
    else next = `${String(value)}__other`;
    const key = `${stateKey}=${JSON.stringify(next)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ ...initial, [stateKey]: next });
  }
  return variants;
}

/** 状態ごとに測った座標をまとめる。同じ部品は、先に描画した状態（最初の状態）の座標を使う */
export function mergeBoundsVariants(variants: ComponentBoundsInput[][]): ComponentBoundsInput[] {
  const byId = new Map<string, ComponentBoundsInput>();
  for (const list of variants) {
    for (const b of list) {
      if (!byId.has(b.id)) byId.set(b.id, b);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
