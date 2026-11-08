// ペン囲みの軌跡座標と画面上のUI部品矩形の当たり判定ロジック

export interface Point2D {
  x: number;
  y: number;
}

export interface Rect2D {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 手前に重なって下の部品を隠す部品には occludes を付ける。
 * 画面の端に固定した部品（pinned）は、その背景の帯が画面の近いほうの端まで続くものとして扱う
 */
export interface LayeredRect2D extends Rect2D {
  occludes?: boolean;
  pinned?: boolean;
}

/**
 * 各部品の矩形を、実際に見えている部分だけにする。画面の外にはみ出した部分と、
 * 手前に重なる部品に隠れた部分（上か下の端を覆われた部分）を除き、すべて隠れた部品は外す。
 * 隠れた部分に中心がある部品が、手前の部品を囲んだときにいっしょに選ばれないようにするため
 */
export function clipToVisibleRects(
  rects: LayeredRect2D[],
  viewport: { width: number; height: number },
): Rect2D[] {
  const clip = (r: Rect2D): Rect2D => ({
    id: r.id,
    left: Math.max(0, r.left),
    top: Math.max(0, r.top),
    right: Math.min(viewport.width, r.right),
    bottom: Math.min(viewport.height, r.bottom),
  });
  const occluders = rects
    .filter((r) => r.occludes)
    .map((r) => {
      const c = clip(r);
      if (!r.pinned) return c;
      // 画面下に固定した帯は下の端まで、上に固定した帯は上の端まで覆う
      const nearBottom = (c.top + c.bottom) / 2 > viewport.height / 2;
      return nearBottom ? { ...c, bottom: viewport.height } : { ...c, top: 0 };
    })
    .filter((r) => r.right > r.left && r.bottom > r.top);

  const visible: Rect2D[] = [];
  for (const raw of rects) {
    let { left, top, right, bottom } = clip(raw);
    if (right <= left || bottom <= top) continue;
    let hidden = false;
    if (!raw.occludes) {
      for (const occ of occluders) {
        // 横幅の半分以上を覆う部品だけを、隠すものとして扱う
        const overlapWidth = Math.min(right, occ.right) - Math.max(left, occ.left);
        if (overlapWidth < (right - left) * 0.5) continue;
        if (occ.bottom <= top || occ.top >= bottom) continue;
        if (occ.top <= top && occ.bottom >= bottom) {
          hidden = true;
          break;
        }
        if (occ.top > top && occ.bottom >= bottom) {
          bottom = occ.top; // 下の端が隠れている
        } else if (occ.top <= top && occ.bottom < bottom) {
          top = occ.bottom; // 上の端が隠れている
        }
        // 真ん中だけを覆われているときは、上下どちらも見えているのでそのままにする
      }
    }
    if (hidden || bottom <= top) continue;
    visible.push({ id: raw.id, left, top, right, bottom });
  }
  return visible;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * ペンで描かれた点列から外接矩形(BoundingBox)を計算する。
 */
export function computeStrokeBounds(points: Point2D[], padding = 6): BoundingBox | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

/**
 * ペンの外接矩形と各部品の矩形の重なり面積・中心包含を判定し、
 * ユーザーが囲んだ対象部品の ID リストを返す。
 */
export function detectHitComponents(points: Point2D[], componentRects: Rect2D[]): string[] {
  const bounds = computeStrokeBounds(points, 8);
  if (!bounds) return [];

  const matched: { id: string; centerContained: boolean; overlapRatio: number; overlapArea: number }[] =
    [];

  for (const rect of componentRects) {
    const width = Math.max(1, rect.right - rect.left);
    const height = Math.max(1, rect.bottom - rect.top);
    const centerX = rect.left + width / 2;
    const centerY = rect.top + height / 2;

    const overlapLeft = Math.max(bounds.minX, rect.left);
    const overlapTop = Math.max(bounds.minY, rect.top);
    const overlapRight = Math.min(bounds.maxX, rect.right);
    const overlapBottom = Math.min(bounds.maxY, rect.bottom);

    if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) {
      continue;
    }

    const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
    const rectArea = width * height;
    const overlapRatio = overlapArea / rectArea;

    const centerContained =
      centerX >= bounds.minX &&
      centerX <= bounds.maxX &&
      centerY >= bounds.minY &&
      centerY <= bounds.maxY;

    matched.push({ id: rect.id, centerContained, overlapRatio, overlapArea });
  }

  // 中心まで囲んだ部品があれば、それだけを対象にする。隣の部品に線がはみ出しただけでは選ばない
  const centered = matched.filter((m) => m.centerContained);
  if (centered.length > 0) {
    return centered.sort((a, b) => b.overlapRatio - a.overlapRatio).map((m) => m.id);
  }
  // 大きな部品の一部だけを囲んだときは、一番広く重なった部品を対象にする
  const best = matched.sort((a, b) => b.overlapArea - a.overlapArea)[0];
  return best ? [best.id] : [];
}
