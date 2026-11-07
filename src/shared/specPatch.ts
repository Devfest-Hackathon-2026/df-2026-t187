import { isSafeStateKey } from './appRuntime.ts';
import type { AppComponent, AppSpec, SpecPatch } from './types.ts';

export interface ApplySpecPatchesResult {
  spec: AppSpec;
  warnings: string[];
  touchedComponentIds: Set<string>;
}

/**
 * 同じ種類の部品を差し替える際、Gemini が省略しがちな装飾・構造項目を元の部品から引き継ぐ。
 */
function mergeReplacedComponent(existing: AppComponent, incoming: AppComponent): AppComponent {
  const incomingStyle = incoming.style ?? existing.style;
  const mergedStyle = {
    ...incomingStyle,
    ...(incomingStyle.sticky === undefined && existing.style?.sticky !== undefined
      ? { sticky: existing.style.sticky }
      : {}),
  };
  const label = typeof incoming.label === 'string' ? incoming.label : existing.label;

  if (existing.type !== incoming.type) {
    return {
      ...incoming,
      label,
      style: mergedStyle,
    };
  }

  return {
    ...incoming,
    label,
    icon: incoming.icon ?? existing.icon,
    badge: incoming.badge ?? existing.badge,
    caption: incoming.caption ?? existing.caption,
    priceLabel: incoming.priceLabel ?? existing.priceLabel,
    optionDetails: incoming.optionDetails ?? existing.optionDetails,
    rows: incoming.rows ?? existing.rows,
    options: incoming.options ?? existing.options,
    placeholder: incoming.placeholder ?? existing.placeholder,
    stateKey: incoming.stateKey ?? existing.stateKey,
    closePosition: incoming.closePosition ?? existing.closePosition,
    closeSize: incoming.closeSize ?? existing.closeSize,
    closeLabel: incoming.closeLabel ?? existing.closeLabel,
    popupDelayMs: incoming.popupDelayMs ?? existing.popupDelayMs,
    customHtml: incoming.customHtml ?? existing.customHtml,
    customCss: incoming.customCss ?? existing.customCss,
    style: {
      ...mergedStyle,
      ...(incomingStyle.skin === undefined && existing.style?.skin !== undefined
        ? { skin: existing.style.skin }
        : {}),
    },
  };
}

function findDefaultInsertIndex(components: AppComponent[]): number {
  const stickyOrPopupIdx = components.findIndex((c) => c.style?.sticky || c.type === 'popup');
  return stickyOrPopupIdx === -1 ? components.length : stickyOrPopupIdx;
}

/**
 * 現在の AppSpec に対して差分パッチ配列を安全に適用する。
 * 触っていない部品は一切変更せず、存在しないIDへの操作は警告を残して無視する。
 */
