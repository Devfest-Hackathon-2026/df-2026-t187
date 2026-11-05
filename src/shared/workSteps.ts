// 改造の作業内容を、学習者が読める短い言葉の行にする。
// Gemini が返した差分パッチと、変更前後の画面から作るので、実際の変更と食い違わない。

import { createInitialState, renderLabel } from './appRuntime.ts';
import type { AppComponent, AppSpec, SpecPatch } from './types.ts';

export interface WorkStep {
  /** 例: 「今すぐ購入」の押したときの動きを書き換え */
  text: string;
  /** スマホの中で光らせる部品 */
  componentId?: string;
}

const MAX_LABEL_LENGTH = 14;

const KNOWN_KEY_LABELS: Record<string, string> = {
  unitPrice: '商品の値段',
  shippingFee: '送料',
  quantity: '数量',
  deliveryAddress: 'お届け先',
  paymentMethod: '支払い方法',
  subtotal: '小計',
  shipping: '送料',
  codFee: '代引き手数料',
  paymentFee: '決済手数料',
  fee: '手数料',
  commission: '手数料',
  discount: '割引額',
  tax: '消費税',
  total: '合計金額',
  step: '画面の段階',
  subscription: '定期便',
  newsletter: 'メルマガ',
  signupPassword: '会員登録',
};

function friendlyKeyLabel(key: string, spec: AppSpec, explicitLabel?: string): string {
  if (explicitLabel && !/^[A-Za-z0-9_]+$/.test(explicitLabel.trim())) {
    return explicitLabel.trim();
  }
  if (KNOWN_KEY_LABELS[key]) return KNOWN_KEY_LABELS[key];
  const stateDef = spec.state.find((s) => s.key === key);
  if (stateDef?.label && !/^[A-Za-z0-9_]+$/.test(stateDef.label.trim())) {
    return stateDef.label.trim();
  }
  // summary の内訳行などで {key} を参照していれば、その行の見出しを使う
  const token = `{${key}}`;
  for (const comp of spec.components) {
    for (const row of comp.rows ?? []) {
      if (row.value.includes(token) && row.label.trim()) {
        return row.label.trim();
      }
    }
    if (comp.label.includes(token) && comp.caption?.trim()) {
      return comp.caption.trim();
    }
  }
  if (!/^[A-Za-z0-9_]+$/.test(key)) return key;
  return '金額';
}

function nameOf(comp: AppComponent | undefined, spec: AppSpec): string {
  if (!comp) return '部品';
  const label = renderLabel(comp, createInitialState(spec)).replace(/\s+/g, ' ').trim();
  const short = label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH)}…` : label;
  return `「${short || comp.id}」`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 差し替えた部品のどこが変わったかを、1行の言葉にする */
function describeReplace(before: AppComponent, after: AppComponent, spec: AppSpec): string {
  const name = nameOf(before, spec);
  const changes: string[] = [];
  if (!same(before.actions, after.actions) || before.role !== after.role) {
    changes.push('押したときの動き');
  }
  if (before.label !== after.label) changes.push('文字');
  if (before.style.size !== after.style.size) changes.push('文字の大きさ');
  if ((before.style.rotateDeg ?? 0) !== (after.style.rotateDeg ?? 0)) changes.push('傾き');
  if ((before.style.numberFormat ?? 'arabic') !== (after.style.numberFormat ?? 'arabic')) {
    changes.push('数字の書き方');
  }
  if (
    before.style.variant !== after.style.variant ||
    (before.style.skin ?? 'native') !== (after.style.skin ?? 'native') ||
    Boolean(before.style.noisyAnimation) !== Boolean(after.style.noisyAnimation)
  ) {
    changes.push('見た目');
  }
  if (Boolean(before.style.sticky) !== Boolean(after.style.sticky)) changes.push('置き場所');
  if (!same(before.visibleWhen, after.visibleWhen)) changes.push('出てくる条件');
  if (!same(before.options, after.options) || !same(before.optionDetails, after.optionDetails)) {
    changes.push('選択肢');
  }
  if (before.caption !== after.caption) changes.push('補足の文');
  if (before.type !== after.type) changes.push('部品の種類');
  if (changes.length === 0) return `${name}を書き換え`;
  return `${name}の${changes.slice(0, 3).join('と')}を変更`;
}

/**
 * 差分パッチを、作業の行に並べる。
 * prevSpec は変更前、nextSpec は変更後（追加した部品の名前を引くのに使う）
 */
export function describeWorkSteps(
  prevSpec: AppSpec,
  nextSpec: AppSpec,
  patches: SpecPatch[],
): WorkStep[] {
  const steps: WorkStep[] = [];
  const find = (spec: AppSpec, id: string) => spec.components.find((c) => c.id === id);

  for (const patch of patches ?? []) {
    if (!patch || typeof patch !== 'object') continue;
    switch (patch.op) {
      case 'remove_component': {
        const before = find(prevSpec, patch.id);
        if (before) steps.push({ text: `${nameOf(before, prevSpec)}を削除` });
        break;
      }
      case 'replace_component': {
        const before = patch.component?.id ? find(prevSpec, patch.component.id) : undefined;
        const after = patch.component?.id ? find(nextSpec, patch.component.id) : undefined;
        if (before && after) {
          steps.push({ text: describeReplace(before, after, prevSpec), componentId: after.id });
        }
        break;
      }
      case 'insert_component': {
        const id = patch.component?.id;
        const after = id ? find(nextSpec, id) : undefined;
        if (!after) break;
        // すでにあった部品への追加は、差し替えとして扱われている
        const before = find(prevSpec, after.id);
        steps.push(
          before
            ? { text: describeReplace(before, after, prevSpec), componentId: after.id }
            : { text: `${nameOf(after, nextSpec)}を追加`, componentId: after.id },
        );
        break;
      }
      case 'move_component': {
        const after = find(nextSpec, patch.id);
        if (after) steps.push({ text: `${nameOf(after, nextSpec)}の位置を移動`, componentId: after.id });
        break;
      }
      case 'upsert_state': {
        const key = patch.variable?.key;
        if (!key) break;
        const existed = prevSpec.state.some((s) => s.key === key);
        const label = friendlyKeyLabel(key, nextSpec, patch.variable.label);
        // その状態を使う部品があれば光らせる（例: 定期便のチェック欄）
        const user = nextSpec.components.find((c) => c.stateKey === key);
        steps.push({
          text: existed ? `「${label}」の最初の状態を変更` : `「${label}」を覚える欄を追加`,
          componentId: user?.id,
        });
        break;
      }
      case 'upsert_derived': {
        if (patch.key) {
          const label = friendlyKeyLabel(patch.key, nextSpec);
          const targetComp = nextSpec.components.find(
            (c) =>
              c.label.includes(`{${patch.key}}`) ||
              c.rows?.some((r) => r.value.includes(`{${patch.key}}`)),
          );
          steps.push({
            text: `「${label}」の計算のしかたを変更`,
            componentId: targetComp?.id,
          });
        }
        break;
      }
    }
  }
  return steps;
}
