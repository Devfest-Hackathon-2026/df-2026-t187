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

  const matched: { id: string; score: number }[] = [];

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

    // 部品面積の 20% 以上が重なっているか、部品の中心がペン囲み領域に入っていれば対象とみなす
    if (centerContained || overlapRatio >= 0.2) {
      matched.push({
        id: rect.id,
        score: (centerContained ? 1 : 0) + overlapRatio,
      });
    }
  }

  matched.sort((a, b) => b.score - a.score);
  return matched.map((m) => m.id);
}