export function applySpecPatches(
  baseSpec: AppSpec,
  patches: SpecPatch[],
): ApplySpecPatchesResult {
  const spec = structuredClone(baseSpec);
  const warnings: string[] = [];
  const touchedComponentIds = new Set<string>();
  const removedTraps: AppComponent[] = [];
  const explicitlySetStateKeys = new Set<string>();

  for (const patch of patches ?? []) {
    if (!patch || typeof patch !== 'object') continue;

    switch (patch.op) {
      case 'remove_component': {
        if (!patch.id) {
          warnings.push('remove_component に id がありません');
          break;
        }
        const idx = spec.components.findIndex((c) => c.id === patch.id);
        if (idx === -1) {
          warnings.push(`存在しない部品IDの削除を無視しました: ${patch.id}`);
          break;
        }
        const [removed] = spec.components.splice(idx, 1);
        if (removed.stateKey && removed.trapSafeValue !== undefined) removedTraps.push(removed);
        touchedComponentIds.add(patch.id);
        break;
      }

      case 'replace_component': {
        const comp = patch.component;
        if (!comp?.id) {
          warnings.push('replace_component に component.id がありません');
          break;
        }
        const idx = spec.components.findIndex((c) => c.id === comp.id);
        if (idx === -1) {
          warnings.push(`存在しない部品IDの差し替えを無視しました: ${comp.id}`);
          break;
        }
        spec.components[idx] = mergeReplacedComponent(spec.components[idx], comp);
        touchedComponentIds.add(comp.id);
        break;
      }

      case 'insert_component': {
        const comp = patch.component;
        if (!comp?.id) {
          warnings.push('insert_component に component.id がありません');
          break;
        }
        const existingIdx = spec.components.findIndex((c) => c.id === comp.id);
        if (existingIdx !== -1) {
          warnings.push(`既存の部品IDへの追加を差し替えとして扱いました: ${comp.id}`);
          spec.components[existingIdx] = mergeReplacedComponent(spec.components[existingIdx], comp);
          touchedComponentIds.add(comp.id);
          break;
        }
        // 同じ画面に同一ラベルの見出しが重複して追加されるのを防ぐ
        if (
          comp.type === 'heading' &&
          spec.components.some(
            (c) =>
              c.type === 'heading' &&
              c.label === comp.label &&
              JSON.stringify(c.visibleWhen ?? null) === JSON.stringify(comp.visibleWhen ?? null),
          )
        ) {
          warnings.push(`同じ見出しの重複追加を無視しました: ${comp.label}`);
          break;
        }

        if (patch.afterId === null || patch.afterId === '') {
          spec.components.unshift(comp);
        } else if (patch.afterId) {
          const anchorIdx = spec.components.findIndex((c) => c.id === patch.afterId);
          if (anchorIdx === -1) {
            warnings.push(`insert_component の基準IDが見つからないため末尾付近へ追加しました: ${patch.afterId}`);
            spec.components.splice(findDefaultInsertIndex(spec.components), 0, comp);
          } else {
            spec.components.splice(anchorIdx + 1, 0, comp);
          }
        } else {
          spec.components.splice(findDefaultInsertIndex(spec.components), 0, comp);
        }
        touchedComponentIds.add(comp.id);
        break;
      }

      case 'move_component': {
        if (!patch.id) {
          warnings.push('move_component に id がありません');
          break;
        }
        const fromIdx = spec.components.findIndex((c) => c.id === patch.id);
        if (fromIdx === -1) {
          warnings.push(`存在しない部品IDの移動を無視しました: ${patch.id}`);
          break;
        }
        const [moving] = spec.components.splice(fromIdx, 1);
        if (patch.afterId === null || patch.afterId === '') {
          spec.components.unshift(moving);
        } else if (patch.afterId) {
          const anchorIdx = spec.components.findIndex((c) => c.id === patch.afterId);
          if (anchorIdx === -1) {
            warnings.push(`move_component の基準IDが見つからないため元の位置に戻しました: ${patch.afterId}`);
            spec.components.splice(fromIdx, 0, moving);
            break;
          }
          spec.components.splice(anchorIdx + 1, 0, moving);
        } else {
          spec.components.splice(findDefaultInsertIndex(spec.components), 0, moving);
        }
        touchedComponentIds.add(patch.id);
        break;
      }

      case 'upsert_state': {
        const v = patch.variable;
        if (!v?.key || !isSafeStateKey(v.key)) {
          warnings.push('upsert_state に有効な variable.key がありません');
          break;
        }
        explicitlySetStateKeys.add(v.key);
        const existing = spec.state.find((s) => s.key === v.key);
        if (existing) {
          existing.label = v.label || existing.label;
          existing.type = v.type || existing.type;
          existing.initialValue = v.initialValue;
        } else {
          spec.state.push({ ...v });
        }
        break;
      }

      case 'upsert_derived': {
        if (!patch.key || !isSafeStateKey(patch.key) || !patch.expression) {
          warnings.push('upsert_derived に有効な key または expression がありません');
          break;
        }
        if (!spec.derived) spec.derived = [];
        const existing = spec.derived.find((d) => d.key === patch.key);
        if (existing) {
          existing.expression = patch.expression;
        } else {
          spec.derived.push({ key: patch.key, expression: patch.expression });
        }
        break;
      }
    }
  }

  // 罠の部品（最初からチェック入りの定期便など）を消しても、状態の値が罠のまま残ると、
  // 画面にない申し込みに全員が気づかず申し込むことになる。その状態を使う部品がもうなく、
  // 同じ手直しで値を指定していなければ、罠を外した値に戻す。変数自体は「店にあった」印として残す
  for (const trap of removedTraps) {
    const key = trap.stateKey!;
    if (explicitlySetStateKeys.has(key)) continue;
    if (spec.components.some((c) => c.stateKey === key)) continue;
    const variable = spec.state.find((s) => s.key === key);
    if (variable) variable.initialValue = trap.trapSafeValue!;
  }

  return { spec, warnings, touchedComponentIds };
}
