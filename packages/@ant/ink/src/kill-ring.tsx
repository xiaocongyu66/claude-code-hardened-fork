import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * KillRing —— 官方 ink 的输入剪贴板环（binary @152676333 区段，minified
 * 原文反混淆 1:1 还原）。
 *
 * 官方错误契约（原文）：useKillRing cannot be called outside of a
 * <KillRingProvider /> (mounted around every Ink root by src/ink.ts)
 *
 * 模块结构（原文实证）：
 *   Wvn  createKillRingStore —— { get state, dispatch }
 *   VJe  KillRingProvider    —— 外部 handle 注入优先，否则默认工厂
 *   __t  useKillRing         —— Context 必需
 *   pqt  killRingTop         —— ring[0] ?? ''
 *   fqt  yankPopResult       —— yanked && ring>1 → 环内下一项，否则 null
 *
 * 官方语义（reducer h 原文）：
 *   mode 是 discriminated union：'idle' | 'killing' | 'yanked'
 *   ring 上限 y=10（binary var y=10 实证）
 *   kill 连续（killing 态）合并到 ring[0]（prepend: text+head / append: head+text）
 *   yank 归位 index=0；yankPop 环进；interrupt 归 idle
 */

export type KillRingMode =
  | { type: 'idle' }
  | { type: 'killing' }
  | { type: 'yanked'; start: number; length: number; index: number };

export interface KillRingState {
  ring: string[];
  mode: KillRingMode;
}

export interface KillRingAction {
  type: 'kill' | 'yank' | 'yankPop' | 'updateYankLength' | 'interrupt';
  text?: string;
  direction?: 'prepend' | 'append';
  start?: number;
  length?: number;
}

export interface KillRingStore {
  readonly state: KillRingState;
  dispatch: (action: KillRingAction) => void;
}

/** 官方 y=10：ring 上限（binary var y=10 实证）。 */
const RING_LIMIT = 10;

const INITIAL: KillRingState = { ring: [], mode: { type: 'idle' } };

/** 官方 h：reducer——kill 合并 / yank 环状 yank 语义。 */
function killRingReducer(state: KillRingState, action: KillRingAction): KillRingState {
  switch (action.type) {
    case 'kill': {
      const text = action.text ?? '';
      if (text.length === 0) {
        return state.mode.type === 'idle' ? state : { ...state, mode: { type: 'idle' } };
      }
      const ring =
        state.mode.type === 'killing' && state.ring.length > 0
          ? [action.direction === 'prepend' ? text + state.ring[0] : state.ring[0] + text, ...state.ring.slice(1)]
          : [text, ...state.ring].slice(0, RING_LIMIT);
      return { ring, mode: { type: 'killing' } };
    }
    case 'yank':
      return {
        ...state,
        mode: {
          type: 'yanked',
          start: action.start ?? 0,
          length: action.length ?? 0,
          index: 0,
        },
      };
    case 'yankPop': {
      if (state.mode.type !== 'yanked' || state.ring.length <= 1) return state;
      const index = (state.mode.index + 1) % state.ring.length;
      return { ...state, mode: { ...state.mode, index } };
    }
    case 'updateYankLength': {
      if (state.mode.type !== 'yanked') return state;
      return { ...state, mode: { ...state.mode, length: action.length ?? 0 } };
    }
    case 'interrupt':
    default:
      if (state.mode.type === 'idle') return state;
      return { ...state, mode: { type: 'idle' } };
  }
}

/** 官方 Wvn：createKillRingStore（初始态 a={ring:[],mode:{type:'idle'}}）。 */
export function createKillRingStore(initialState: KillRingState = INITIAL): KillRingStore {
  let current = initialState;
  return {
    get state() {
      return current;
    },
    dispatch(action: KillRingAction) {
      current = killRingReducer(current, action);
    },
  };
}

/** 官方 pqt：killRingTop——环顶文本（pqt 原文：n.ring[0] ?? ''）。 */
export function killRingTop(state: KillRingState): string {
  return state.ring[0] ?? '';
}

/** 官方 fqt：yankPopResult——仅 yanked 且 ring>1 返回环内下一项（fqt 原文）。 */
export function yankPopResult(state: KillRingState): { text: string; start: number; length: number } | null {
  if (state.mode.type !== 'yanked' || state.ring.length <= 1) return null;
  const index = (state.mode.index + 1) % state.ring.length;
  const { start, length } = state.mode;
  return { text: state.ring[index] ?? '', start, length };
}

const KillRingContext = createContext<KillRingStore | undefined>(undefined);

/** 官方 VJe：KillRingProvider——外部 handle 注入优先，否则默认工厂。 */
export function KillRingProvider({ handle, children }: { handle?: KillRingStore; children: ReactNode }): ReactNode {
  const fallback = useMemo(() => createKillRingStore(), []);
  const store = handle ?? fallback;
  return <KillRingContext.Provider value={store}>{children}</KillRingContext.Provider>;
}

/** 官方 __t：useKillRing——Context 必需（错误契约原文）。 */
export function useKillRing(): KillRingStore {
  const store = useContext(KillRingContext);
  if (!store) {
    throw new ReferenceError(
      'useKillRing cannot be called outside of a <KillRingProvider /> (mounted around every Ink root by src/ink.ts)',
    );
  }
  return store;
}
