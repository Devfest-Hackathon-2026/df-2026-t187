// 改造の作業内容を、学習者が読める短い言葉の行にする。
// Gemini が返した差分パッチと、変更前後の画面から作るので、実際の変更と食い違わない。
// 固有名詞（部品名・状態名・変更前後の値）は括弧を使わずバッククォート `...` で囲み、
// チャット画面のシステムメッセージ行でインラインコードバッジとして表示する。

import { createInitialState, renderLabel } from './appRuntime.ts';
import type {
  AppComponent,
  AppSpec,
  BehaviorEffect,
  ComponentSize,
  ComponentType,
  PopupClosePosition,
  SpecPatch,
  StateValue,
} from './types.ts';

export interface WorkStep {
  /** 例: `注文を確定する` の押したときの動きを `反応なし` から `注文完了` に変更 */
  text: string;
  /** スマホの中で光らせる部品 */
  componentId?: string;
}

const MAX_LABEL_LENGTH = 16;

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
  couponPopup: 'クーポン広告',
  couponApplied: 'クーポン適用',
  tax: '消費税',
  total: '合計金額',
  step: '画面の段階',
  subscription: '定期便',
  newsletter: 'メルマガ',
  signupPassword: '会員登録',
};

const SIZE_LABELS: Record<ComponentSize, string> = {
  xs: '極小',
  sm: '小',
  md: '標準',
  lg: '大',
  xl: '特大',
};

const CLOSE_POS_LABELS: Record<PopupClosePosition, string> = {
  'top-right': '右上',
  'top-left': '左上',
  'bottom-right': '右下',
  'bottom-left': '左下',
  'bottom-bar': '下部バー',
};

const TYPE_LABELS: Record<ComponentType, string> = {
  heading: '見出し',
  text: '説明文',
  product_hero: '商品紹介',
  product_card: '商品カード',
  progress_steps: '手順表示',
  choice_cards: '選択カード',
  summary: '金額の内訳',
  input: '入力欄',
  select: 'プルダウン選択',
  checkbox: 'チェック欄',
  toggle: '切り替えスイッチ',
  slider: 'スライダー',
  button: 'ボタン',
  status_banner: 'お知らせバナー',
  popup: 'ポップアップ広告',
  custom: 'カスタム部品',
};

const BEHAVIOR_LABELS: Record<BehaviorEffect, string> = {
  none: 'すぐ押せる',
  escape_on_hover: '触れようとすると逃げる',
  require_3_clicks: '3回押さないと反応しない',
  confirm_dialog: '確認メッセージを出す',
};

