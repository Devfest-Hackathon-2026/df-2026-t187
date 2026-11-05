import { buildStandaloneSandboxHtml, escapeHtml } from '../shared/sandboxValidator.ts';
import type {
  AppComponent,
  AppSpec,
  ComponentAction,
  StateValue,
} from '../shared/types.ts';

export interface SandboxCallbacks {
  onStateChange: (newState: Record<string, StateValue>) => void;
  onToast: (message: string, type: 'info' | 'success' | 'warning') => void;
}

/**
 * Web Speech API / Web Audio API を使って音声読み上げ（TTS）またはアラーム音を再生する。
 */
export function speakTextWithTts(
  text: string,
  options: { pitch?: number; rate?: number } = {},
): void {
  if (typeof window === 'undefined') return;
  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'ja-JP';
      utter.pitch = options.pitch ?? 1.0;
      utter.rate = options.rate ?? 1.05;
      window.speechSynthesis.speak(utter);
    }
  } catch {
    // Web Speech API 非対応環境では無視
  }
}

export function playAlarmBeep(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.32);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.32);
  } catch {
    // AudioContext 非対応時は無視
  }
}

/**
 * iframe 隔離されたサンドボックス内（またはフォールバック時は直下）から data-component-id 要素一覧を取得する。
 */
export function querySandboxComponentElements(container: HTMLElement): HTMLElement[] {
  const iframe = container.querySelector<HTMLIFrameElement>('iframe.sandbox-iframe');
  if (iframe?.contentDocument) {
    return Array.from(iframe.contentDocument.querySelectorAll<HTMLElement>('[data-component-id]'));
  }
  return Array.from(container.querySelectorAll<HTMLElement>('[data-component-id]'));
}

function shouldShowComponent(
  comp: AppComponent,
  state: Record<string, StateValue>,
): boolean {
  if (!comp.visibleWhen) return true;
  const current = state[comp.visibleWhen.stateKey];
  const target = comp.visibleWhen.value;
  switch (comp.visibleWhen.operator) {
    case 'eq':
      return String(current) === String(target);
    case 'neq':
      return String(current) !== String(target);
    case 'gt':
      return Number(current) > Number(target);
    case 'lt':
      return Number(current) < Number(target);
    default:
      return true;
  }
}

function adjustTimeString(current: string, deltaMinutes: number): string {
  const match = current.match(/^(\d{1,2}):(\d{2})/);
  let hours = match ? Number(match[1]) : 7;
  let mins = match ? Number(match[2]) : 0;
  if (!Number.isFinite(hours)) hours = 7;
  if (!Number.isFinite(mins)) mins = 0;

  let total = (hours * 60 + mins + deltaMinutes) % (24 * 60);
  if (total < 0) total += 24 * 60;
  const nextH = String(Math.floor(total / 60)).padStart(2, '0');
  const nextM = String(total % 60).padStart(2, '0');
  return `${nextH}:${nextM}`;
}

function syncStylesIntoIframe(iframeDoc: Document): void {
  const parentStyles = document.querySelectorAll('style, link[rel="stylesheet"]');
  iframeDoc.head.querySelectorAll('[data-synced-style]').forEach((n) => n.remove());
  for (const node of parentStyles) {
    const clone = node.cloneNode(true) as HTMLElement;
    clone.setAttribute('data-synced-style', '1');
    iframeDoc.head.appendChild(clone);
  }
}

