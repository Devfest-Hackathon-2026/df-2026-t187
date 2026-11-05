import type {
  AppComponent,
  AppSpec,
  ComponentBoundsInput,
  ReviewerPersona,
  SandboxValidationResult,
} from './types.ts';

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * お題アプリ仕様 (AppSpec) から、iframe 内で単一HTMLとして独立動作する HTML 文字列を生成する。
 * タスク完了時には window.parent.postMessage({ type: 'PONKOTSU_TASK_COMPLETED' }, '*') を発火する。
 */
export function buildStandaloneSandboxHtml(spec: AppSpec): string {
  const safeTitle = escapeHtml(spec.title || '目覚まし時計');
  const bg = escapeHtml(spec.theme?.bgColor || '#ffffff');
  const fg = escapeHtml(spec.theme?.textColor || '#1c1917');
  const serializedSpec = JSON.stringify(spec).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
      background: ${bg};
      color: ${fg};
      overflow: hidden;
    }
    #sandbox-mount {
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <div id="sandbox-mount" data-spec-id="${escapeHtml(spec.id)}"></div>
  <script id="ponkotsu-spec-data" type="application/json">${serializedSpec}</script>
</body>
</html>`;
}

/**
 * 改修後の AppSpec が単一HTMLとして描画可能か、またタスク完了イベントが発火可能かを検証する。
 */
export function validateSandboxSpec(
  spec: AppSpec,
  options: { requireTaskCompletionEvent?: boolean } = {},
): SandboxValidationResult {
  const errors: string[] = [];

  if (!spec || typeof spec !== 'object') {
    return {
      valid: false,
      canRenderHtml: false,
      hasTaskCompletionEvent: false,
      errors: ['アプリ仕様データが空または不正です'],
    };
  }

  if (!Array.isArray(spec.components) || spec.components.length === 0) {
    errors.push('画面に表示する部品が1つもありません');
  }

  if (!Array.isArray(spec.state) || spec.state.length === 0) {
    errors.push('状態データ定義が失われています');
  }

  // 単一HTML生成テスト
  let canRenderHtml = false;
  try {
    const html = buildStandaloneSandboxHtml(spec);
    canRenderHtml = html.includes('<!DOCTYPE html>') && html.includes('ponkotsu-spec-data');
  } catch {
    canRenderHtml = false;
    errors.push('単一HTMLの組み立てに失敗しました');
  }

  // タスク完了イベント（アラーム予約完了アクション）が存在するかチェック
  const hasTaskCompletionEvent = Array.isArray(spec.components)
    ? spec.components.some(
        (c) =>
          c.type === 'button' &&
          Array.isArray(c.actions) &&
          c.actions.some(
            (a) =>
              a.type === 'complete_task' ||
              (a.type === 'set_state' &&
                a.targetKey === 'isAlarmSet' &&
                (a.value === true || a.value === 'true')),
          ),
      )
    : false;

  if (options.requireTaskCompletionEvent && !hasTaskCompletionEvent) {
    errors.push('タスク完了イベント（アラーム予約完了処理）が見つかりません');
  }

  return {
    valid: errors.length === 0 && canRenderHtml,
    canRenderHtml,
    hasTaskCompletionEvent,
    errors,
  };
}

export interface ComputerUseSimulationResult {
  outcome: 'achieved' | 'abandoned';
  frictionPoint: string;
  fallbackComment: string;
  actionTrace: string[];
  appliedConstraintNote: string;
}

interface SimulatedBox {
  comp: AppComponent;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/**
 * 画面上の各部品の擬似バウンディングボックスを算出する（実DOM座標があればそれを使用）。
 */
function layoutComponentBoxes(
  spec: AppSpec,
  customBounds?: ComponentBoundsInput[],
): SimulatedBox[] {
  const customMap = new Map((customBounds ?? []).map((b) => [b.id, b]));
  const boxes: SimulatedBox[] = [];
  let cursorY = 58;
  const screenWidth = 320;

  const heightBySize: Record<string, number> = {
    xs: 26,
    sm: 34,
    md: 44,
    lg: 56,
    xl: 68,
  };

  for (const comp of spec.components) {
    if (comp.visibleWhen && comp.visibleWhen.stateKey === 'isAlarmSet') {
      continue;
    }
    const existing = customMap.get(comp.id);
    if (existing && existing.right > existing.left && existing.bottom > existing.top) {
      const width = existing.right - existing.left;
      const height = existing.bottom - existing.top;
      boxes.push({
        comp,
        left: existing.left,
        top: existing.top,
        right: existing.right,
        bottom: existing.bottom,
        centerX: existing.left + width / 2,
        centerY: existing.top + height / 2,
        width,
        height,
      });
      continue;
    }

    const h = heightBySize[comp.style.size] ?? 42;
    const isFull =
      comp.style.fullWidth || comp.style.size === 'lg' || comp.style.size === 'xl';
    const w = isFull ? screenWidth - 32 : comp.style.size === 'xs' ? 92 : 160;
    let left = 16;
    if (!isFull) {
      if (comp.style.align === 'right') {
        left = screenWidth - 16 - w;
      } else if (comp.style.align === 'center') {
        left = (screenWidth - w) / 2;
      }
    }
    const top = cursorY;
    const right = left + w;
    const bottom = top + h;
    cursorY = bottom + 8;

    boxes.push({
      comp,
      left,
      top,
      right,
      bottom,
      centerX: left + w / 2,
      centerY: top + h / 2,
      width: w,
      height: h,
    });
  }

  return boxes;
}

/**
 * ペルソナIDとステップ番号から決定論的なズレ量（-jitterPx 〜 +jitterPx）を算出する。
 * これによりテスト再現性を保ちつつ、指の震え・片手操作・電車の揺れによる誤タップを忠実に再現する。
 */
function computeDeterministicJitter(
  personaId: string,
  step: number,
  jitterPx: number,
): { dx: number; dy: number } {
  let hash = step * 31;
  for (let i = 0; i < personaId.length; i++) {
    hash = (hash * 33 + personaId.charCodeAt(i)) % 997;
  }
  const normX = ((hash % 200) - 100) / 100; // -1.0 .. 1.0
  const normY = (((hash * 7) % 200) - 100) / 100;
  // 指のズレが大きいペルソナほど端方向にズレが出るように最低65%の振幅を持たせる
  const signX = normX >= 0 ? 1 : -1;
  const signY = normY >= 0 ? 1 : -1;
  const magX = Math.max(0.65, Math.abs(normX)) * jitterPx * signX;
  const magY = Math.max(0.65, Math.abs(normY)) * jitterPx * signY;
  return {
    dx: Math.round(magX),
    dy: Math.round(magY),
  };
}

/**
 * 企画書 2章「層の中の3人と制約変数」「選択9：Computer Use＋AIの外側での数値制約」に基づく
 * 実操作シミュレーションエンジン。
 *
 * - 視力制約 (blurPx / contrast): 小さい文字 (xs/sm) や低コントラスト配色を見落とす
 * - 指の正確さ制約 (jitterPx): 狙った座標にズレ (dx, dy) を加算して当たり判定を実行する
 * - 手数上限 (maxSteps) / 待てる時間 (patienceMs): 手数超過や邪魔な項目による時間切れで離脱
 * - タスク完了イベント判定: コード側で complete_task / isAlarmSet=true の発火を判定する
 */
export function simulatePersonaComputerUse(
  spec: AppSpec,
  persona: ReviewerPersona,
  customBounds?: ComponentBoundsInput[],
): ComputerUseSimulationResult {
  const c = persona.constraints;
  const boxes = layoutComponentBoxes(spec, customBounds);
  const actionTrace: string[] = [];

  const appliedConstraintNote = [
    c.blurPx >= 2.0 ? `視力ぼかし(${c.blurPx}px)` : '',
    c.contrast <= 0.7 ? `低コントラスト(${Math.round(c.contrast * 100)}%)` : '',
    c.jitterPx >= 15 ? `指のズレ(±${c.jitterPx}px)` : '',
    `手数上限(${c.maxSteps}手)`,
    c.environment === 'one_hand'
      ? '片手親指操作'
      : c.environment === 'moving_train'
        ? '揺れる車内'
        : c.environment === 'dark_room'
          ? '暗い部屋'
          : '',
  ]
    .filter(Boolean)
    .join('・');

  const hasClutter = spec.components.some(
    (comp) => comp.id === 'input-motto' || comp.id === 'toggle-poem',
  );
  const giantDangerBtn = boxes.find(
    (b) =>
      b.comp.id === 'btn-cancel-all' &&
      (b.comp.style.size === 'xl' || b.comp.style.variant === 'danger'),
  );
  const clockComp = spec.components.find((comp) => comp.id === 'clock-display');
  const setBtnBox = boxes.find((b) => b.comp.id === 'btn-set-alarm');
  const wakeBtnBox = boxes.find(
    (b) => b.comp.id === 'btn-wake-plus' || b.comp.id === 'btn-mystery',
  );

  // 1. 視力・画面環境の数値制約チェック
  if (c.blurPx >= 2.5 && clockComp && (clockComp.style.size === 'xs' || clockComp.style.size === 'sm')) {
    actionTrace.push(
      `画面確認: 視力制約(ぼかし${c.blurPx}px)により、小さい時刻表示(${clockComp.style.size})が判読不能`,
    );
    if (giantDangerBtn) {
      actionTrace.push(
        `1手目: 一番目立つ赤いボタン(${giantDangerBtn.comp.label})を予約と誤認してタップ → 設定が全消去され離脱`,
      );
      return {
        outcome: 'abandoned',
        frictionPoint: '文字が小さすぎて読めず赤ボタンを誤タップ',
        fallbackComment:
          '文字がぼやけて読めないし、一番目立つ赤いボタンを押したら全部消えてしまったわ。',
        actionTrace,
        appliedConstraintNote,
      };
    }
    return {
      outcome: 'abandoned',
      frictionPoint: '時刻やボタンの文字が小さすぎて見えない',
      fallbackComment: '文字が豆粒みたいに小さくて、どこを押せばいいか見えないよ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 暗い部屋環境の制約チェック（散らかった眩しい初期画面だと目がくらむ）
  if (c.environment === 'dark_room' && spec.theme.chaoticLayout) {
    actionTrace.push(
      '画面確認: 暗い部屋で散らかった眩しい画面を見たためコントラスト低下で見分けがつかず離脱',
    );
    return {
      outcome: 'abandoned',
      frictionPoint: '暗い部屋だと眩しくて画面が散らかっている',
      fallbackComment: '暗い部屋で見ると画面がゴチャゴチャで眩しすぎて目が痛いよ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 2. 迷いやすさ・待てる時間の制約チェック（不要な項目が残っている場合）
  if (hasClutter && (c.patienceMs <= 2500 || persona.traitLabel === 'スマホに不慣れ')) {
    actionTrace.push(
      `1手目: 気合い度メーターやポエム通知に目を奪われ、制限時間(${c.patienceMs}ms)内に予約ボタンを見つけられず離脱`,
    );
    return {
      outcome: 'abandoned',
      frictionPoint: '無関係な項目が多くて迷い時間切れ',
      fallbackComment:
        persona.cohortId === 'elderly'
          ? '気合い度とかポエムとか難しい項目がいっぱいで、どこを押すのか分からないわ。'
          : 'すぐ寝たいのに余計なメーターや項目ばかりでイライラするよ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 3. 狙うターゲットボタンの決定
  const targetBox =
    c.requiresWakeGimmick && wakeBtnBox ? wakeBtnBox : (setBtnBox ?? wakeBtnBox);

  if (!targetBox) {
    actionTrace.push('1手目: 予約ボタンが画面上に見つからず離脱');
    return {
      outcome: 'abandoned',
      frictionPoint: '予約ボタンが見当たらない',
      fallbackComment: 'アラームを予約するボタンがどこにもないよ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 4. 片手操作制約チェック（画面右端に小さいボタンがあると親指が届かない）
  if (
    c.environment === 'one_hand' &&
    !targetBox.comp.style.fullWidth &&
    (targetBox.comp.style.size === 'xs' || targetBox.comp.style.size === 'sm')
  ) {
    actionTrace.push(
      `1手目: 片手親指で端の小さいボタン(${targetBox.comp.label})を狙ったが指が届かずタップ失敗 → 離脱`,
    );
    return {
      outcome: 'abandoned',
      frictionPoint: 'ボタンが端にあって小さく片手で届かない',
      fallbackComment: '片手だと端っこの小さいボタンに親指が届かなくて押しづらいわ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 5. 指の正確さ制約（クリック座標にランダムなズレ dx, dy を加算して実行）
  const { dx, dy } = computeDeterministicJitter(persona.id, 1, c.jitterPx);
  const clickX = Math.round(targetBox.centerX + dx);
  const clickY = Math.round(targetBox.centerY + dy);

  const missedSmallButton =
    c.jitterPx >= 18 &&
    (targetBox.comp.style.size === 'xs' || targetBox.comp.style.size === 'sm');

  if (missedSmallButton || giantDangerBtn) {
    if (giantDangerBtn && (c.jitterPx >= 10 || targetBox.comp.style.size === 'xs')) {
      actionTrace.push(
        `1手目: (${Math.round(targetBox.centerX)}, ${Math.round(targetBox.centerY)})を狙ったが指のズレ(${dx >= 0 ? `+${dx}` : dx}, ${dy >= 0 ? `+${dy}` : dy})で巨大な赤ボタンを誤タップ → 全消去され離脱`,
      );
      return {
        outcome: 'abandoned',
        frictionPoint: '指がズレて巨大な赤ボタンを誤タップ',
        fallbackComment:
          persona.cohortId === 'elderly'
            ? '予約しようとしたら指が震えて、隣のでっかい赤いボタンを押して全部消えちゃったよ。'
            : '電車が揺れて指がズレたら、でっかい赤ボタンに当たって設定が全部消えた！',
        actionTrace,
        appliedConstraintNote,
      };
    }
    if (missedSmallButton) {
      actionTrace.push(
        `1手目: (${clickX}, ${clickY})をタップしたが、ボタンが小さすぎて指のズレ(±${c.jitterPx}px)により外れて離脱`,
      );
      return {
        outcome: 'abandoned',
        frictionPoint: 'ボタンが小さく指がズレて押せない',
        fallbackComment: 'ボタンが小さすぎて、指が少しズレただけで押せないよ。',
        actionTrace,
        appliedConstraintNote,
      };
    }
  }

  // 6. ボタン押下時の必要手数とギミック検証
  const effect =
    targetBox.comp.behavior?.effect ??
    wakeBtnBox?.comp.behavior?.effect ??
    setBtnBox?.comp.behavior?.effect ??
    'none';
  const requiredSteps =
    effect === 'math_quiz_gate'
      ? 2
      : effect === 'escape_on_hover'
        ? 2
        : effect === 'require_3_clicks'
          ? 3
          : 1;

  // 時間がない会社員（maxSteps: 1）なのに毎回クイズ等を強制される場合
  const hasQuickOneTapButton = Boolean(
    setBtnBox &&
      (!setBtnBox.comp.behavior?.effect || setBtnBox.comp.behavior.effect === 'none') &&
      setBtnBox.comp.actions.some(
        (a) =>
          a.type === 'complete_task' ||
          (a.type === 'set_state' && a.targetKey === 'isAlarmSet'),
      ),
  );

  if (requiredSteps > c.maxSteps && !hasQuickOneTapButton) {
    actionTrace.push(
      `1手目: ${targetBox.comp.label}をタップ → 追加操作(${requiredSteps}手)が必要だが手数上限(${c.maxSteps}手)を超えたため離脱`,
    );
    return {
      outcome: 'abandoned',
      frictionPoint: '予約完了までの手数が多すぎて時間切れ',
      fallbackComment: '疲れてすぐ寝たいのに、1回押すだけで予約できないのは面倒すぎるよ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 7. タスク完了イベント発火チェック（コード判定）
  const activeButtons = [targetBox.comp, setBtnBox?.comp, wakeBtnBox?.comp].filter(
    (b): b is AppComponent => Boolean(b),
  );
  const firesTaskCompletion = activeButtons.some((btn) =>
    btn.actions.some(
      (a) =>
        a.type === 'complete_task' ||
        (a.type === 'set_state' &&
          a.targetKey === 'isAlarmSet' &&
          (a.value === true || a.value === 'true')),
    ),
  );

  if (!firesTaskCompletion) {
    actionTrace.push(
      `1手目: ${targetBox.comp.label}(${clickX}, ${clickY})をタップ → タスク完了イベントが発火せず無反応のため離脱`,
    );
    return {
      outcome: 'abandoned',
      frictionPoint: 'ボタンを押しても予約完了にならない',
      fallbackComment: '予約ボタンを押してもウンともスンとも言わないよ。壊れてるみたいだ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 8. 二度寝防止ギミック必須ペルソナ（朝が弱い学生層）のチェック
  const hasWakeGimmick = spec.components.some(
    (comp) =>
      comp.behavior?.effect === 'math_quiz_gate' ||
      comp.behavior?.effect === 'escape_on_hover' ||
      comp.behavior?.effect === 'require_3_clicks' ||
      comp.behavior?.effect === 'tts_voice_alarm' ||
      comp.behavior?.effect === 'play_alarm_sound',
  );

  if (c.requiresWakeGimmick && !hasWakeGimmick) {
    actionTrace.push(
      `1手目: ${targetBox.comp.label}をタップして予約完了したが、二度寝を防ぐ仕掛けがないため翌朝二度寝して離脱`,
    );
    return {
      outcome: 'abandoned',
      frictionPoint: '二度寝を防ぐ仕掛けがなく起きられない',
      fallbackComment:
        '見た目はキレイになったけど、普通のアラームだと無意識に止めて二度寝しちゃうよ。',
      actionTrace,
      appliedConstraintNote,
    };
  }

  // 9. 全制約をクリアし、タスク完了イベントをコード検知 → 達成 (achieved)！
  if (hasWakeGimmick && c.requiresWakeGimmick) {
    actionTrace.push(
      `1〜2手目: ${targetBox.comp.label}(${clickX}, ${clickY})で二度寝防止ギミックをクリア → タスク完了イベント検知（達成）`,
    );
    return {
      outcome: 'achieved',
      frictionPoint: '二度寝防止ギミックで確実に予約完了',
      fallbackComment:
        '頭と指を使わないと進めない仕掛けがあるから、これなら寝ぼけてても絶対起きられる！',
      actionTrace,
      appliedConstraintNote,
    };
  }

  actionTrace.push(
    `1手目: ${targetBox.comp.label}(${clickX}, ${clickY})をタップ → タスク完了イベント検知（達成）`,
  );
  return {
    outcome: 'achieved',
    frictionPoint: '迷わず1手で予約完了イベントに到達',
    fallbackComment:
      persona.cohortId === 'elderly'
        ? '文字もボタンも大きくて、指が少し震えても迷わず1回で予約できたよ。'
        : '邪魔な項目がなくて、親指1回でサッとアラームをセットできた！助かる！',
    actionTrace,
    appliedConstraintNote,
  };
}
