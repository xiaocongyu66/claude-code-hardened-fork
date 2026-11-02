import { describe, expect, test } from 'bun:test'
import {
  INITIAL_STATE,
  type KeyParseState,
  type ParsedInput,
  type ParsedKey,
  type TerminalResponse,
  parseMultipleKeypresses,
} from '../parse-keypress.js'

// P0 characterization vectors, not a specification for the Rust replacement.
// Inputs are decoded JS strings; UTF-8 byte reassembly belongs to the host.
// null models App.flushIncomplete explicitly, without timers or parser mocks.
function key(
  sequence: string,
  name: string,
  fields: Partial<ParsedKey> = {},
): ParsedKey {
  return {
    kind: 'key',
    name,
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
    ...fields,
  }
}

function replay(chunks: readonly (string | null)[]) {
  let state: KeyParseState = { ...INITIAL_STATE }
  const events: ParsedInput[] = []
  const batches: ParsedInput[][] = []
  const states: Omit<KeyParseState, '_tokenizer'>[] = []
  for (const chunk of chunks) {
    const [batch, next] = parseMultipleKeypresses(state, chunk)
    state = next
    events.push(...batch)
    batches.push(batch)
    // The tokenizer is mutable: retain value snapshots, not state references.
    states.push({
      mode: state.mode,
      incomplete: state.incomplete,
      pasteBuffer: state.pasteBuffer,
    })
  }
  return { events, batches, states }
}

const normal: Omit<KeyParseState, '_tokenizer'> = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
}
const start = '\x1b[200~'
const end = '\x1b[201~'
const pasteContent =
  '中\t\r\n\x03\x1b[A\x1b[<0;12;7M\x1b[?1;2c\x1b]11;rgb:aa/bb/cc\x07'

// Explicit input/semantic-event pairs can be reused for later Rust comparison.
// No expected event is derived by running the parser on an unsplit input.
const vectors: { name: string; input: string; events: ParsedInput[] }[] = [
  { name: 'ordinary lowercase key', input: 'a', events: [key('a', 'a')] },
  {
    name: 'shifted letter',
    input: 'A',
    events: [key('A', 'a', { shift: true })],
  },
  { name: 'digit', input: '7', events: [key('7', 'number')] },
  {
    name: 'control key',
    input: '\x03',
    events: [key('\x03', 'c', { ctrl: true })],
  },
  {
    name: 'return has no raw text',
    input: '\r',
    events: [key('\r', 'return', { raw: undefined })],
  },
  {
    name: 'legacy control navigation',
    input: '\x1b[1;5D',
    events: [key('\x1b[1;5D', 'left', { ctrl: true })],
  },
  {
    name: 'CSI navigation retains code',
    input: '\x1b[1;2A',
    events: [key('\x1b[1;2A', 'up', { shift: true, code: '[A' })],
  },
  {
    name: 'SS3 function key',
    input: '\x1bOP',
    events: [key('\x1bOP', 'f1', { code: 'OP' })],
  },
  {
    name: 'kitty modifiers',
    input: '\x1b[97;16u',
    events: [
      key('\x1b[97;16u', 'a', {
        shift: true,
        meta: true,
        ctrl: true,
        super: true,
      }),
    ],
  },
  {
    name: 'modifyOtherKeys alt',
    input: '\x1b[27;3;97~',
    events: [key('\x1b[27;3;97~', 'a', { meta: true })],
  },
  {
    name: 'empty bracketed paste is an event',
    input: start + end,
    events: [key('', '', { isPasted: true })],
  },
  {
    name: 'paste preserves controls, mouse and response sequences literally',
    input: start + pasteContent + end,
    events: [key(pasteContent, '', { isPasted: true })],
  },
  {
    name: 'Unicode paste including surrogate pair and combining mark',
    input: start + '中😀e\u0301' + end,
    events: [key('中😀e\u0301', '', { isPasted: true })],
  },
  ...(
    [
      ['\x1b[?2026;1$y', { type: 'decrpm', mode: 2026, status: 1 }],
      ['\x1b[?1;2c', { type: 'da1', params: [1, 2] }],
      ['\x1b[>0;123;0c', { type: 'da2', params: [0, 123, 0] }],
      ['\x1b[?3u', { type: 'kittyKeyboard', flags: 3 }],
      ['\x1b[?12;34R', { type: 'cursorPosition', row: 12, col: 34 }],
      [
        '\x1b]11;rgb:aa/bb/cc\x07',
        { type: 'osc', code: 11, data: 'rgb:aa/bb/cc' },
      ],
      [
        '\x1b]11;rgb:aa/bb/cc\x1b\\',
        { type: 'osc', code: 11, data: 'rgb:aa/bb/cc' },
      ],
      ['\x1bP>|xterm(123)\x1b\\', { type: 'xtversion', name: 'xterm(123)' }],
    ] satisfies [string, TerminalResponse][]
  ).map(([sequence, response]) => ({
    name: `terminal response ${JSON.stringify(sequence)}`,
    input: sequence,
    events: [{ kind: 'response' as const, sequence, response }],
  })),
  ...[0, 32].map(button => ({
    name: `SGR button ${button}`,
    input: `\x1b[<${button};12;7M`,
    events: [
      {
        kind: 'mouse' as const,
        button,
        action: 'press' as const,
        col: 12,
        row: 7,
        sequence: `\x1b[<${button};12;7M`,
      },
    ],
  })),
  {
    name: 'SGR release',
    input: '\x1b[<0;12;7m',
    events: [
      {
        kind: 'mouse',
        button: 0,
        action: 'release',
        col: 12,
        row: 7,
        sequence: '\x1b[<0;12;7m',
      },
    ],
  },
  ...[64, 65, 80, 81].map(button => ({
    name: `SGR wheel ${button} stays a key`,
    input: `\x1b[<${button};12;7M`,
    events: [
      key(`\x1b[<${button};12;7M`, button % 2 ? 'wheeldown' : 'wheelup'),
    ],
  })),
]