export function renderSandboxApp(
  container: HTMLElement,
  spec: AppSpec,
  liveState: Record<string, StateValue>,
  selectedComponentIds: Set<string>,
  callbacks: SandboxCallbacks,
): void {
  // 単一HTMLとしてiframe内で隔離実行する
  let iframe = container.querySelector<HTMLIFrameElement>('iframe.sandbox-iframe');
  if (!iframe) {
    container.innerHTML = '';
    iframe = document.createElement('iframe');
    iframe.className = 'sandbox-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.title = spec.title || 'お題アプリサンドボックス';
    container.appendChild(iframe);
  }

  const iframeDoc = iframe.contentDocument;
  const targetDoc = iframeDoc ?? document;
  let mountRoot: HTMLElement = container;

  if (iframeDoc) {
    if (!iframeDoc.getElementById('sandbox-mount')) {
      iframeDoc.open();
      iframeDoc.write(buildStandaloneSandboxHtml(spec));
      iframeDoc.close();
      syncStylesIntoIframe(iframeDoc);
    }
    const specScript = iframeDoc.getElementById('ponkotsu-spec-data');
    if (specScript) {
      specScript.textContent = JSON.stringify(spec);
    }
    mountRoot = iframeDoc.getElementById('sandbox-mount') ?? iframeDoc.body;
    mountRoot.innerHTML = '';
  } else {
    container.innerHTML = '';
  }

  const phoneScreen = targetDoc.createElement('div');
  phoneScreen.className = `phone-app-screen ${spec.theme.chaoticLayout ? 'is-chaotic' : 'is-clean'}`;
  phoneScreen.style.backgroundColor = spec.theme.bgColor || '#ffffff';
  phoneScreen.style.color = spec.theme.textColor || '#1c1917';

  const statusBar = targetDoc.createElement('div');
  statusBar.className = 'phone-status-bar';
  statusBar.innerHTML = `
    <span class="phone-status-time">22:30</span>
    <span class="phone-status-pill"></span>
    <span class="phone-status-state">${liveState.isAlarmSet ? '予約あり' : '未予約'}</span>
  `;
  phoneScreen.appendChild(statusBar);

  const header = targetDoc.createElement('div');
  header.className = 'sandbox-app-header';
  const titleEl = targetDoc.createElement('h3');
  titleEl.className = 'sandbox-app-title';
  titleEl.textContent = spec.title;
  header.appendChild(titleEl);
  phoneScreen.appendChild(header);

  const overlaySlot = targetDoc.createElement('div');
  overlaySlot.className = 'phone-inapp-overlay-slot';

  const body = targetDoc.createElement('div');
  body.className = 'sandbox-app-body';

  const emitTaskCompletedEvent = () => {
    try {
      const targetOrigin =
        window.location?.origin && window.location.origin !== 'null'
          ? window.location.origin
          : '*';
      window.postMessage(
        {
          type: 'PONKOTSU_TASK_COMPLETED',
          specId: spec.id,
          completedAt: new Date().toISOString(),
        },
        targetOrigin,
      );
    } catch {
      // postMessage 失敗時は無視
    }
  };

  const executeActions = (actions: ComponentAction[]) => {
    const nextState = { ...liveState };
    let taskCompleted = false;
    for (const act of actions) {
      if (act.type === 'set_state' && act.targetKey) {
        nextState[act.targetKey] = act.value ?? true;
        if (act.targetKey === 'isAlarmSet' && (act.value === true || act.value === 'true')) {
          taskCompleted = true;
        }
      } else if (act.type === 'toggle_state' && act.targetKey) {
        nextState[act.targetKey] = !nextState[act.targetKey];
      } else if (act.type === 'increment_state' && act.targetKey) {
        nextState[act.targetKey] = Number(nextState[act.targetKey] ?? 0) + 1;
      } else if (act.type === 'reset_all') {
        for (const s of spec.state) {
          nextState[s.key] = s.initialValue;
        }
      } else if (act.type === 'show_toast') {
        callbacks.onToast(act.message || '実行しました', 'warning');
      } else if (act.type === 'complete_task') {
        taskCompleted = true;
        callbacks.onToast(act.message || 'アラームを予約しました', 'success');
      }
    }
    if (taskCompleted) {
      emitTaskCompletedEvent();
    }
    callbacks.onStateChange(nextState);
  };

  const openMathQuizOverlay = (comp: AppComponent, onPass: () => void) => {
    overlaySlot.innerHTML = '';
    const sheet = targetDoc.createElement('div');
    sheet.className = 'inapp-sheet';

    const question = comp.behavior?.quizQuestion || '17 + 28 = ?';
    const expected = (comp.behavior?.quizAnswer || '45').trim();
    const expectedNum = Number(expected) || 45;
    const choices = [String(expectedNum - 10), expected, String(expectedNum + 10)];

    sheet.innerHTML = `
      <div class="inapp-sheet-kicker">二度寝防止クイズ</div>
      <div class="inapp-sheet-title">${escapeHtml(question)}</div>
      <div class="inapp-sheet-sub">正解を押すと予約できます</div>
    `;

    const choiceGrid = targetDoc.createElement('div');
    choiceGrid.className = 'inapp-quiz-choices';
    for (const ch of choices) {
      const cBtn = targetDoc.createElement('button');
      cBtn.type = 'button';
      cBtn.className = 'inapp-quiz-btn';
      cBtn.textContent = ch;
      cBtn.addEventListener('click', () => {
        if (ch === expected) {
          overlaySlot.innerHTML = '';
          onPass();
        } else {
          callbacks.onToast('ちがいます。もう一度計算してみよう', 'warning');
        }
      });
      choiceGrid.appendChild(cBtn);
    }

    const cancelBtn = targetDoc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'inapp-sheet-cancel';
    cancelBtn.textContent = 'とじる';
    cancelBtn.addEventListener('click', () => {
      overlaySlot.innerHTML = '';
    });

    sheet.append(choiceGrid, cancelBtn);
    overlaySlot.appendChild(sheet);
  };

  const openConfirmOverlay = (comp: AppComponent, onConfirm: () => void) => {
    overlaySlot.innerHTML = '';
    const sheet = targetDoc.createElement('div');
    sheet.className = 'inapp-sheet';
    const titleDiv = targetDoc.createElement('div');
    titleDiv.className = 'inapp-sheet-title';
    titleDiv.textContent = comp.behavior?.confirmText || 'ほんとうに消しますか？';
    sheet.appendChild(titleDiv);
    const row = targetDoc.createElement('div');
    row.className = 'inapp-confirm-row';

    const noBtn = targetDoc.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'inapp-sheet-cancel';
    noBtn.textContent = 'やめる';
    noBtn.addEventListener('click', () => {
      overlaySlot.innerHTML = '';
    });

    const yesBtn = targetDoc.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'inapp-confirm-yes';
    yesBtn.textContent = '消す';
    yesBtn.addEventListener('click', () => {
      overlaySlot.innerHTML = '';
      onConfirm();
    });

    row.append(noBtn, yesBtn);
    sheet.appendChild(row);
    overlaySlot.appendChild(sheet);
  };

  for (const comp of spec.components) {
    if (!shouldShowComponent(comp, liveState)) {
      continue;
    }

    const itemWrap = targetDoc.createElement('div');
    itemWrap.className = [
      'sandbox-comp-item',
      `type-${comp.type}`,
      `size-${comp.style.size}`,
      `variant-${comp.style.variant}`,
      `align-${comp.style.align || 'left'}`,
      comp.style.fullWidth ? 'is-full' : '',
      comp.style.noisyAnimation ? 'is-noisy' : '',
      selectedComponentIds.has(comp.id) ? 'is-circled-target' : '',
    ]
      .filter(Boolean)
      .join(' ');
    itemWrap.dataset.componentId = comp.id;

    if (selectedComponentIds.has(comp.id)) {
      const targetBadge = targetDoc.createElement('div');
      targetBadge.className = 'circled-badge';
      targetBadge.textContent = '選択中';
      itemWrap.appendChild(targetBadge);
    }

    if (comp.type === 'clock_display') {
      const clockFace = targetDoc.createElement('div');
      clockFace.className = `alarm-clock-face ${liveState.isAlarmSet ? 'is-set' : ''}`;

      const topRow = targetDoc.createElement('div');
      topRow.className = 'alarm-clock-top';
      const labelEl = targetDoc.createElement('span');
      labelEl.className = 'comp-clock-label';
      labelEl.textContent = comp.label;
      const stateTag = targetDoc.createElement('span');
      stateTag.className = `alarm-state-dot ${liveState.isAlarmSet ? 'on' : 'off'}`;
      stateTag.textContent = liveState.isAlarmSet ? '予約中' : '未予約';
      topRow.append(labelEl, stateTag);

      const rawTime = comp.stateKey ? String(liveState[comp.stateKey] ?? '07:00') : '07:00';
      const displayTime = rawTime.slice(0, 5);

      const valueEl = targetDoc.createElement('div');
      valueEl.className = 'comp-clock-value';
      valueEl.textContent = displayTime;

      clockFace.append(topRow, valueEl);
      itemWrap.appendChild(clockFace);
    } else if (comp.type === 'input' || comp.type === 'select') {
      const isTimeControl = comp.stateKey === 'alarmTime' || comp.id.includes('time');
      if (isTimeControl) {
        const dialWrap = targetDoc.createElement('div');
        dialWrap.className = 'alarm-time-dial';

        const labelRow = targetDoc.createElement('div');
        labelRow.className = 'comp-field-label';
        labelRow.textContent = comp.label;
        dialWrap.appendChild(labelRow);

        const stepperRow = targetDoc.createElement('div');
        stepperRow.className = 'time-stepper-row';
        const steps = [
          { label: '-1時間', delta: -60 },
          { label: '-10分', delta: -10 },
          { label: '+10分', delta: 10 },
          { label: '+1時間', delta: 60 },
        ];
        for (const st of steps) {
          const sBtn = targetDoc.createElement('button');
          sBtn.type = 'button';
          sBtn.className = 'time-step-btn';
          sBtn.textContent = st.label;
          sBtn.addEventListener('click', () => {
            const cur = String(liveState.alarmTime ?? '07:00');
            callbacks.onStateChange({
              ...liveState,
              alarmTime: adjustTimeString(cur, st.delta),
            });
          });
          stepperRow.appendChild(sBtn);
        }
        dialWrap.appendChild(stepperRow);
        itemWrap.appendChild(dialWrap);
      } else {
        const gaugeWrap = targetDoc.createElement('div');
        gaugeWrap.className = 'clutter-gauge-widget';
        const labelEl = targetDoc.createElement('div');
        labelEl.className = 'comp-field-label';
        labelEl.textContent = comp.label;

        const levelRow = targetDoc.createElement('div');
        levelRow.className = 'clutter-level-row';
        for (const lv of ['低', 'やや低', '普通', '高', '最高']) {
          const lvBtn = targetDoc.createElement('button');
          lvBtn.type = 'button';
          lvBtn.className = `clutter-level-btn ${liveState[comp.stateKey ?? ''] === lv ? 'active' : ''}`;
          lvBtn.textContent = lv;
          lvBtn.addEventListener('click', () => {
            if (comp.stateKey) {
              callbacks.onStateChange({ ...liveState, [comp.stateKey]: lv });
            }
          });
          levelRow.appendChild(lvBtn);
        }
        gaugeWrap.append(labelEl, levelRow);
        itemWrap.appendChild(gaugeWrap);
      }
    } else if (comp.type === 'slider') {
      const sliderWrap = targetDoc.createElement('div');
      sliderWrap.className = 'clutter-slider-widget';
      const currentVal = Number(comp.stateKey ? liveState[comp.stateKey] : 20) || 20;
      const headRow = targetDoc.createElement('div');
      headRow.className = 'slider-head-row';
      headRow.innerHTML = `<span class="comp-field-label">${escapeHtml(comp.label)}</span><span class="slider-val">${currentVal}%</span>`;

      const range = targetDoc.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '100';
      range.step = '20';
      range.value = String(currentVal);
      range.className = 'comp-range-slider';
      range.addEventListener('change', () => {
        if (comp.stateKey) {
          callbacks.onStateChange({
            ...liveState,
            [comp.stateKey]: Number(range.value),
          });
        }
      });
      sliderWrap.append(headRow, range);
      itemWrap.appendChild(sliderWrap);
    } else if (comp.type === 'toggle') {
      const isChecked = comp.stateKey ? Boolean(liveState[comp.stateKey]) : false;
      const row = targetDoc.createElement('div');
      row.className = 'ios-toggle-row';
      const labelSpan = targetDoc.createElement('span');
      labelSpan.className = 'ios-toggle-label';
      labelSpan.textContent = comp.label;

      const pill = targetDoc.createElement('button');
      pill.type = 'button';
      pill.className = `ios-switch ${isChecked ? 'is-on' : ''}`;
      pill.innerHTML = `<span class="ios-switch-knob"></span>`;
      pill.addEventListener('click', () => {
        if (comp.stateKey) {
          callbacks.onStateChange({
            ...liveState,
            [comp.stateKey]: !isChecked,
          });
        }
      });

      row.append(labelSpan, pill);
      itemWrap.appendChild(row);
    } else if (comp.type === 'status_banner') {
      const banner = targetDoc.createElement('div');
      banner.className = 'comp-status-banner';
      banner.textContent = comp.label;
      itemWrap.appendChild(banner);
    } else if (comp.type === 'button') {
      const btn = targetDoc.createElement('button');
      btn.type = 'button';
      btn.className = 'comp-button';
      btn.textContent = comp.label;

      let clickCount = 0;
      let escapedOnce = false;

      btn.addEventListener('click', () => {
        const effect = comp.behavior?.effect ?? 'none';

        if (effect === 'escape_on_hover' && !escapedOnce) {
          escapedOnce = true;
          const offsetX = (Math.random() > 0.5 ? 1 : -1) * 42;
          const offsetY = -10;
          btn.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
          callbacks.onToast('ボタンが逃げた！もう一度押して捕まえよう', 'info');
          return;
        }
        btn.style.transform = '';

        if (effect === 'require_3_clicks') {
          clickCount++;
          if (clickCount < 3) {
            btn.textContent = `${comp.label} あと${3 - clickCount}回`;
            callbacks.onToast(`あと ${3 - clickCount} 回押すとロック解除`, 'info');
            return;
          }
          clickCount = 0;
          btn.textContent = comp.label;
        }

        if (effect === 'tts_voice_alarm') {
          playAlarmBeep();
          speakTextWithTts(
            comp.behavior?.voiceText || '朝ですよ！起きてください！アラームを予約しました！',
            { pitch: 1.1, rate: 1.05 },
          );
        } else if (effect === 'play_alarm_sound') {
          playAlarmBeep();
        }

        if (effect === 'confirm_dialog') {
          openConfirmOverlay(comp, () => executeActions(comp.actions));
          return;
        }

        if (effect === 'math_quiz_gate') {
          openMathQuizOverlay(comp, () => executeActions(comp.actions));
          return;
        }

        if (comp.actions.length === 0) {
          callbacks.onToast('押しても反応がありません', 'warning');
          return;
        }

        executeActions(comp.actions);
      });

      itemWrap.appendChild(btn);
    } else {
      const txt = targetDoc.createElement('div');
      txt.className = 'comp-text';
      txt.textContent = comp.label;
      itemWrap.appendChild(txt);
    }

    body.appendChild(itemWrap);
  }

  phoneScreen.append(body, overlaySlot);
  mountRoot.appendChild(phoneScreen);
}