/** 括弧やバッククォートを取り除き、指定文字数に収めてインラインコードトークン `...` にする */
function cleanTokenText(raw: string, maxLen = MAX_LABEL_LENGTH): string {
  const cleaned = raw
    .replace(/[`「」『』]/g, '')
    .replace(/[（(]/g, '・')
    .replace(/[）)]/g, '')
    .replace(/・+/g, '・')
    .replace(/^・|・$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '部品';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

function token(raw: string, maxLen = MAX_LABEL_LENGTH): string {
  return `\`${cleanTokenText(raw, maxLen)}\``;
}

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
  const placeholder = `{${key}}`;
  for (const comp of spec.components) {
    for (const row of comp.rows ?? []) {
      if (row.value.includes(placeholder) && row.label.trim()) {
        return row.label.trim();
      }
    }
    if (comp.label.includes(placeholder) && comp.caption?.trim()) {
      return comp.caption.trim();
    }
  }
  if (!/^[A-Za-z0-9_]+$/.test(key)) return key;
  return '金額';
}

function nameOf(comp: AppComponent | undefined, spec: AppSpec): string {
  if (!comp) return token('部品');
  const rendered = renderLabel(comp, createInitialState(spec)).replace(/\s+/g, ' ').trim();
  // 補足括弧の前だけで名前が分かる場合は、見出し部分を優先して短くする
  const headBeforeParen = rendered.split(/[（(]/)[0]?.trim() ?? '';
  const base = headBeforeParen.length >= 4 ? headBeforeParen : rendered;
  return token(base || comp.id, MAX_LABEL_LENGTH);
}

function formatStateValue(val: StateValue, key?: string): string {
  if (typeof val === 'boolean') {
    if (key && /popup/i.test(key)) {
      return val ? '表示' : '非表示';
    }
    return val ? 'チェックあり' : 'チェックなし';
  }
  if (typeof val === 'number') {
    return `${val}`;
  }
  const trimmed = String(val).trim();
  return trimmed === '' ? '未選択' : trimmed;
}

/** 「input」「confirm」のような、学習者に意味の通じない英字だけの内部の値か */
function isInternalValue(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(text);
}

function humanizeExpression(expression: string, spec: AppSpec): string {
  return expression
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (id) => {
      if (
        KNOWN_KEY_LABELS[id] ||
        spec.state.some((s) => s.key === id) ||
        spec.derived?.some((d) => d.key === id)
      ) {
        return friendlyKeyLabel(id, spec);
      }
      return id;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function describeActionSummary(comp: AppComponent, spec: AppSpec): string {
  const actions = comp.actions ?? [];
  if (actions.length === 0) return '反応なし';
  if (actions.some((a) => a.type === 'complete_task')) return '注文完了';
  if (actions.some((a) => a.type === 'reset_all')) return '入力をリセット';
  const openPage = actions.find((a) => a.type === 'open_page');
  if (openPage) {
    return openPage.message ? `${openPage.message}へ移動` : '別画面へ移動';
  }
  const hasDiscount = actions.some(
    (a) =>
      (a.type === 'set_state' || a.type === 'increment_state' || a.type === 'toggle_state') &&
      a.targetKey &&
      /discount|coupon/i.test(a.targetKey) &&
      a.targetKey !== 'couponPopup',
  );
  const closesPopup = actions.some(
    (a) => a.type === 'set_state' && a.targetKey === 'couponPopup' && a.value === false,
  );
  if (hasDiscount && closesPopup) return 'クーポンを適用して閉じる';
  if (hasDiscount) return 'クーポンを適用';
  if (closesPopup) return '広告を閉じる';
  const setStep = actions.find((a) => a.type === 'set_state' && a.targetKey === 'step');
  if (setStep) return '次の画面へ進む';
  const firstTarget = actions.find((a) => a.targetKey)?.targetKey;
  if (firstTarget) {
    return `${friendlyKeyLabel(firstTarget, spec)}を更新`;
  }
  if (actions.some((a) => a.type === 'show_toast')) return '通知を表示';
  return '動作あり';
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 差し替えた部品のどこがどう変わったかを、項目ごとの行にする */
function describeReplaceSteps(
  before: AppComponent,
  after: AppComponent,
  spec: AppSpec,
): WorkStep[] {
  const name = nameOf(before, spec);
  const componentId = after.id;
  const items: WorkStep[] = [];
  const push = (text: string) => items.push({ text, componentId });

  if (before.type !== after.type) {
    push(
      `${name} の部品の種類を ${token(TYPE_LABELS[before.type])} から ${token(TYPE_LABELS[after.type])} に変更`,
    );
  }

  if (!same(before.actions, after.actions) || before.role !== after.role) {
    const beforeAct = describeActionSummary(before, spec);
    const afterAct = describeActionSummary(after, spec);
    if (!same(before.actions, after.actions) && beforeAct !== afterAct) {
      push(`${name} の押したときの動きを ${token(beforeAct)} から ${token(afterAct)} に変更`);
    } else if (!same(before.actions, after.actions)) {
      push(`${name} の押したときの動きを ${token(afterAct)} に変更`);
    } else if (before.role === 'trap' && after.role !== 'trap') {
      push(`${name} の罠の設定を解除`);
    } else if (before.role === 'decoy' && after.role === 'primary_action') {
      push(`${name} の役割を ${token('おとりボタン')} から ${token('注文ボタン')} に変更`);
    }
  }

  const beforeEffect: BehaviorEffect = before.behavior?.effect ?? 'none';
  const afterEffect: BehaviorEffect = after.behavior?.effect ?? 'none';
  if (beforeEffect !== afterEffect) {
    push(
      `${name} の押し心地を ${token(BEHAVIOR_LABELS[beforeEffect])} から ${token(BEHAVIOR_LABELS[afterEffect])} に変更`,
    );
  }

  if (before.label !== after.label) {
    push(`${name} の表示文言を ${token(after.label, 22)} に変更`);
  }

  if ((before.caption ?? '') !== (after.caption ?? '')) {
    if (after.caption?.trim()) {
      push(`${name} の補足文を ${token(after.caption, 22)} に変更`);
    } else {
      push(`${name} の補足文を削除`);
    }
  }

  const isPopup = before.type === 'popup' && after.type === 'popup';
  if (!isPopup && before.style.size !== after.style.size) {
    push(
      `${name} の文字サイズを ${token(SIZE_LABELS[before.style.size])} から ${token(SIZE_LABELS[after.style.size])} に変更`,
    );
  }
  // 閉じるボタンの変更は、ポップアップ同士またはポップアップと他部品の変換時のみ伝える。
  // チェック欄などにAIが付けた、画面に出ない閉じるボタンの設定は伝えない
  if (before.type === 'popup' || after.type === 'popup') {
    const beforeClosePos: PopupClosePosition = before.closePosition ?? 'top-right';
    const afterClosePos: PopupClosePosition = after.closePosition ?? 'top-right';
    if (beforeClosePos !== afterClosePos) {
      push(
        `${name} の閉じるボタンの位置を ${token(CLOSE_POS_LABELS[beforeClosePos])} から ${token(CLOSE_POS_LABELS[afterClosePos])} に変更`,
      );
    }
    const beforeCloseSize: ComponentSize = before.closeSize ?? before.style.size;
    const afterCloseSize: ComponentSize = after.closeSize ?? after.style.size;
    if (beforeCloseSize !== afterCloseSize) {
      push(
        `${name} の閉じるボタンの大きさを ${token(SIZE_LABELS[beforeCloseSize])} から ${token(SIZE_LABELS[afterCloseSize])} に変更`,
      );
    }
    if ((before.closeLabel ?? '') !== (after.closeLabel ?? '')) {
      push(
        `${name} の閉じるボタンの表示を ${token(before.closeLabel || '×')} から ${token(after.closeLabel || '×')} に変更`,
      );
    }
  }

  if ((before.style.rotateDeg ?? 0) !== (after.style.rotateDeg ?? 0)) {
    const bDeg = before.style.rotateDeg ?? 0;
    const aDeg = after.style.rotateDeg ?? 0;
    push(
      `${name} の傾きを ${token(`${bDeg}度`)} から ${token(aDeg === 0 ? 'まっすぐ' : `${aDeg}度`)} に変更`,
    );
  }

  if ((before.style.numberFormat ?? 'arabic') !== (after.style.numberFormat ?? 'arabic')) {
    const fmtLabel = (f?: 'arabic' | 'kanji') => (f === 'kanji' ? '漢数字' : '算用数字');
    push(
      `${name} の数字の書き方を ${token(fmtLabel(before.style.numberFormat))} から ${token(fmtLabel(after.style.numberFormat))} に変更`,
    );
  }

  if (Boolean(before.style.noisyAnimation) !== Boolean(after.style.noisyAnimation)) {
    push(
      `${name} の点滅アニメーションを ${token(before.style.noisyAnimation ? 'あり' : 'なし')} から ${token(after.style.noisyAnimation ? 'あり' : 'なし')} に変更`,
    );
  } else if (
    before.style.variant !== after.style.variant ||
    (before.style.skin ?? 'native') !== (after.style.skin ?? 'native')
  ) {
    const beforeLook = (before.style.skin ?? 'native') === 'intrusive' ? '派手な装飾' : '落ち着いたデザイン';
    const afterLook = (after.style.skin ?? 'native') === 'intrusive' ? '派手な装飾' : '落ち着いたデザイン';
    if (beforeLook !== afterLook) {
      push(`${name} の見た目を ${token(beforeLook)} から ${token(afterLook)} に変更`);
    } else {
      push(`${name} の見た目の配色を変更`);
    }
  }

  if (Boolean(before.style.sticky) !== Boolean(after.style.sticky)) {
    push(
      `${name} の配置を ${token(before.style.sticky ? '下部固定' : '通常配置')} から ${token(after.style.sticky ? '下部固定' : '通常配置')} に変更`,
    );
  }

  if (!same(before.visibleWhen, after.visibleWhen)) {
    push(`${name} の表示される条件を変更`);
  }

  if (!same(before.options, after.options) || !same(before.optionDetails, after.optionDetails)) {
    const optsPreview = (after.options ?? []).join('・');
    push(`${name} の選択肢を ${token(optsPreview || '新しい選択肢', 22)} に変更`);
  }

  if (!same(before.rows, after.rows)) {
    push(`${name} の内訳の行を更新`);
  }

  if (
    (before.customHtml ?? '') !== (after.customHtml ?? '') ||
    (before.customCss ?? '') !== (after.customCss ?? '')
  ) {
    push(`${name} の独自デザインと動きを更新`);
  }

  if (items.length === 0) {
    push(`${name} の設定を更新`);
  }
  return items;
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
        if (before) steps.push({ text: `${nameOf(before, prevSpec)} を削除` });
        break;
      }
      case 'replace_component': {
        const before = patch.component?.id ? find(prevSpec, patch.component.id) : undefined;
        const after = patch.component?.id ? find(nextSpec, patch.component.id) : undefined;
        if (before && after) {
          steps.push(...describeReplaceSteps(before, after, prevSpec));
        }
        break;
      }
      case 'insert_component': {
        const id = patch.component?.id;
        const after = id ? find(nextSpec, id) : undefined;
        if (!after) break;
        // すでにあった部品への追加は、差し替えとして扱われている
        const before = find(prevSpec, after.id);
        if (before) {
          steps.push(...describeReplaceSteps(before, after, prevSpec));
        } else {
          steps.push({
            text: `${nameOf(after, nextSpec)} を ${token(TYPE_LABELS[after.type])} として追加`,
            componentId: after.id,
          });
        }
        break;
      }
      case 'move_component': {
        const after = find(nextSpec, patch.id);
        if (after) {
          steps.push({
            text: `${nameOf(after, nextSpec)} の位置を移動`,
            componentId: after.id,
          });
        }
        break;
      }
      case 'upsert_state': {
        const key = patch.variable?.key;
        if (!key) break;
        const prevState = prevSpec.state.find((s) => s.key === key);
        const label = friendlyKeyLabel(key, nextSpec, patch.variable.label);
        // その状態を使う部品があれば光らせる（例: 定期便のチェック欄）
        const user = nextSpec.components.find((c) => c.stateKey === key);
        // AIが文字列で返した値（"false" など）ではなく、型をそろえたあとの値で言葉にする
        const nextValue =
          nextSpec.state.find((s) => s.key === key)?.initialValue ?? patch.variable.initialValue;
        const afterVal = formatStateValue(nextValue, key);
        if (prevState) {
          // 値が変わっていなければ、変更として出さない
          if (prevState.initialValue === nextValue) break;
          const beforeVal = formatStateValue(prevState.initialValue, key);
          if (isInternalValue(beforeVal) || isInternalValue(afterVal)) {
            steps.push({ text: `${token(label)} の最初の状態を変更`, componentId: user?.id });
          } else {
            steps.push({
              text: `${token(label)} の最初の状態を ${token(beforeVal)} から ${token(afterVal)} に変更`,
              componentId: user?.id,
            });
          }
        } else if (isInternalValue(afterVal)) {
          steps.push({ text: `${token(label)} を覚える欄を追加`, componentId: user?.id });
        } else {
          steps.push({
            text: `${token(label)} を覚える欄を追加して最初の状態を ${token(afterVal)} に設定`,
            componentId: user?.id,
          });
        }
        break;
      }
      case 'upsert_derived': {
        if (patch.key) {
          const label = friendlyKeyLabel(patch.key, nextSpec);
          const prevDerived = prevSpec.derived?.find((d) => d.key === patch.key);
          const targetComp = nextSpec.components.find(
            (c) =>
              c.label.includes(`{${patch.key}}`) ||
              c.rows?.some((r) => r.value.includes(`{${patch.key}}`)),
          );
          const afterExpr = humanizeExpression(patch.expression, nextSpec);
          if (prevDerived && prevDerived.expression !== patch.expression) {
            const beforeExpr = humanizeExpression(prevDerived.expression, prevSpec);
            steps.push({
              text: `${token(label)} の計算のしかたを ${token(beforeExpr, 24)} から ${token(afterExpr, 24)} に変更`,
              componentId: targetComp?.id,
            });
          } else {
            steps.push({
              text: `${token(label)} の計算のしかたを ${token(afterExpr, 24)} に変更`,
              componentId: targetComp?.id,
            });
          }
        }
        break;
      }
    }
  }
  return steps;
}