describe('parseMultipleKeypresses deterministic replay', () => {
  for (const vector of vectors) {
    test(vector.name, () => {
      // Every UTF-16 split, plus one-code-unit chunks (including split emoji).
      const partitions = [
        [vector.input],
        vector.input.split(''),
        ...Array.from({ length: vector.input.length + 1 }, (_, split) => [
          vector.input.slice(0, split),
          vector.input.slice(split),
        ]),
      ]
      for (const chunks of partitions) {
        const result = replay([...chunks, null, null])
        expect(result.events).toStrictEqual(vector.events)
        expect(result.states.at(-1)).toStrictEqual(normal)
        expect(result.batches.slice(-2)).toStrictEqual([[], []])
      }
    })
  }

  test('escape waits through empty feeds, then explicit flush emits once', () => {
    const result = replay(['\x1b', '', null, null, 'a'])
    expect(result.batches).toStrictEqual([
      [],
      [],
      [key('\x1b', 'escape')],
      [],
      [key('a', 'a')],
    ])
    expect(result.states).toStrictEqual([
      { ...normal, incomplete: '\x1b' },
      { ...normal, incomplete: '\x1b' },
      normal,
      normal,
      normal,
    ])
  })

  test('CSI fragments remain buffered until completion', () => {
    const result = replay(['\x1b[', '1;', '2', 'A', null])
    expect(result.batches).toStrictEqual([
      [],
      [],
      [],
      [key('\x1b[1;2A', 'up', { shift: true, code: '[A' })],
      [],
    ])
    expect(result.states).toStrictEqual([
      { ...normal, incomplete: '\x1b[' },
      { ...normal, incomplete: '\x1b[1;' },
      { ...normal, incomplete: '\x1b[1;2' },
      normal,
      normal,
    ])
  })

  test('explicit flush finishes nonempty unterminated paste', () => {
    const result = replay([start, 'hello', '\x1b[', null, null, 'a'])
    expect(result.batches).toStrictEqual([
      [],
      [],
      [],
      [key('hello\x1b[', '', { isPasted: true })],
      [],
      [key('a', 'a')],
    ])
    expect(result.states[2]).toStrictEqual({
      mode: 'IN_PASTE',
      incomplete: '\x1b[',
      pasteBuffer: 'hello',
    })
    expect(result.states.slice(3)).toStrictEqual([normal, normal, normal])
  })

  test('mixed batch preserves order without leaking responses into keys', () => {
    const input = 'a\x1b[?1;2c\x1b[<0;12;7M\x1b[<64;12;7M' + start + end + 'z'
    const expected: ParsedInput[] = [
      key('a', 'a'),
      {
        kind: 'response',
        sequence: '\x1b[?1;2c',
        response: { type: 'da1', params: [1, 2] },
      },
      {
        kind: 'mouse',
        sequence: '\x1b[<0;12;7M',
        button: 0,
        action: 'press',
        col: 12,
        row: 7,
      },
      key('\x1b[<64;12;7M', 'wheelup'),
      key('', '', { isPasted: true }),
      key('z', 'z'),
    ]
    expect(replay([input]).events).toStrictEqual(expected)
    expect(replay(input.split('')).events).toStrictEqual(expected)
  })

  test('decoded Unicode text chunks preserve content without grapheme assembly', () => {
    // Ordinary text is emitted per chunk, not promised as one event per grapheme.
    // Split a combining sequence and a ZWJ sequence at valid scalar boundaries.
    const chunks = ['中', '😀', 'e', '\u0301', '👩', '\u200d', '💻']
    const expected = chunks.map(text => key(text, text === 'e' ? 'e' : ''))
    const result = replay([...chunks, null])
    expect(result.events).toStrictEqual(expected)
    expect(result.states).toStrictEqual(chunks.concat('').map(() => normal))
    expect(result.events.map(event => event.sequence).join('')).toBe(
      '中😀e\u0301👩\u200d💻',
    )
  })
})
